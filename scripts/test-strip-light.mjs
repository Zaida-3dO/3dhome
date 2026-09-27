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

/** A D card's lightMap as the GPU receives it: half floats decoded, red channel, row-major. */
function lightMapOf(card) {
  const img = card.material.lightMap.image, W = img.width, H = img.height;
  const v = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) v[k] = THREE.DataUtils.fromHalfFloat(img.data[k * 4]);
  return { W, H, at: (i, j) => v[j * W + i], max: v.reduce((m, x) => Math.max(m, x), 0) };
}

/** A mesh's vertices in the STRIP's own frame (world, then undone by the strip's world matrix). */
function localBox(g, mesh) {
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
  const pos = mesh.geometry.attributes.position, b = new THREE.Box3();
  for (let i = 0; i < pos.count; i++) b.expandByPoint(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv));
  return b;
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
  const lb = localBox(g, tube);
  const ls2 = lb.getSize(new THREE.Vector3());
  check('A: today\'s default 2.5 x 2.5 cm cross-section (not the tube diameter)', near(ls2.y, 0.025, 1e-6) && near(ls2.z, 0.025, 1e-6), [ls2.y, ls2.z]);
  check('A: box back face on the mounting point (down: top at y=0)', near(lb.max.y, 0, 1e-6), lb.max.y);
}
{
  const { g } = placed({ technique: 'A', boxSize: [1.2, 3.0], facing: 'back' });
  const lb = localBox(g, tubeOf(g));
  const ls2 = lb.getSize(new THREE.Vector3());
  check('A: boxSize [h, d] is honoured', near(ls2.y, 0.012, 1e-6) && near(ls2.z, 0.03, 1e-6), [ls2.y, ls2.z]);
  check('A facing back: box back face on the mounting point (z max 0)', near(lb.max.z, 0, 1e-6), lb.max.z);
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
  check('B: N is capped at 24 lights per strip', lightsOf(g).length === 24, lightsOf(g).length);
  check('B: MAX_N is 24 (uniform cost of one capped strip: 96 vectors)', S.MAX_N === 24 && S.uniformVectors({ technique: 'B', n: 99 }) === 96);
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
    // v=1 (texture top row) is the plane's +Y, which must point back at the strip's own plane
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(back.getWorldQuaternion(new THREE.Quaternion()));
    check(tag + ': texture top row lies in the strip plane', up.dot(fw) < -0.9999, up);
    const lm = lightMapOf(back), W = lm.W, H = lm.H;
    const col = j => lm.at(W / 2, j);
    let best = 0; for (let j = 1; j < H; j++) if (col(j) > col(best)) best = j;
    check(tag + ': brightest band in the half nearer the strip (a wall is lit most just below it)', best >= H / 2, [best, H]);
    check(tag + ': dark at the far end (by the lit surface)', col(0) < 0.01 * lm.max, [col(0), lm.max]);
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
  check('D wash reaches washSpread past each end', near(span[0], -0.2, 1e-3) && near(span[1], 1.2, 1e-3), span);
}
{
  // washEnds / washBack: the lit-surface card can stop short of a worktop's ends
  // and of the wall behind, independently of how far it reaches in front.
  const { g } = placed({ technique: 'D', washDistance: 50, washSpread: 34, washBack: 26, washEnds: 5, length: 170, facing: 'down' });
  let wash = null; g.traverse(o => { if (o.userData.stripRole === 'wash') wash = o; });
  const lb = localBox(g, wash);
  check('D washEnds: card reaches 5 cm past each end', near(lb.min.x, -0.90, 1e-6) && near(lb.max.x, 0.90, 1e-6), [lb.min.x, lb.max.x]);
  check('D washBack/washSpread: card spans 26 cm behind to 34 cm in front', near(lb.min.z, -0.26, 1e-6) && near(lb.max.z, 0.34, 1e-6), [lb.min.z, lb.max.z]);
  // and the texture's bright line sits over the strip (z = 0), not at the card's middle
  const lm = lightMapOf(wash);
  let jm = 0; for (let j = 0; j < lm.H; j++) if (lm.at(lm.W / 2, j) > lm.at(lm.W / 2, jm)) jm = j;
  const uv = wash.geometry.attributes.uv, pos = wash.geometry.attributes.position;
  // row jm -> v -> the card's world point -> strip-local z
  const v = jm / (lm.H - 1);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let v0 = null, v1 = null;
  for (let i = 0; i < uv.count; i++) { if (uv.getY(i) === 0) v0 = i; if (uv.getY(i) === 1) v1 = i; }
  a.fromBufferAttribute(pos, v0); b.fromBufferAttribute(pos, v1);
  const pt = a.clone().lerp(b, v).applyMatrix4(wash.matrixWorld).applyMatrix4(new THREE.Matrix4().copy(g.matrixWorld).invert());
  check('D asymmetric card: brightest row lies under the strip', Math.abs(pt.z) < 0.012, pt.z);
  for (const facing of ['up']) {
    const { g: gu } = placed({ technique: 'D', washDistance: 17, washSpread: 30, washBack: 14, facing, length: 100 });
    let wu = null; gu.traverse(o => { if (o.userData.stripRole === 'wash') wu = o; });
    const lbu = localBox(gu, wu);
    check('D washBack facing up: 14 cm behind, 30 cm in front', near(lbu.min.z, -0.14, 1e-6) && near(lbu.max.z, 0.30, 1e-6), [lbu.min.z, lbu.max.z]);
  }
}

