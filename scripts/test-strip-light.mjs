#!/usr/bin/env node
/**
 * Strip light builder (src/strip-light.js): the four techniques, asserted on
 * the BUILT objects -- light counts, world positions read back from the
 * scene graph after the strip is placed and turned, the tube's own world
 * bounding box as the reference for "along the length", and the sum of the
 * lights' actual intensities. Nothing here re-derives the builder's spacing
 * formula. No framework, no install: `node scripts/test-strip-light.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. A (baseline) is today's strip: one PointLight at the box's centre,
 *      today's intensity, reach and decay.
 *   2. B builds exactly N PointLights, spread evenly over the tube's length
 *      (first/last half a gap in from each end, equal gaps, symmetric), all
 *      set back BEHIND the mounting plane (so the surface the strip is stuck
 *      to gets no hotspot), and their intensities sum to A's.
 *   3. C is one RectAreaLight, as long as the tube, emitting along `facing`,
 *      with the same far-field power as A; no point lights.
 *   4. D has no light objects at all; its wash card sits `washDistance` out
 *      along `facing`, facing back at the strip.
 *   5. applyStripState: brightness scales the SUM (conserved at every N),
 *      off is intensity 0 without removing lights (a light-count change is a
 *      shader recompile), colour reaches every light and the tube.
 *   6. The diffuser glows uniformly ALONG its length (one-texel-tall map) and
 *      brightest on the side that faces out, for every facing.
 *   7. lightCounts()/uniformVectors() agree with what build() actually made.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const S = await imp('src/strip-light.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Build a strip and place it in a parent that is moved and turned, like a real mounting. */
function placed(params, yaw = 0.7) {
  const parent = new THREE.Group();
  parent.position.set(1.3, 2.1, -0.4);
  parent.rotation.y = yaw;
  const g = S.build(THREE, params);
  parent.add(g);
  parent.updateMatrixWorld(true);
  return { parent, g };
}
const lightsOf = g => { const out = []; g.traverse(o => { if (o.isLight) out.push(o); }); return out; };
const worldPos = o => o.getWorldPosition(new THREE.Vector3());
const tubeOf = g => { let t = null; g.traverse(o => { if (o.isMesh && o.userData.stripRole === 'tube') t = o; }); return t; };
/** The tube's world-space long axis: its two end-points, read from its own geometry. */
function tubeEnds(tube) {
  const bb = new THREE.Box3().setFromBufferAttribute(tube.geometry.attributes.position);
  const cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
  const a = new THREE.Vector3(bb.min.x, cy, cz).applyMatrix4(tube.matrixWorld);
  const b = new THREE.Vector3(bb.max.x, cy, cz).applyMatrix4(tube.matrixWorld);
  return { a, b, len: a.distanceTo(b), dir: b.clone().sub(a).normalize() };
}
/** Where a world point falls along the tube, 0 at one end, 1 at the other. */
const along = (ends, p) => p.clone().sub(ends.a).dot(ends.dir) / ends.len;
/** `facing` in world space for a placed strip. */
function facingWorld(g, facing) {
  const f = S.FACINGS[facing];
  return new THREE.Vector3(f[0], f[1], f[2]).transformDirection(g.matrixWorld);
}

// ---- 1. A: today's strip ------------------------------------------------------
{
  const { g } = placed({ technique: 'A', length: 120 });
  const ls = lightsOf(g);
  check('A builds exactly one light', ls.length === 1, ls.length);
  check('A\'s light is a PointLight', ls[0] && ls[0].isPointLight);
  const tube = tubeOf(g);
  check('A draws a box', tube && tube.geometry.type === 'BoxGeometry');
  const c = new THREE.Box3().setFromObject(tube).getCenter(new THREE.Vector3());
  check('A\'s light sits at the box\'s centre (world)', worldPos(ls[0]).distanceTo(c) < 1e-6, [worldPos(ls[0]), c]);
  check('A: today\'s intensity 0.3, reach 2.5 m, decay 2', near(ls[0].intensity, 0.3) && near(ls[0].distance, 2.5) && ls[0].decay === 2,
    [ls[0].intensity, ls[0].distance, ls[0].decay]);
  check('A: today\'s 85% opaque emissive box', tube.material.transparent && near(tube.material.opacity, 0.85) && near(tube.material.emissiveIntensity, 1.5));
}