// ---- 4b. D cards: soft everywhere, physically scaled, albedo-aware -----------------
/** Every card's alpha along ALL FOUR borders is ~0, and it falls smoothly from its peak. */
for (const facing of ['down', 'up', 'back']) {
  const { g } = placed({ technique: 'D', washDistance: facing === 'back' ? 8 : 50, backWash: 26, facing, length: 120 });
  const cards = []; g.traverse(o => { if (o.userData.stripRole && o.userData.stripRole.indexOf('wash') === 0) cards.push(o); });
  check('D facing ' + facing + ': cards built', cards.length === (facing === 'back' ? 1 : 2), cards.length);
  for (const c of cards) {
    const tag = 'D facing ' + facing + ' ' + c.userData.stripRole;
    const lm = lightMapOf(c), W = lm.W, H = lm.H, a = lm.at, peak = lm.max, tol = peak * 0.004;
    let border = 0;
    for (let i = 0; i < W; i++) { border = Math.max(border, a(i, 0), a(i, H - 1)); }
    for (let j = 0; j < H; j++) { border = Math.max(border, a(0, j), a(W - 1, j)); }
    check(tag + ': no hard edge -- every border texel near 0 (< 2.5% of peak)', border <= 0.025 * peak, [border, peak]);
    check(tag + ': a real peak inside', peak > 0);
    // along the length: from the middle column outward, never rises, and no step > 12% of peak between texels
    let jm = 0; for (let j = 0; j < H; j++) if (a(W / 2, j) > a(W / 2, jm)) jm = j;
    let mono = true, maxStep = 0;
    for (let i = W / 2; i < W - 1; i++) {
      if (a(i + 1, jm) > a(i, jm) + tol) mono = false;
      maxStep = Math.max(maxStep, Math.abs(a(i + 1, jm) - a(i, jm)));
    }
    check(tag + ': falls smoothly past the end (monotone, no step)', mono && maxStep <= 0.12 * peak, [mono, maxStep / peak]);
    // across: from the peak row toward row 0, the same
    let mono2 = true, maxStep2 = 0;
    for (let j = jm; j > 0; j--) {
      if (a(W / 2, j - 1) > a(W / 2, j) + tol) mono2 = false;
      maxStep2 = Math.max(maxStep2, Math.abs(a(W / 2, j - 1) - a(W / 2, j)));
    }
    check(tag + ': falls smoothly across (monotone, no step)', mono2 && maxStep2 <= 0.12 * peak, [mono2, maxStep2 / peak]);
  }
}
{
  // Brightness is physical: the card adds albedo/pi x the irradiance of a Lambertian
  // line with the same half-space flux as B/C (radiant intensity 2I/L per metre).
  // Checked against a NUMERIC integral here (Simpson), not the builder's closed form.
  const L = 1.0, h = 0.5, I = 0.3;
  const { g } = placed({ technique: 'D', length: 100, washDistance: 50, washSpread: 40, washAlbedo: '#ffffff', color: '#ffffff' });
  let wash = null; g.traverse(o => { if (o.userData.stripRole === 'wash') wash = o; });
  const n = 2000; let sum = 0;
  for (let i = 0; i <= n; i++) {
    const sPos = -L / 2 + L * i / n, w = i === 0 || i === n ? 1 : (i % 2 ? 4 : 2);
    sum += w * (h * h) / Math.pow(sPos * sPos + h * h, 2);
  }
  const E0 = (2 * I / L) * sum * (L / n) / 3;          // irradiance under the centre
  const expect = E0 / Math.PI;                           // x albedo 1 / pi
  // What three's basic shader adds: colour x lightMap texel x lightMapIntensity / pi.
  const lm = lightMapOf(wash);
  const centre = (lm.at(lm.W / 2 - 1, lm.H / 2) + lm.at(lm.W / 2, lm.H / 2) + lm.at(lm.W / 2 - 1, lm.H / 2 - 1) + lm.at(lm.W / 2, lm.H / 2 - 1)) / 4;
  const got = wash.material.color.r * centre * wash.material.lightMapIntensity / Math.PI;
  check('D: the card adds albedo/pi x the line-source irradiance under the strip (numeric check)',
    Math.abs(got - expect) / expect < 0.03, [got, expect]);
  // the albedo multiplies it: a dark worktop glows dimly
  const { g: g2 } = placed({ technique: 'D', length: 100, washDistance: 50, washSpread: 40, washAlbedo: '#404040', color: '#ffffff' });
  let w2 = null; g2.traverse(o => { if (o.userData.stripRole === 'wash') w2 = o; });
  const lin = new THREE.Color('#404040').r;
  check('D: card brightness scales with the surface albedo', near(w2.material.color.r, wash.material.color.r * lin, 1e-9), [w2.material.color.r, wash.material.color.r * lin]);
  // a surface twice as far gets less (not a fixed decal strength)
  const { g: g3 } = placed({ technique: 'D', length: 100, washDistance: 100, washSpread: 40, color: '#ffffff' });
  let w3 = null; g3.traverse(o => { if (o.userData.stripRole === 'wash') w3 = o; });
  const peakOut = w => w.material.color.r * lightMapOf(w).max * w.material.lightMapIntensity;
  check('D: a surface further away gets a dimmer peak', peakOut(w3) < 0.6 * peakOut(wash), [peakOut(w3), peakOut(wash)]);
}
// The shared colour survives on every card, however short the throw: the
// material colour is EXACTLY hue x albedo (so <= 1) and the magnitude rides in
// the lightMap. (Round 2 put the magnitude in the colour: 16.2 on the console
// card, which tone-mapped to white.)
for (const h of [3, 6, 10, 50, 260]) {
  for (const col of ['#ffd7a0', '#3080ff', '#ff3300']) {
    const { g } = placed({ technique: 'D', length: 60, washDistance: h, backWash: 12, washAlbedo: '#e9e5dc', backAlbedo: '#8e8c88', color: col });
    S.applyStripState(g, { on: true, bri: 100, color: col });
    const cards = []; g.traverse(o => { if (o.userData.stripRole && o.userData.stripRole.indexOf('wash') === 0) cards.push(o); });
    for (const c of cards) {
      const m = c.material.color, want = new THREE.Color(col).multiply(c.userData.albedo);
      check('D h=' + h + ' ' + col + ' ' + c.userData.stripRole + ': colour channels <= 1', Math.max(m.r, m.g, m.b) <= 1, [m.r, m.g, m.b]);
      check('D h=' + h + ' ' + col + ' ' + c.userData.stripRole + ': colour is exactly hue x albedo',
        near(m.r, want.r, 1e-9) && near(m.g, want.g, 1e-9) && near(m.b, want.b, 1e-9), [m.getHexString(), want.getHexString()]);
      check('D h=' + h + ' ' + col + ' ' + c.userData.stripRole + ': magnitude in the lightMap', c.material.lightMap && c.material.lightMap.type === THREE.HalfFloatType && c.material.lightMapIntensity > 0);
    }
  }
}
{
  // washSpread 0 = auto: AUTO_SPREAD x distance, clamped
  const { g } = placed({ technique: 'D', washDistance: 10, length: 50 });
  check('D: washSpread auto = 2.5 x distance', near(g.userData.stripLight.washSpread, 25, 1e-9), g.userData.stripLight.washSpread);
  const { g: g2 } = placed({ technique: 'D', washDistance: 200, length: 50 });
  check('D: auto spread clamped to 80 cm', near(g2.userData.stripLight.washSpread, 80, 1e-9), g2.userData.stripLight.washSpread);
}