// ---- 2. B: N lights along the line --------------------------------------------
for (const facing of Object.keys(S.FACINGS)) {
  for (const n of [1, 3, 6, 10]) {
    const tag = 'B facing ' + facing + ' N=' + n;
    const { g } = placed({ technique: 'B', length: 180, n, facing });
    const ls = lightsOf(g);
    check(tag + ': N lights', ls.length === n, ls.length);
    check(tag + ': all PointLights', ls.every(l => l.isPointLight));
    const sum = ls.reduce((s, l) => s + l.intensity, 0);
    check(tag + ': intensities sum to A\'s 0.3', near(sum, 0.3), sum);
    const ends = tubeEnds(tubeOf(g));
    check(tag + ': tube is the strip\'s full length', near(ends.len, 1.8, 1e-6), ends.len);
    const t = ls.map(l => along(ends, worldPos(l))).sort((a, b) => a - b);
    const gap = 1 / n;
    check(tag + ': first light half a gap in from one end', near(t[0], gap / 2, 1e-6), t);
    check(tag + ': last light half a gap in from the other end', near(t[n - 1], 1 - gap / 2, 1e-6), t);
    for (let i = 1; i < n; i++) check(tag + ': equal gaps (' + i + ')', near(t[i] - t[i - 1], gap, 1e-6), t);
    // Behind the mounting plane: the group origin is on it, facing is its normal.
    const o = worldPos(g), fw = facingWorld(g, facing);
    check(tag + ': every light behind the mounting plane (no hotspot on the surface it is stuck to)',
      ls.every(l => worldPos(l).sub(o).dot(fw) < -1e-4), ls.map(l => worldPos(l).sub(o).dot(fw)));
    // ...and on the strip's axis (not scattered sideways)
    const off = ls.map(l => { const p = worldPos(l).sub(ends.a); return p.sub(ends.dir.clone().multiplyScalar(p.dot(ends.dir))).length(); });
    check(tag + ': lights on the strip\'s line (within 3 cm)', off.every(d => d < 0.03), off);
  }
}
{
  const { g } = placed({ technique: 'B', n: 99 });
  check('B: N is capped at MAX_N', lightsOf(g).length === S.MAX_N, lightsOf(g).length);
}

// ---- 3. C: one area light --------------------------------------------------------
for (const facing of Object.keys(S.FACINGS)) {
  const tag = 'C facing ' + facing;
  const { g } = placed({ technique: 'C', length: 240, facing });
  const ls = lightsOf(g);
  check(tag + ': exactly one light', ls.length === 1, ls.length);
  const ra = ls[0];
  check(tag + ': it is a RectAreaLight', ra && ra.isRectAreaLight);
  const ends = tubeEnds(tubeOf(g));
  check(tag + ': as long as the tube', near(ra.width, ends.len, 1e-6), [ra.width, ends.len]);
  // A RectAreaLight emits along its local -Z; its width runs along local X.
  const q = ra.getWorldQuaternion(new THREE.Quaternion());
  const emit = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
  const wAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  check(tag + ': emits along facing', emit.dot(facingWorld(g, facing)) > 0.9999, emit);
  check(tag + ': its width lies along the strip', Math.abs(wAxis.dot(ends.dir)) > 0.9999, wAxis);
  check(tag + ': centred on the strip', near(along(ends, worldPos(ra)), 0.5, 1e-6));
  check(tag + ': in front of the tube\'s centre (on its outer face, not inside it)',
    worldPos(ra).sub(worldPos(tubeOf(g))).dot(facingWorld(g, facing)) > 0);
  check(tag + ': same flux onto the lit side as A (radiance x area = AREA_FLUX x 0.3)',
    near(ra.intensity * ra.width * ra.height, S.AREA_FLUX * 0.3, 1e-9), ra.intensity * ra.width * ra.height);
  check(tag + ': AREA_FLUX is the half-space flux match (2)', S.AREA_FLUX === 2);
}

// ---- 4. D: no lights ----------------------------------------------------------------
for (const facing of Object.keys(S.FACINGS)) {
  const tag = 'D facing ' + facing;
  const { g } = placed({ technique: 'D', washDistance: 50, facing });
  check(tag + ': no light objects at all', lightsOf(g).length === 0, lightsOf(g).map(l => l.type));
  let wash = null; g.traverse(o => { if (o.userData.stripRole === 'wash') wash = o; });
  check(tag + ': has a wash card', !!wash);
  if (wash) {
    const fw = facingWorld(g, facing);
    const d = worldPos(wash).sub(worldPos(g)).dot(fw);
    check(tag + ': wash ~50 cm out along facing', near(d, 0.5, 0.005), d);
    const nrm = new THREE.Vector3(0, 0, 1).applyQuaternion(wash.getWorldQuaternion(new THREE.Quaternion()));
    check(tag + ': wash faces back at the strip', nrm.dot(fw) < -0.9999, nrm);
    check(tag + ': wash is additive and unlit', wash.material.blending === THREE.AdditiveBlending && wash.material.isMeshBasicMaterial);
  }
}
for (const facing of ['down', 'up']) {
  const tag = 'D back wash facing ' + facing;
  const { g } = placed({ technique: 'D', washDistance: 50, backWash: 26, facing });
  let back = null; g.traverse(o => { if (o.userData.stripRole === 'wash-back') back = o; });
  check(tag + ': has a back-wall card', !!back);
  if (back) {
    const behind = new THREE.Vector3(0, 0, -1).transformDirection(g.matrixWorld);
    const rel = worldPos(back).sub(worldPos(g));
    check(tag + ': on the wall 26 cm behind the strip', near(rel.dot(behind), 0.26, 0.005), rel.dot(behind));
    const fw = facingWorld(g, facing), o = worldPos(g);
    const bp = back.geometry.attributes.position, ds = [];
    for (let i = 0; i < bp.count; i++) ds.push(new THREE.Vector3().fromBufferAttribute(bp, i).applyMatrix4(back.matrixWorld).sub(o).dot(fw));
    const ends = [Math.min(...ds), Math.max(...ds)];
    check(tag + ': spans from the strip plane to the lit surface', near(ends[0], 0, 1e-3) && near(ends[1], 0.5, 1e-3), ends);
    // brightest texel row sits next to the strip: v=1 is the plane's +Y, which must point back at the mounting plane
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(back.getWorldQuaternion(new THREE.Quaternion()));
    check(tag + ': bright edge by the strip', up.dot(fw) < -0.9999, up);
    const img = back.material.map.image, W = img.width, H = img.height;
    const col = i => img.data[(i * W + W / 2) * 4 + 3];
    check(tag + ': texture brightest at v=1 (top row), dark at v=0', col(H - 1) > 200 && col(0) < 20, [col(H - 1), col(0)]);
  }
}
for (const facing of ['front', 'back']) {
  const { g } = placed({ technique: 'D', washDistance: 9, backWash: 20, facing });
  let back = null; g.traverse(o => { if (o.userData.stripRole === 'wash-back') back = o; });
  check('D back wash is only for down/up strips (' + facing + ')', back === null);
}
{
  const { g } = placed({ technique: 'D', washDistance: 40, washSpread: 20, length: 100 });
  let wash = null; g.traverse(o => { if (o.userData.stripRole === 'wash') wash = o; });
  const ends = tubeEnds(tubeOf(g));
  const pos = wash.geometry.attributes.position, ts = [];
  for (let i = 0; i < pos.count; i++) ts.push(along(ends, new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(wash.matrixWorld)));
  const span = [Math.min(...ts), Math.max(...ts)];
  check('D wash fades past the ends over END_FADE x spread, not the full spread',
    near(span[0], -S.END_FADE * 0.2, 1e-3) && near(span[1], 1 + S.END_FADE * 0.2, 1e-3), span);
}
{
  const { g } = placed({ technique: 'D' });
  let wash = null; g.traverse(o => { if (o.userData.stripRole === 'wash') wash = o; });
  check('D with washDistance 0: no wash card', wash === null);
}

// ---- 5. state ------------------------------------------------------------------------
for (const tech of ['A', 'B', 'C']) {
  for (const n of [1, 6, 10]) {
    const { g } = placed({ technique: tech, n, length: 150 });
    const before = lightsOf(g).length;
    S.applyStripState(g, { on: true, bri: 40, color: '#3366ff' });
    const ls = lightsOf(g);
    const power = l => (l.isRectAreaLight ? l.intensity * l.width * l.height / S.AREA_FLUX : l.intensity);
    const sum = ls.reduce((s, l) => s + power(l), 0);
    check(tech + ' N=' + n + ': bri 40 -> total 0.12', near(sum, 0.12, 1e-9), sum);
    check(tech + ' N=' + n + ': colour reaches every light', ls.every(l => l.color.getHexString() === '3366ff'));
    check(tech + ' N=' + n + ': colour reaches the tube', tubeOf(g).material.emissive.getHexString() === '3366ff');
    S.applyStripState(g, { on: false, bri: 40 });
    check(tech + ' N=' + n + ': off -> every light at 0', lightsOf(g).every(l => l.intensity === 0));
    check(tech + ' N=' + n + ': off keeps the light count (no recompile)', lightsOf(g).length === before && lightsOf(g).every(l => l.visible));
    check(tech + ' N=' + n + ': off -> tube dark', tubeOf(g).material.emissiveIntensity === 0);
  }
}
{
  const { g } = placed({ technique: 'D', washDistance: 40 });
  let wash = null; g.traverse(o => { if (o.userData.stripRole === 'wash') wash = o; });
  S.applyStripState(g, { on: true, bri: 100, color: '#ffffff' });
  const full = wash.material.color.r;
  S.applyStripState(g, { on: true, bri: 50, color: '#ffffff' });
  check('D: the wash dims with brightness', near(wash.material.color.r, full / 2, 1e-9), [full, wash.material.color.r]);
  S.applyStripState(g, { on: false });
  check('D: off hides the wash', wash.visible === false);
}
check('applyStripState on a non-strip returns false', S.applyStripState(new THREE.Group(), { on: true }) === false);