// ---- 4c. aim: SpotLights along facing ---------------------------------------------
for (const tech of ['A', 'B']) {
  for (const facing of ['up', 'down']) {
    const tag = tech + ' aimed facing ' + facing;
    const { g } = placed({ technique: tech, n: 4, aim: true, facing });
    const ls = lightsOf(g);
    check(tag + ': all SpotLights', ls.length === (tech === 'A' ? 1 : 4) && ls.every(l => l.isSpotLight), ls.map(l => l.type));
    check(tag + ': unshadowed', ls.every(l => !l.castShadow));
    const fw = facingWorld(g, facing);
    const dirs = ls.map(l => l.target.getWorldPosition(new THREE.Vector3()).sub(worldPos(l)).normalize());
    check(tag + ': each aimed along facing', dirs.every(d => d.dot(fw) > 0.9999), dirs);
    check(tag + ': cone stops short of the mounting plane (angle < 90 deg)', ls.every(l => l.angle < Math.PI / 2 - 0.05), ls.map(l => l.angle));
    // Flux, integrated HERE by a midpoint rule over three's own cone falloff
    // (smoothstep(cos angle, cos(angle*(1-penumbra)), cos t)), must equal the
    // unaimed strip's half-space flux 2*pi*0.3.
    const fluxOf = l => {
      const c0 = Math.cos(l.angle), c1 = Math.cos(l.angle * (1 - l.penumbra)), n = 4000; let acc = 0;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) * (Math.PI / 2) / n, x = Math.min(1, Math.max(0, (Math.cos(t) - c0) / (c1 - c0)));
        acc += x * x * (3 - 2 * x) * Math.sin(t) * (Math.PI / 2) / n;
      }
      return 2 * Math.PI * l.intensity * acc;
    };
    const flux = ls.reduce((s, l) => s + fluxOf(l), 0);
    check(tag + ': aimed flux equals the unaimed 2*pi*0.3 (within 0.5%)', Math.abs(flux - 2 * Math.PI * 0.3) / (2 * Math.PI * 0.3) < 0.005, [flux, 2 * Math.PI * 0.3]);
    check(tag + ': cone is not the round-2 80/0.5 one (which sent 53%)', Math.abs(S.spotFluxFraction(80 * Math.PI / 180, 0.5) - 0.530) < 0.002 && S.AIM_FLUX_FRACTION > 0.7, S.AIM_FLUX_FRACTION);
    const c = S.lightCounts({ technique: tech, n: 4, aim: true });
    check(tag + ': lightCounts reports spots', c.spot === ls.length && c.point === 0, c);
    check(tag + ': uniformVectors counts 7 per spot', S.uniformVectors({ technique: tech, n: 4, aim: true }) === 7 * ls.length);
  }
}
{
  const { g } = placed({ technique: 'C', aim: true, facing: 'up' });
  check('C ignores aim (already one-sided)', lightsOf(g).length === 1 && lightsOf(g)[0].isRectAreaLight);
}