// ---- 6. the diffuser -------------------------------------------------------------------
for (const tech of ['B', 'C', 'D']) {
  for (const facing of Object.keys(S.FACINGS)) {
    const tag = tech + ' diffuser facing ' + facing;
    const { g } = placed({ technique: tech, facing, length: 90 });
    const tube = tubeOf(g);
    const map = tube.material.emissiveMap;
    check(tag + ': one tube mesh', !!tube && tube.geometry.type === 'CylinderGeometry');
    check(tag + ': glow map is one texel tall (cannot vary along the length -> no dots)', map && map.image.height === 1, map && map.image.height);
    // The brightest texel's u -> the side vertices with that u -> their world normal.
    const W = map.image.width, data = map.image.data;
    let best = 0; for (let i = 1; i < W; i++) if (data[i * 4] > data[best * 4]) best = i;
    const uBest = (best + 0.5) / W;
    const uv = tube.geometry.attributes.uv, nr = tube.geometry.attributes.normal;
    let bestV = -1, bestD = 1;
    // side vertices only: normals perpendicular to the tube's axis
    for (let i = 0; i < uv.count; i++) {
      const nx = nr.getX(i);
      if (Math.abs(nx) > 1e-3) continue;
      const d = Math.min(Math.abs(uv.getX(i) - uBest), 1 - Math.abs(uv.getX(i) - uBest));
      if (d < bestD) { bestD = d; bestV = i; }
    }
    const nW = new THREE.Vector3(nr.getX(bestV), nr.getY(bestV), nr.getZ(bestV)).transformDirection(tube.matrixWorld);
    check(tag + ': brightest side of the tube faces out', nW.dot(facingWorld(g, facing)) > 0.95, nW.dot(facingWorld(g, facing)));
    const minT = Math.min(...Array.from({ length: W }, (_, i) => data[i * 4]));
    check(tag + ': the flanks stay milky (never below 40% of peak)', minT >= 0.4 * data[best * 4], [minT, data[best * 4]]);
  }
}

// ---- 7. counts agree with the build -----------------------------------------------------
for (const tech of S.TECHNIQUES) {
  for (const n of [1, 3, 6, 10]) {
    const params = { technique: tech, n };
    const ls = lightsOf(S.build(THREE, params));
    const c = S.lightCounts(params);
    check('lightCounts ' + tech + ' N=' + n + ' matches build', c.point === ls.filter(l => l.isPointLight).length &&
      c.rectArea === ls.filter(l => l.isRectAreaLight).length, [c, ls.map(l => l.type)]);
    const vec = ls.reduce((s, l) => s + (l.isPointLight ? S.UNIFORM_VECTORS.point : l.isRectAreaLight ? S.UNIFORM_VECTORS.rectArea : 0), 0);
    check('uniformVectors ' + tech + ' N=' + n + ' matches build', S.uniformVectors(params) === vec, [S.uniformVectors(params), vec]);
  }
}

// ---- 8. bad input ---------------------------------------------------------------------------
{
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  const g = S.build(THREE, { technique: 'Z', facing: 'sideways' });
  console.warn = warn;
  check('unknown technique/facing fall back (B, down) with a warning', g.userData.stripLight.technique === 'B' &&
    g.userData.stripLight.facing === 'down' && warned === 2, [g.userData.stripLight.technique, warned]);
}
check('kelvinToHex matches the house ramp at 2700 K', S.kelvinToHex(2700) === 0xffd7a0, S.kelvinToHex(2700).toString(16));
check('kelvinToHex matches the house ramp at 6500 K', S.kelvinToHex(6500) === 0xe1f5fa, S.kelvinToHex(6500).toString(16));

console.log((failures ? 'FAILED' : 'OK') + ' strip-light: ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