// ---- 4d. dispose ---------------------------------------------------------------------
for (const tech of S.TECHNIQUES) {
  const g = S.build(THREE, { technique: tech, n: 3, washDistance: 40, backWash: 20 });
  const owned = new Set();
  g.traverse(o => {
    if (o.geometry) owned.add(o.geometry);
    if (o.material) { owned.add(o.material); for (const k of ['map', 'emissiveMap', 'lightMap']) if (o.material[k]) owned.add(o.material[k]); }
  });
  const called = new Set();
  for (const r of owned) { const orig = r.dispose.bind(r); r.dispose = () => { called.add(r); orig(); }; }
  S.dispose(g);
  const missed = [...owned].filter(r => !called.has(r)).map(r => r.type || r.constructor.name);
  check(tech + ': dispose() frees every geometry, material and texture the strip owns', missed.length === 0 && owned.size > 0, missed);
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
  const full = wash.material.lightMapIntensity;
  S.applyStripState(g, { on: true, bri: 50, color: '#ffffff' });
  check('D: the wash dims with brightness', near(wash.material.lightMapIntensity, full / 2, 1e-9), [full, wash.material.lightMapIntensity]);
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

// ---- 9. the playground: no strip buried in furniture ------------------------------
// specs/strip-light-playground.js is the room StripLightSpec draws. Every
// mounting's tube + channel (and A's box) must sit ON a surface, never INSIDE
// a piece of furniture or a wall: a strip inside the TV drew its dots on the
// screen. Touching (the surface it is stuck to) is allowed; overlapping by
// more than OVERLAP_TOL in all three axes is not. World AABBs of every room
// mesh, built by the real furniture builders.
{
  const PG = await imp('specs/strip-light-playground.js');
  const F = {
    kitchen: await imp('src/furniture/kitchen.js'), desk: await imp('src/furniture/standing-desk.js'),
    cabinet: await imp('src/furniture/cabinet.js'), sofa: await imp('src/furniture/sofa.js'), plant: await imp('src/furniture/plant.js')
  };
  const room = new THREE.Group();
  PG.buildRoom(THREE, room, F);
  room.updateMatrixWorld(true);
  const solids = [];
  room.traverse(o => { if (o.isMesh && o.name !== 'window-glass') solids.push({ name: o.name || o.parent.name, box: new THREE.Box3().setFromObject(o) }); });
  check('playground: room built with furniture', solids.length > 40, solids.length);
  const OVERLAP_TOL = 0.001;
  const overlap = (a, b) => Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) > OVERLAP_TOL &&
    Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y) > OVERLAP_TOL &&
    Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) > OVERLAP_TOL;
  const slots = PG.stripSlots();
  check('playground: 8 furniture mountings + 32 stress slots', slots.length === 40, slots.length);
  for (const tech of ['A', 'B']) {
    for (const slot of slots) {
      const g = S.build(THREE, PG.slotParams(slot, tech, 3, 1.6));
      g.position.set(slot.pos[0], slot.pos[1], slot.pos[2]); g.rotation.y = slot.rotY;
      g.updateMatrixWorld(true);
      const parts = [];
      g.traverse(o => { if (o.isMesh && (o.userData.stripRole === 'tube' || o.userData.stripRole === 'channel')) parts.push(new THREE.Box3().setFromObject(o)); });
      const hits = [];
      for (const pb of parts) for (const sb of solids) if (overlap(pb, sb.box)) hits.push(sb.name);
      check('playground ' + tech + ' "' + slot.name + '" @' + slot.pos.map(v => v.toFixed(2)).join(',') + ': not inside any furniture/wall',
        hits.length === 0, [...new Set(hits)]);
      // ...and it faces open space: a point 1 cm out along facing from the tube is inside nothing
      const fw = new THREE.Vector3(...S.FACINGS[slot.facing]).transformDirection(g.matrixWorld);
      const probe = g.getWorldPosition(new THREE.Vector3()).addScaledVector(fw, 0.03);
      const inside = solids.filter(sb => sb.box.containsPoint(probe)).map(sb => sb.name);
      check('playground ' + tech + ' "' + slot.name + '": faces open space', inside.length === 0, inside);
    }
  }
  // Every LIT part of every D card lies ON a real surface: from each texel
  // carrying more than 2% of the card's peak, a ray back along the strip's
  // facing must hit a room mesh within 1.5 cm (cards sit 3 mm proud). A card
  // hanging in the air (round 2's console card, 1.3 cm above nothing and 8 cm
  // past the console's front) fails.
  const meshes = []; room.traverse(o => { if (o.isMesh && o.name !== 'window-glass') meshes.push(o); });
  const rc = new THREE.Raycaster();
  function cardMisses(g, fw) {
    const miss = [];
    g.traverse(c => {
      if (!c.userData.stripRole || c.userData.stripRole.indexOf('wash') !== 0) return;
      const lm = lightMapOf(c), prm = c.geometry.parameters;
      for (let j = 0; j < lm.H; j += 3) for (let i = 0; i < lm.W; i += 4) {
        if (lm.at(i, j) <= 0.02 * lm.max) continue;
        const local = new THREE.Vector3((i / (lm.W - 1) - 0.5) * prm.width, (j / (lm.H - 1) - 0.5) * prm.height, 0);
        const pt = local.applyMatrix4(c.matrixWorld);
        // the surface is on the far side of the card from the strip
        const nrm = new THREE.Vector3(0, 0, 1).transformDirection(c.matrixWorld);
        const toStrip = g.getWorldPosition(new THREE.Vector3()).sub(pt);
        const toSurface = nrm.dot(toStrip) > 0 ? nrm.clone().negate() : nrm.clone();
        rc.set(pt.clone().addScaledVector(toSurface, -0.01), toSurface);
        rc.far = 0.025;
        const hit = rc.intersectObjects(meshes, false)[0];
        if (!hit) miss.push(c.userData.stripRole + '@' + pt.toArray().map(v => v.toFixed(3)).join(','));
      }
    });
    return miss;
  }
  for (const slot of slots) {
    const g = S.build(THREE, PG.slotParams(slot, 'D', 1, 1.6));
    g.position.set(slot.pos[0], slot.pos[1], slot.pos[2]); g.rotation.y = slot.rotY;
    g.updateMatrixWorld(true);
    const miss = cardMisses(g);
    check('playground D "' + slot.name + '" @' + slot.pos.map(v => v.toFixed(2)).join(',') + ': every lit part of every card lies on a surface',
      miss.length === 0, miss.slice(0, 4));
  }
  {
    // The round-2 console card: wash 10, spread 12, at the bay's front -- must be caught.
    const g = S.build(THREE, { technique: 'D', length: 10, facing: 'down', washDistance: 10, washSpread: 12, washAlbedo: '#ffffff' });
    g.position.set(3.0 - 0.36, 0.322, 0); g.rotation.y = -Math.PI / 2; g.updateMatrixWorld(true);
    check('playground: the surface check catches the round-2 floating console card', cardMisses(g).length > 0);
  }

  // The mutation this guards: the pre-fix TV mounting (x 2.91, the TV's front face) IS caught.
  const bad = S.build(THREE, { technique: 'B', length: 120, facing: 'back' });
  bad.position.set(2.91, 1.52, 0); bad.rotation.y = -Math.PI / 2; bad.updateMatrixWorld(true);
  let caught = false;
  bad.traverse(o => { if (o.isMesh && o.userData.stripRole === 'tube') { const b = new THREE.Box3().setFromObject(o); caught = solids.some(sb => overlap(b, sb.box)); } });
  check('playground: the check catches a strip buried in the TV (round-1 mounting)', caught);
}

console.log((failures ? 'FAILED' : 'OK') + ' strip-light: ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
