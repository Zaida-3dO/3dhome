#!/usr/bin/env node
/**
 * Plant builder (src/furniture/plant.js): every kind and every preset, the
 * behaviour a screenshot cannot pin. No framework, no install -
 * `node scripts/test-plant-builder.mjs`.
 *
 * WHAT THIS GUARDS (each check names, in a comment, a one-line source change
 * that would make it fail)
 *
 *   0. Module shape: TYPE, frozen DEFAULTS (the corn plant's envelope),
 *      KINDS / POT_STYLES / WALL_CONTENTS, toFurnitureJSON.
 *   1. Every preset at FULL detail lands exactly on its own envelope:
 *      width/depth/height within 0.5 cm, x centred, bottom at y = 0, back
 *      at z = 0. At LOW detail it reuses the full build's fit (nothing moves
 *      when the detail switches) and lies INSIDE the envelope; the presets
 *      whose low layout is not a subset of the full one fit themselves
 *      exactly instead (LOW_OWN below).
 *   2. Triangle caps (perf audit): corn-plant 800 / 300, wall-planter
 *      400 / 150, every other kind 600 / 200; 'low' strictly cheaper, and
 *      <= 0.6 x 'full' whenever full > 300.
 *   3. Finishes: every mesh tagged from the palette; glass / emissive kept;
 *      no THREE lights anywhere.
 *   4. Leaves are TWO-SIDED by duplicated, reversed faces (not a DoubleSide
 *      material, which would cost a merge bucket per room). leafGeometry's
 *      triangle counts (folded and flat), its front-face winding, and that a
 *      leaf is widest past its base.
 *   5. Seed determinism: same seed -> identical layout; different seed ->
 *      different layout -- for every kind.
 *   6. Corn plant (scout d359c08e, follow-up 743c2deb): leaves measured ON
 *      THE BUILT OUTPUT, after the envelope fit -- the top tuft's leaves
 *      average 40-50 cm long, and leaves average 5-7 cm wide; three canes
 *      of clearly different heights, at the SAME heights at both details;
 *      most leaves droop with their tips BELOW their base.
 *   7. Wall planter: a FLAT BACK on the wall (a back face whose three
 *      corners, including the bottom point, lie on z = 0), ONE front apex
 *      at z = depth, the ceramic's open top at half the height, the wire's
 *      top apex at the very top ON the wall; low KEEPS the wire (3-sided),
 *      so the ceramic is the same size at both details; the three
 *      `contents` differ.
 *   8. Peace lily: a glass (kept) vase, roots and one spathe at full.
 *   9. Snake plant: pale margins at full, none at low.
 *  10. Trailing pothos: vines hang BELOW the pot base when trail > 0; the
 *      pot base is at EXACTLY trail, 0 included; pinning keeps the pot's
 *      normals smooth across its seam; a dense crown.
 *  11. Ficus: the low saucer faces outward and up; a dense leaf mass.
 *  12. Jade: a compact clump on the rim, not rosettes on bare stems.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const P = await imp('src/furniture/plant.js');
const { build, buildPlant, TYPE, DEFAULTS, PRESETS, KINDS, POT_STYLES, WALL_CONTENTS, toFurnitureJSON } = P;

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const CM = 0.01;

function bboxCm(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return { minX: b.min.x / CM, maxX: b.max.x / CM, minY: b.min.y / CM, maxY: b.max.y / CM, minZ: b.min.z / CM, maxZ: b.max.z / CM };
}
function tris(group) {
  let t = 0;
  group.traverse(o => { if (o.isMesh) t += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return t;
}
function meshes(group, re) {
  const out = [];
  group.traverse(o => { if (o.isMesh && (!re || re.test(o.name))) out.push(o); });
  return out;
}
/** world-space vertex i of a mesh */
function wv(o, i) {
  const a = o.geometry.attributes.position;
  return new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(o.matrixWorld);
}
/** A leaf's width at each of its rows (world cm): the distance between its
 * two edge polylines' matching vertices (userData.edges, which copies the
 * geometry's own edge vertices), base row first, tip excluded. */
function rowWidths(o) {
  const { left, right } = o.geometry.userData.edges;
  const w = [];
  for (let i = 0; i < left.length - 1; i++) w.push(left[i].clone().applyMatrix4(o.matrixWorld).distanceTo(right[i].clone().applyMatrix4(o.matrixWorld)) / CM);
  return w;
}
const CAPS = { 'corn-plant': [800, 300], 'wall-planter': [400, 150] };
const capOf = kind => CAPS[kind] || [600, 200];

// ---- 0. module shape ---------------------------------------------------------
check('TYPE is "plant"', TYPE === 'plant', TYPE);
check('DEFAULTS is frozen', Object.isFrozen(DEFAULTS));
['width', 'depth', 'height'].forEach(k => check('DEFAULTS.' + k + ' is a number', typeof DEFAULTS[k] === 'number'));
// mutation: DEFAULTS.width 40 (the old spread) -> fails
check('DEFAULTS.width/depth = the corn crown spread (60)', DEFAULTS.width === DEFAULTS.spread && DEFAULTS.depth === DEFAULTS.spread && DEFAULTS.spread === 60,
  { width: DEFAULTS.width, depth: DEFAULTS.depth, spread: DEFAULTS.spread });
check('DEFAULTS.height = potHeight + plantHeight', DEFAULTS.height === DEFAULTS.potHeight + DEFAULTS.plantHeight, DEFAULTS.height);
check('buildPlant alias', typeof buildPlant === 'function');
check('KINDS lists all seven kinds', ['corn-plant', 'wall-planter', 'peace-lily', 'snake-plant', 'pothos', 'ficus', 'jade'].every(k => KINDS.includes(k)), KINDS);
check('every preset kind is a known kind, every preset potStyle a known style', Object.values(PRESETS).every(p =>
  KINDS.includes(p.kind) && (p.potStyle === undefined || POT_STYLES.includes(p.potStyle)) && (p.contents === undefined || WALL_CONTENTS.includes(p.contents))));
check('every kind has at least one preset', KINDS.every(k => Object.values(PRESETS).some(p => p.kind === k)));
{
  const j = toFurnitureJSON({ kind: 'jade', width: 22, height: 166 });
  // mutation: emit every key -> fails
  check('toFurnitureJSON emits only non-default keys', j.type === 'plant' && JSON.stringify(j.params) === JSON.stringify({ kind: 'jade', width: 22 }), j);
}

// ---- 1-3. every preset x detail: envelope, caps, finishes, no lights ----------
const FIN = new Set(['matte', 'gloss', 'satin', 'metal', 'glass', 'mirror', 'emissive']);
// Presets whose LOW layout is not a subset of the full one (the peace lily's
// low leaves are one-segment diamonds on a different draw sequence; the
// upright pothos's are too), so their low build does not fit inside the
// full build's frame and fits itself exactly, as every low build used to.
const LOW_OWN = new Set(['peace-lily-glass-vase', 'pothos-upright-ribbed-pot']);
/** bbox (cm) exactly on the envelope of q (0.5 cm) */
const onEnvelope = (b, q) => near(b.maxX - b.minX, q.width, 0.5) && near((b.maxX + b.minX) / 2, 0, 0.5) &&
  near(b.minZ, 0, 0.5) && near(b.maxZ, q.depth, 0.5) && near(b.minY, 0, 0.5) && near(b.maxY, q.height, 0.5);
/** bbox (cm) inside the envelope of q (0.5 cm) */
const inEnvelope = (b, q) => b.minX >= -q.width / 2 - 0.5 && b.maxX <= q.width / 2 + 0.5 && b.minZ >= -0.5 &&
  b.maxZ <= q.depth + 0.5 && b.minY >= -0.5 && b.maxY <= q.height + 0.5;
for (const [name, preset] of Object.entries(PRESETS)) {
  const full = build(THREE, preset, { detail: 'full' });
  const low = build(THREE, preset, { detail: 'low' });
  {
    const b = bboxCm(full);
    const tag = name + ' (full)';
    check(tag + ': width == params within 0.5', near(b.maxX - b.minX, preset.width, 0.5), b);
    check(tag + ': centred on x', near((b.maxX + b.minX) / 2, 0, 0.5), b);
    check(tag + ': depth == params within 0.5', near(b.maxZ - b.minZ, preset.depth, 0.5), b);
    check(tag + ': back at z = 0', near(b.minZ, 0, 0.5), b);
    check(tag + ': height == params within 0.5', near(b.maxY - b.minY, preset.height, 0.5), b);
    check(tag + ': bottom at y = 0', near(b.minY, 0, 0.5), b);
  }
  {
    const b = bboxCm(low);
    if (LOW_OWN.has(name)) {
      check(name + ' (low): fits itself exactly (its layout is not a subset of full)', low.userData.fitFrom === 'own' && onEnvelope(b, preset), b);
    } else {
      // Mutation: drop the full-build measurement in build() (ref = null) ->
      // every low build fits itself -> fitFrom 'own' -> fails.
      check(name + ' (low): reuses the full build fit', low.userData.fitFrom === 'full' &&
        JSON.stringify(low.userData.fitScale) === JSON.stringify(full.userData.fitScale), [low.userData.fitFrom, low.userData.fitScale, full.userData.fitScale]);
      check(name + ' (low): inside the envelope', inEnvelope(b, preset), b);
    }
  }
  for (const [dname, g] of [['full', full], ['low', low]]) {
    const tag = name + ' (' + dname + ')';
    const bad = [], unkept = [];
    let lights = 0;
    g.traverse(o => {
      if (o.isLight) lights++;
      if (!o.isMesh) return;
      const f = o.userData.finish;
      if (!FIN.has(f) || o.material.userData.finish !== f) bad.push(o.name + ':' + f);
      if ((f === 'glass' || f === 'emissive') && o.userData.keep !== true) unkept.push(o.name);
    });
    check(tag + ': every mesh has a palette finish matching its material', bad.length === 0, bad);
    check(tag + ': glass/emissive meshes are kept', unkept.length === 0, unkept);
    check(tag + ': no lights', lights === 0, lights);
  }
  const [cf, cl] = capOf(preset.kind);
  const tf = tris(full), tl = tris(low);
  // mutation: leaves segs 2 -> 4 in the corn plant -> over 800
  check(name + ': full <= ' + cf + ' triangles', tf <= cf, tf);
  check(name + ': low <= ' + cl + ' triangles', tl <= cl, tl);
  check(name + ': low is strictly cheaper than full', tl < tf, { tf, tl });
  if (tf > 300) check(name + ': low <= 0.6 x full', tl <= 0.6 * tf, { tf, tl });
}
// the DEFAULTS build too (the default corn plant)
{
  const tf = tris(build(THREE, {}, { detail: 'full' })), tl = tris(build(THREE, {}, { detail: 'low' }));
  check('DEFAULTS: full <= 800, low <= 300', tf <= 800 && tl <= 300, { tf, tl });
}

// ---- 4. leaves are two-sided by reversed duplicate faces -----------------------
for (const [name, preset] of Object.entries(PRESETS)) {
  const g = build(THREE, preset, { detail: 'full' });
  const leaves = meshes(g, /^leaf$/).filter(o => o.geometry.index);   // jade pads are closed solids
  let bad = 0;
  for (const o of leaves) {
    const idx = o.geometry.index.array, pos = o.geometry.attributes.position;
    const half = idx.length / 2, vc = pos.count / 2;
    let ok = idx.length % 6 === 0 && pos.count % 2 === 0;
    for (let i = 0; ok && i < half; i += 3) {
      // back face i must be front face i with its last two corners swapped,
      // on duplicated (not shared) vertices at the same positions
      const f = [idx[i], idx[i + 1], idx[i + 2]], k = [idx[half + i], idx[half + i + 1], idx[half + i + 2]];
      ok = k[0] === f[0] + vc && k[1] === f[2] + vc && k[2] === f[1] + vc &&
        near(pos.getX(f[0]), pos.getX(k[0]), 1e-9) && near(pos.getY(f[1]), pos.getY(k[2]), 1e-9);
    }
    if (!ok) bad++;
  }
  // mutation: drop the `concat(back)` in leafGeometry -> every leaf fails
  if (preset.kind !== 'jade') check(name + ': ' + leaves.length + ' leaves, all two-sided', leaves.length > 0 && bad === 0, { leaves: leaves.length, bad });
}

// ---- 1b. the envelope is exact for ANY seed and odd sizes -----------------------
// (code review 676d6500: a rigid pot that set ONE side of the footprint made
// the plant under-fill its envelope). Mutation: accept a rigid scale without
// the exact-bbox check -> fails on several seeds.
for (const [name, pr] of Object.entries(PRESETS)) {
  const sizes = [null, { width: 60, depth: 60 }, { width: 10, depth: 5, height: 30 }];
  for (const sz of sizes) for (let seed = 1; seed <= 30; seed += (sz ? 7 : 1)) {
    for (const d of ['full', 'low']) {
      const q = Object.assign({}, pr, sz || {}, { seed });
      const g = build(THREE, q, { detail: d });
      const b = bboxCm(g);
      // full: exactly the envelope. low: inside it when it reuses the full
      // fit, exactly on it when it fell back to fitting itself.
      const ok = d === 'low' && g.userData.fitFrom === 'full' ? inEnvelope(b, q) : onEnvelope(b, q);
      if (!ok) check(name + ' seed ' + seed + (sz ? ' ' + JSON.stringify(sz) : '') + ' (' + d + ', fit ' + g.userData.fitFrom + '): bbox = envelope', false, b);
      else passes++;
    }
  }
}

// ---- 4b. no leaf is a needle: its widest point is never at the base -----------
// A one-segment leaf used to be the base row plus the tip, so its widest
// point was the narrow base (a needle). Built FLAT (pitch 0, fold 0, roll 0,
// heading +z) so every row's vertices share one z and a row is exactly one
// z-group -- with a raised midrib the midrib vertex had its own z and made a
// zero-width "row" that let a needle pass (code review r3, item c35f1884).
// Mutation: drop the diamond branch in leafGeometry (diamond = false) ->
// every 1-segment leaf fails.
{
  const { leafGeometry, LEAF_SHAPES } = P;
  for (const shape of Object.keys(LEAF_SHAPES)) for (const segs of [1, 2, 3, 4]) for (const flat of [false, true]) {
    const g = leafGeometry(THREE, { base: new THREE.Vector3(0, 0, 0), ang: 0, len: 0.3, width: 0.06, pitch0: 0, pitch1: 0, segs, shape, fold: 0, flat });
    const pos = g.attributes.position, vc = pos.count / 2;
    // measure widths across x (heading is +z, so the blade's width runs along x)
    const rows = new Map();
    for (let i = 0; i < vc; i++) {
      const z = Math.round(pos.getZ(i) * 1e5);
      const r = rows.get(z) || { min: Infinity, max: -Infinity, z: pos.getZ(i) };
      r.min = Math.min(r.min, pos.getX(i)); r.max = Math.max(r.max, pos.getX(i)); rows.set(z, r);
    }
    const list = [...rows.values()].sort((a, b) => a.z - b.z);
    const widths = list.map(r => r.max - r.min);
    const wi = widths.indexOf(Math.max(...widths));
    const tag = 'leaf ' + shape + ' x ' + segs + ' seg' + (flat ? ' (flat)' : '');
    check(tag + ': one row per segment plus the tip (and the base point of a diamond)', list.length === segs + 1 + (segs === 1 ? 1 : 0), list.length);
    // (1.1: the snake plant's sword is near-parallel-sided, 0.8 -> 0.99 of its width)
    check(tag + ': widest point is past the base', wi > 0 && widths[wi] > widths[0] * 1.1, widths.map(w => +(w * 100).toFixed(2)));
    // >= 60 %: with rows only at t = i/n a coarse leaf can miss its exact
    // widest t (the stalked blade at 2 segments reaches 62 %); no kind builds
    // that combination, and 1 segment always hits the widest t exactly.
    check(tag + ': reaches most of the requested width', widths[wi] >= 0.06 * (segs === 1 ? 0.95 : 0.6), widths[wi]);
    // Triangles (both sides), as the leafGeometry header states. Mutation:
    // drop a face from the diamond (idx 0,1,2 only) -> fails.
    const want = flat ? (segs === 1 ? 4 : 2 * ((segs - 1) * 2 + 1)) : (segs === 1 ? 8 : 2 * ((segs - 1) * 4 + 2));
    check(tag + ': ' + want + ' triangles', g.index.count / 3 === want, g.index.count / 3);
    // Every FRONT face of a flat, unfolded, unrolled leaf faces the same way
    // (the back half is the reverse). Mutation: the diamond's base triangles
    // wound (0, 2, 1, 0, 3, 2) -> they face the other way -> fails.
    const idx = g.index.array, half = idx.length / 2;
    let up = 0, down = 0;
    for (let i = 0; i < half; i += 3) {
      const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, idx[i + k]));
      const n = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0]));
      if (n.y > 1e-12) up++; else if (n.y < -1e-12) down++;
    }
    check(tag + ': every front face winds the same way', up > 0 && down === 0, { up, down });
  }
  // and on real builds: the ficus's small leaves (always one segment) are
  // as wide as asked, not slivers. Measured PERPENDICULAR to the leaf's
  // chord (base -> tip): the bbox (which includes the leaf's length) let a
  // needle pass (code review r3). Mutation: diamond = false -> the widest
  // row is the narrow base -> fails.
  const g = build(THREE, PRESETS['ficus-bowl-pot'], { detail: 'full' });
  g.updateMatrixWorld(true);
  const ws = meshes(g, /^leaf$/).map(o => {
    const sp = o.geometry.userData.spine.map(v => v.clone().applyMatrix4(o.matrixWorld));
    const a0 = sp[0], d = sp[sp.length - 1].clone().sub(a0).normalize();
    const vc = o.geometry.attributes.position.count / 2;
    let m = 0;
    for (let i = 0; i < vc; i++) {
      const q = wv(o, i).sub(a0);
      m = Math.max(m, q.clone().sub(d.clone().multiplyScalar(q.dot(d))).length());
    }
    return 2 * m / CM;
  });
  check('ficus: leaves span at least their width across their length (not needles)', Math.min(...ws) >= PRESETS['ficus-bowl-pot'].leafWidth * 0.8, Math.min(...ws));
}

// ---- 4c. the ribbed-footed pot is actually fluted ------------------------------
// Mutation: back to cos(a * radial / 2 * 2) (always 1) -> every column the
// same radius -> fails.
{
  const g = build(THREE, PRESETS['pothos-upright-ribbed-pot'], { detail: 'full' });
  const pot = meshes(g, /^pot$/)[0];
  pot.updateMatrixWorld(true);
  const a = pot.geometry.attributes.position;
  const top = new Set();
  let maxY = -Infinity;
  for (let i = 0; i < a.count; i++) maxY = Math.max(maxY, a.getY(i));
  for (let i = 0; i < a.count; i++) if (Math.abs(a.getY(i) - maxY) < 1e-6) top.add(Math.hypot(a.getX(i), a.getZ(i)).toFixed(5));
  check('ribbed-footed pot: rim radius alternates (fluted)', top.size >= 2, [...top]);
}

// ---- 4d. corn: lower leaves droop below horizontal toward the tip -------------
// Mutation: bend 1.7 -> 0.5 for lower leaves -> tips stay above their base -> fails.
{
  const g = build(THREE, PRESETS['corn-plant-tall'], { detail: 'full' });
  g.updateMatrixWorld(true);
  const leaves = meshes(g, /^leaf$/);
  let drooping = 0;
  for (const o of leaves) {
    const vc = o.geometry.attributes.position.count / 2;
    const base = wv(o, 1), tip = wv(o, vc - 1), mid = wv(o, 4);
    if (tip.y < mid.y) drooping++;
  }
  check('corn: at least half the leaves droop toward their tips', drooping >= leaves.length / 2, { drooping, of: leaves.length });
}

// ---- 5. seed determinism, every kind -------------------------------------------
function layout(g) {
  const pts = [];
  meshes(g, /^leaf$/).forEach(o => { const a = o.geometry.attributes.position; pts.push([a.getX(a.count - 1), a.getY(a.count - 1), a.getZ(a.count - 1)]); });
  return pts;
}
for (const k of KINDS) {
  const base = Object.values(PRESETS).find(p => p.kind === k);
  const a1 = layout(build(THREE, Object.assign({}, base, { seed: 11 })));
  const a2 = layout(build(THREE, Object.assign({}, base, { seed: 11 })));
  const b1 = layout(build(THREE, Object.assign({}, base, { seed: 12 })));
  check(k + ': same seed -> identical layout', JSON.stringify(a1) === JSON.stringify(a2));
  // mutation: ignore p.seed in makeCtx -> identical -> fails
  check(k + ': different seed -> different layout', JSON.stringify(a1) !== JSON.stringify(b1));
}

// ---- 6. corn plant: leaf size measured on the BUILT output ----------------------
{
  const pr = PRESETS['corn-plant-tall'];
  check('corn preset: pot 56 / rim 30 / plant 110 / spread 60 / leaves 45 x 6', pr.potHeight === 56 && pr.potTopDiameter === 30 &&
    pr.plantHeight === 110 && pr.spread === 60 && pr.leafLength === 45 && pr.leafWidth === 6, pr);
  const g = build(THREE, pr, { detail: 'full' });
  g.updateMatrixWorld(true);
  const canes = meshes(g, /^cane$/).map(o => bboxCm(o).maxY).sort((a, b) => b - a);
  check('corn: 3 canes', canes.length === 3, canes.length);
  const rim = pr.potHeight;
  const above = canes.map(y => y - rim);
  // mutation: FR = [0.72, 0.72, 0.72] -> ratios 1 -> fails
  check('corn: cane heights clearly staggered (mid ~0.4, short ~0.15 of tallest)',
    above[1] / above[0] > 0.25 && above[1] / above[0] < 0.6 && above[2] / above[0] > 0.05 && above[2] / above[0] < 0.3, above);
  const leaves = meshes(g, /^leaf$/);
  const topCane = canes[0];
  const stats = leaves.map(o => {
    // length along the leaf's own midline (userData.spine, base to tip),
    // transformed to world -- i.e. AFTER the envelope fit
    const sp = o.geometry.userData.spine.map(v => v.clone().applyMatrix4(o.matrixWorld));
    let len = 0;
    for (let i = 1; i < sp.length; i++) len += sp[i].distanceTo(sp[i - 1]);
    return { len: len / CM, w: Math.max(...rowWidths(o)), baseY: sp[0].y / CM };
  });
  const top = stats.filter(s => s.baseY > topCane - 40);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const topLen = mean(top.map(s => s.len)), allW = mean(stats.map(s => s.w));
  // mutation: tie leaf length back to spread/2 (len = spreadR) -> ~30 -> fails
  check('corn: top-tuft leaves average 40-50 cm long (post-fit)', top.length >= 15 && topLen >= 40 && topLen <= 50, { n: top.length, topLen });
  check('corn: no leaf shorter than 30 cm', stats.every(s => s.len >= 30), Math.min(...stats.map(s => s.len)));
  // mutation: leafWidth 6 -> 3 in the preset -> ~3.3 -> fails
  check('corn: leaves average 5-7 cm wide (post-fit)', allW >= 5 && allW <= 7, allW);
  check('corn: ~48 leaves in tufts (not 13-leaf rosettes)', leaves.length >= 40, leaves.length);
  // the top tuft spreads to about twice the rim (visual review c775141a).
  // Mutation: top-cane reach back to spreadR -> ~50 -> fails.
  const tb = new THREE.Box3();
  leaves.forEach(o => { if (o.geometry.userData.spine[0].clone().applyMatrix4(o.matrixWorld).y / CM > topCane - 40) tb.expandByObject(o); });
  const tuftW = Math.max(tb.max.x - tb.min.x, tb.max.z - tb.min.z) / CM;
  check('corn: top tuft ~60 cm across (about twice the 30 cm rim)', tuftW >= 55 && tuftW <= 68, tuftW);
  // strap leaves: wide along most of the length. Mutation: shape 'lance' ->
  // the base row is a point (0.18) -> fails.
  check('corn: strap-shaped leaves at full detail', leaves.every(o => {
    const w = rowWidths(o);
    if (w.length < 3) return false;
    const max = Math.max(...w);
    // (near) the full requested width at the bend, still >= 3/4 of it at the
    // row 3/4 along, and the base row narrower but not a point
    return max >= 0.9 * PRESETS['corn-plant-tall'].leafWidth && w[w.length - 1] >= 0.75 * max && w[0] >= 0.4 * max;
  }));
  // leaves attach to the cane: every leaf base lies on a cane's axis
  // (within the cane radius). Mutation: base at the cane TOP's x/z -> the
  // leaning cane leaves the lower bases ~1 cm off -> fails.
  // each cane's axis: the centres of its bottom and top rings (world space)
  const caneAxes = meshes(g, /^cane$/).map(c => {
    const a = c.geometry.attributes.position, vs = [];
    for (let i = 0; i < a.count; i++) vs.push(new THREE.Vector3(a.getX(i), a.getY(i), a.getZ(i)).applyMatrix4(c.matrixWorld));
    const ys = vs.map(v => v.y), lo = Math.min(...ys), hi = Math.max(...ys);
    const ctr = sel => { const q = vs.filter(sel); return q.reduce((m, v) => m.add(v), new THREE.Vector3()).multiplyScalar(1 / q.length); };
    // ring vertices sit within a cane radius of their end, even on a lean
    return [ctr(v => v.y < lo + 0.02), ctr(v => v.y > hi - 0.02)];
  });
  const off = leaves.map(o => {
    const b = o.geometry.userData.spine[0].clone().applyMatrix4(o.matrixWorld);
    return Math.min(...caneAxes.map(([p0, p1]) => {
      const t = (b.y - p0.y) / (p1.y - p0.y);
      if (t < -0.05 || t > 1.05) return Infinity;
      const q = p0.clone().lerp(p1, t);
      return Math.hypot(q.x - b.x, q.z - b.z);
    }));
  });
  check('corn: leaf bases sit on their cane (within its radius)', Math.max(...off) <= 0.02, Math.max(...off) / CM);
  // The canes stand at the SAME heights at both details (they moved ~9 cm,
  // 138/92/73 -> 129/86/68, when low fitted itself: visual review of #77).
  // Mutation: drop the full-build measurement in build() -> fails.
  const lowG = build(THREE, pr, { detail: 'low' });
  const canesLow = meshes(lowG, /^cane$/).map(o => bboxCm(o).maxY).sort((a, b) => b - a);
  check('corn: cane tops identical at full and low (within 0.5 cm)', canesLow.length === 3 &&
    canesLow.every((y, i) => near(y, canes[i], 0.5)), { full: canes, low: canesLow });
  // They DROOP: most leaves arch over and hang with the tip BELOW the point
  // where they leave the cane (the photographed fountain), at both details.
  // Mutation: lower-leaf droop p1 = +0.3 -> tips above their bases -> fails.
  for (const [d, g2] of [['full', g], ['low', lowG]]) {
    g2.updateMatrixWorld(true);
    const ls = meshes(g2, /^leaf$/);
    const below = ls.filter(o => {
      const sp = o.geometry.userData.spine.map(v => v.clone().applyMatrix4(o.matrixWorld));
      return sp[sp.length - 1].y < sp[0].y;
    }).length;
    check('corn (' + d + '): at least 60 % of leaves hang their tip below their base', below >= 0.6 * ls.length, { below, of: ls.length });
  }
}

// ---- 7. wall planter geometry -------------------------------------------------
{
  for (const name of ['wall-planter-large', 'wall-planter-small', 'wall-planter-large-snake']) {
    const pr = PRESETS[name];
    const g = build(THREE, pr, { detail: 'full' });
    g.updateMatrixWorld(true);
    const body = meshes(g, /^planterBody$/)[0];
    check(name + ': has a ceramic body', !!body);
    if (!body) continue;
    const n = body.geometry.attributes.position.count;
    const V = [...Array(n).keys()].map(i => wv(body, i).multiplyScalar(1 / CM));
    const b = bboxCm(g);
    // The wire's own radius (~0.16 cm) sits half behind the back edge, so
    // "on the wall" is judged to the contract's 0.5 cm tolerance.
    // the back face: some triangle whose three corners all lie on one plane
    // z = const within 0.5 cm of the back
    let flatBack = false;
    for (let i = 0; i < n; i += 3) {
      const zs = [0, 1, 2].map(k => V[i + k].z);
      if (Math.max(...zs) - Math.min(...zs) < 1e-3 && Math.max(...zs) < 0.5) flatBack = true;
    }
    // mutation: push the bottom point forward (B at z = D/3) -> no flat back -> fails
    check(name + ': a flat back triangle on the wall (z = 0)', flatBack);
    const bottom = V.reduce((m, v) => (v.y < m.y ? v : m), V[0]);
    check(name + ': the bottom point sits on the wall', bottom.z < 0.5 && near(bottom.y, 0, 0.5), bottom);
    const maxZ = Math.max(...V.map(v => v.z));
    const front = V.filter(v => near(v.z, maxZ, 1e-3));
    const uniq = new Set(front.map(v => v.x.toFixed(2) + ',' + v.y.toFixed(2)));
    check(name + ': ONE front apex, at the front (z ~ depth)', uniq.size === 1 && near(maxZ, pr.depth, 0.6), { apexes: [...uniq], maxZ });
    const ceramicTop = Math.max(...V.map(v => v.y));
    check(name + ': ceramic is the lower half (top at ~50 % of height)', near(ceramicTop / pr.height, 0.5, 0.05), ceramicTop);
    const wires = meshes(g, /^wire$/);
    check(name + ': brass wire traces the edges (9 struts)', wires.length === 9 && wires.every(o => o.userData.finish === 'metal'), wires.length);
    const wireTop = Math.max(...wires.map(o => bboxCm(o).maxY));
    check(name + ': wire apex reaches the very top', near(wireTop, pr.height, 0.5), wireTop);
    const apexZ = (() => { let best = null; wires.forEach(o => { const bb = bboxCm(o); if (near(bb.maxY, wireTop, 0.01)) best = bb; }); return best ? best.minZ : null; })();
    check(name + ': the top apex hangs ON the wall (z ~ 0)', apexZ !== null && apexZ < 0.5, apexZ);
    const low = build(THREE, pr, { detail: 'low' });
    // The wire stays at low detail (cheaper, 3-sided): it carries the top
    // apex that sets the envelope height, and dropping it made the fit
    // stretch the ceramic (visual review c775141a).
    // Mutation: drop the wire at low -> the ceramic rescales -> fails.
    check(name + ': low keeps the wire, cheaper', meshes(low, /^wire$/).length === 9 && tris(low) < tris(g));
    const bodyLow = meshes(low, /^planterBody$/)[0];
    const bf = bboxCm(body), bl = bboxCm(bodyLow);
    check(name + ': the ceramic is the same size at both details', near(bf.maxX - bf.minX, bl.maxX - bl.minX, 0.2) &&
      near(bf.maxY, bl.maxY, 0.2) && near(bf.maxZ, bl.maxZ, 0.2), { bf, bl });
  }
  const count = (name, re) => meshes(build(THREE, PRESETS[name]), re).length;
  check('contents differ: spiky tuft has many blades', count('wall-planter-large', /^leaf$/) >= 15);
  check('contents differ: succulent is a small tuft', count('wall-planter-small', /^leaf$/) <= 10);
  check('contents differ: snake-plant has margin strips, spiky does not',
    count('wall-planter-large-snake', /^leafMargin$/) > 0 && count('wall-planter-large', /^leafMargin$/) === 0);
  check('retail sizes: large 22.9 x 9.5 x 38.1, small 11 x 9.8 x 14.3',
    PRESETS['wall-planter-large'].width === 22.9 && PRESETS['wall-planter-large'].height === 38.1 && PRESETS['wall-planter-small'].height === 14.3);
}

// ---- 8. peace lily ------------------------------------------------------------
{
  const g = build(THREE, PRESETS['peace-lily-glass-vase'], { detail: 'full' });
  const pot = meshes(g, /^pot$/)[0];
  // mutation: potStyle 'tapered' for the lily -> not glass -> fails
  check('peace lily: the vase is glass and kept', pot && pot.userData.finish === 'glass' && pot.userData.keep === true);
  check('peace lily: roots visible in the vase', meshes(g, /^root$/).length >= 3);
  check('peace lily: one white spathe', meshes(g, /^spathe$/).length === 1);
  check('peace lily: water surface is glass (kept)', meshes(g, /^water$/).every(o => o.userData.keep === true) && meshes(g, /^water$/).length === 1);
  check('peace lily: some leaves variegated (accent colour)', (() => {
    const cols = new Set(meshes(g, /^leaf$/).map(o => o.material.color.getHexString()));
    return cols.size >= 2;
  })());
}

// ---- 8b. pots render ROUND: each preset's footprint is its natural one --------
// Mutation: set any preset's depth 30 % off its natural footprint -> the fit
// stretches the pot into an oval -> fails.
for (const [name, pr] of Object.entries(PRESETS)) {
  if (pr.kind === 'wall-planter') continue;
  const g = build(THREE, pr, { detail: 'full' });
  const pb = bboxCm(meshes(g, /^pot$/)[0]);
  const w = pb.maxX - pb.minX, d = pb.maxZ - pb.minZ;
  // 7 %: a 10-sided lathe is itself ~5 % wider across its flats one way
  // than the other; an oval from the fit was 25-35 % before this fix.
  check(name + ': pot is round (x/z within 7 %)', Math.abs(w / d - 1) <= 0.07, { w, d });
  // 12 %: the widest pot is the bowl, whose foot flares to 1.1 x the rim
  // (19.8 against 18, +10 %); a 10-sided lathe adds up to ~5 % one way.
  // Mutation: the full bowl's foot flares to 1.3 x the rim -> fails.
  check(name + ': pot keeps its diameter within 12 %', Math.abs(w / pr.potTopDiameter - 1) <= 0.12, { w, dia: pr.potTopDiameter });
  // and at LOW detail too (fewer leaves change the raw footprint; the pot is
  // a rigid part of the fit). Mutation: remove 'pot' from RIGID_PARTS -> fails.
  const gl = build(THREE, pr, { detail: 'low' });
  const pl = bboxCm(meshes(gl, /^pot$/)[0]);
  check(name + ' (low): pot is round (x/z within 7 %)', Math.abs((pl.maxX - pl.minX) / (pl.maxZ - pl.minZ) - 1) <= 0.07, pl);
  // ...and the same size as at full detail: no jump when the detail
  // switches (visual review 13fdd666). Mutation: drop 'pot' from
  // RIGID_PARTS -> the corn pot shrinks at low -> fails.
  check(name + ' (low): pot width within 12 % of full', Math.abs((pl.maxX - pl.minX) / w - 1) <= 0.12, { low: pl.maxX - pl.minX, full: w });
  check(name + ' (low): pot height within 10 % of full', Math.abs((pl.maxY - pl.minY) / (pb.maxY - pb.minY) - 1) <= 0.1, { low: pl.maxY - pl.minY, full: pb.maxY - pb.minY });
}
{
  // the peace lily at low detail keeps its leaf count, capped at 7
  const lo = n => meshes(build(THREE, Object.assign({}, PRESETS['peace-lily-glass-vase'], { leafCount: n }), { detail: 'low' }), /^leaf$/).length;
  // Mutation: back to a fixed 7 at low -> leafCount 4 gives 7 -> fails.
  check('peace lily low: respects a small leafCount', lo(4) === 4, lo(4));
  check('peace lily low: capped at 7', lo(12) === 7, lo(12));
}
{
  // the small planter's succulent stands ~6-8 cm tall
  const g = build(THREE, PRESETS['wall-planter-small'], { detail: 'full' });
  const leaves = meshes(g, /^leaf$/);
  const top = Math.max(...leaves.map(o => bboxCm(o).maxY)), base = Math.min(...leaves.map(o => bboxCm(o).minY));
  check('succulent tuft is ~6-8 cm tall', top - base >= 5.5 && top - base <= 8.5, top - base);
}
{
  // pale banding on the corn plant's bare canes (full only)
  const f = meshes(build(THREE, PRESETS['corn-plant-tall'], { detail: 'full' }), /^caneBand$/).length;
  const l = meshes(build(THREE, PRESETS['corn-plant-tall'], { detail: 'low' }), /^caneBand$/).length;
  check('corn: pale bands on the canes at full, none at low', f >= 2 && l === 0, { f, l });
}

// ---- 9. snake plant margins -----------------------------------------------------
{
  const full = build(THREE, PRESETS['snake-plant-small'], { detail: 'full' });
  const low = build(THREE, PRESETS['snake-plant-small'], { detail: 'low' });
  const nLeaf = meshes(full, /^leaf$/).length;
  // mutation: drop the marginStrips() call -> fails
  check('snake plant: one margin per leaf at full', nLeaf > 0 && meshes(full, /^leafMargin$/).length === nLeaf, nLeaf);
  check('snake plant: no margins at low', meshes(low, /^leafMargin$/).length === 0);
}

// ---- 10. trailing pothos --------------------------------------------------------
{
  const pr = PRESETS['pothos-trailing'];
  const g = build(THREE, pr, { detail: 'full' });
  const potBottom = bboxCm(meshes(g, /^pot$/)[0]).minY;
  const below = meshes(g, /^leaf$/).filter(o => bboxCm(o).minY < potBottom - 5).length;
  // mutation: trail ignored (pot at y = 0) -> potBottom 0 -> nothing below -> fails
  check('trailing pothos: pot raised by trail, vines hang below it', potBottom > 20 && below >= 5, { potBottom, below });
  // `trail` is EXACT after the envelope fit, at both details and any trail,
  // so a placement's `elevation = surface - trail` puts the pot on the
  // surface. Mutation: drop the pinTrail() call -> pot base off by cm -> fails.
  // trail 0 too (code review r2 of #77, item 914e9e23): the pot base was at
  // 6.3 (full) / 13.6 (low) cm because leaves hung below it and the pin only
  // ran for trail > 0. Mutation: drop the drop cap in buildPothos (vines as
  // long as the pot is high) -> leaves hang below the pot -> fails at 0.
  for (const t of [0, 10, 30, 50, 80]) for (const d of ['full', 'low']) {
    const q = Object.assign({}, pr, { trail: t, height: Math.max(pr.height, t + 25) });
    const gt = build(THREE, q, { detail: d });
    const pb = bboxCm(meshes(gt, /^pot$/)[0]).minY;
    const bb = bboxCm(gt);
    check('trailing pothos: pot base at exactly trail=' + t + ' (' + d + ')', near(pb, t, 0.5), pb);
    check('trailing pothos: envelope ' + (d === 'full' ? 'still exact' : 'still holds') + ' after pinning (trail ' + t + ', ' + d + ')',
      d === 'full' ? onEnvelope(bb, q) : inEnvelope(bb, q), bb);
  }
  // ...and at trail 0 nothing is SQUASHED onto the floor to get there: the
  // builder hangs nothing below the pot, rather than the pin flattening what
  // did (every leaf and vine keeps some height). Mutation: drop the drop cap
  // in buildPothos -> leaves hang below the pot, the pin squashes them flat
  // onto y = 0 -> fails.
  for (const d of ['full', 'low']) {
    const g0 = build(THREE, Object.assign({}, pr, { trail: 0 }), { detail: d });
    const flat = meshes(g0, /^(leaf|vine)$/).filter(o => { const b = bboxCm(o); return b.maxY - b.minY < 0.05; }).length;
    check('trailing pothos: trail 0 flattens nothing onto the floor (' + d + ')', flat === 0, flat);
  }
  // PINNING KEEPS THE POT'S NORMALS SMOOTH. It used to recompute them, which
  // split the lathe pot's seam column (duplicated vertices ~30 degrees apart:
  // a shading line down the pot). Now every set of coincident pot vertices
  // shares one normal. Mutation: computeVertexNormals() back in pinTrail ->
  // fails.
  {
    const pot = meshes(build(THREE, pr, { detail: 'full' }), /^pot$/)[0];
    const a = pot.geometry.attributes.position, n = pot.geometry.attributes.normal;
    const byPos = new Map();
    for (let i = 0; i < a.count; i++) {
      const k = [a.getX(i), a.getY(i), a.getZ(i)].map(v => Math.round(v * 1e5)).join(',');
      if (!byPos.has(k)) byPos.set(k, []);
      byPos.get(k).push(i);
    }
    let worst = 0, unit = true;
    byPos.forEach(ids => ids.forEach(i => {
      unit = unit && near(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)), 1, 1e-4);
      const j = ids[0];
      worst = Math.max(worst, 1 - (n.getX(i) * n.getX(j) + n.getY(i) * n.getY(j) + n.getZ(i) * n.getZ(j)));
    }));
    check('trailing pothos: pinned pot has one normal per point (no seam) and unit normals', worst < 1e-4 && unit, { worst, unit });
  }
  // ...and the remap TRANSFORMS each normal: n' = normalize(nx, ny / s, nz)
  // for its piece's slope s. Mutation: skip the normal update in remapY ->
  // the sloped normal is unchanged -> fails.
  {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.2, 0, 1, 0.2, 0, 0, 0.8, 0], 3));
    const k = Math.SQRT1_2;
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, k, k, 0, k, k, 0, k, k], 3));
    P.remapY(geo, 0.5, 0.25, 1);                 // lower piece slope 0.5, upper 1.5
    const nl = new THREE.Vector3().fromBufferAttribute(geo.attributes.normal, 0);
    const nu = new THREE.Vector3().fromBufferAttribute(geo.attributes.normal, 2);
    const el = new THREE.Vector3(0, k / 0.5, k).normalize(), eu = new THREE.Vector3(0, k / 1.5, k).normalize();
    check('remapY transforms normals by each piece inverse-transpose', nl.distanceTo(el) < 1e-5 && nu.distanceTo(eu) < 1e-5,
      { lower: nl.toArray(), upper: nu.toArray() });
    check('remapY moves y piecewise (0.2 -> 0.1, 0.8 -> 0.7)', near(geo.attributes.position.getY(0), 0.1, 1e-6) && near(geo.attributes.position.getY(2), 0.7, 1e-6));
  }
  // A DENSE crown (the photographed pothos is a mound of leaves spilling
  // over the rim, not a few leaves on strings). Mutation: crown 50 % -> 20 %
  // of the leaves -> fails.
  {
    const rimY = pr.trail + pr.potHeight;
    for (const [d, minCrown, minVine] of [['full', 24, 5], ['low', 8, 2]]) {
      const gd = build(THREE, pr, { detail: d });
      const ls = meshes(gd, /^leaf$/);
      const crown = ls.filter(o => bboxCm(o).maxY > rimY + 1).length;
      const vineLeaves = ls.length - crown;
      const vines = meshes(gd, /^vine$/).length;
      check('trailing pothos (' + d + '): a crown of >= ' + minCrown + ' leaves above the rim', crown >= minCrown, crown);
      check('trailing pothos (' + d + '): >= ' + minVine + ' leaves per vine', vines > 0 && vineLeaves / vines >= minVine, { vineLeaves, vines });
    }
  }
  const up = build(THREE, Object.assign({}, pr, { habit: 'upright' }), { detail: 'full' });
  const upPot = bboxCm(meshes(up, /^pot$/)[0]).minY;
  check('upright pothos: pot on the ground, trail ignored', near(upPot, 0, 0.5), upPot);
  // no leaf floats at low detail: every leaf base sits on a stem (the stems
  // are kept at low). Mutation: skip the stems when low -> fails.
  const upLow = build(THREE, PRESETS['pothos-upright-ribbed-pot'], { detail: 'low' });
  check('upright pothos (low): stems are kept', meshes(upLow, /^stem$/).length === PRESETS['pothos-upright-ribbed-pot'].stemCount);
}

// ---- 11. ficus ---------------------------------------------------------------
{
  const pr = PRESETS['ficus-bowl-pot'];
  // The low saucer is a disc, not slivers (visual review of #77, item
  // 0d316298): its side faces point OUT and its top faces point UP. Its
  // profile ran top-to-bottom once, winding every face inward (culled).
  // Mutation: the low saucer profile reversed -> faces inward -> fails.
  const g = build(THREE, pr, { detail: 'low' });
  g.updateMatrixWorld(true);
  const sc = meshes(g, /^saucer$/)[0];
  const pos = sc.geometry.attributes.position, idx = sc.geometry.index;
  const ctr = new THREE.Box3().setFromObject(sc).getCenter(new THREE.Vector3());
  let out = 0, inward = 0, up = 0, down = 0;
  for (let t = 0; t < (idx ? idx.count : pos.count) / 3; t++) {
    const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(t * 3 + k) : t * 3 + k).applyMatrix4(sc.matrixWorld));
    const n = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0]));
    if (n.length() < 1e-12) continue;                               // degenerate (on the axis)
    n.normalize();
    const c = v[0].clone().add(v[1]).add(v[2]).multiplyScalar(1 / 3);
    if (Math.abs(n.y) > 0.7) { if (n.y > 0) up++; else down++; }
    else if (n.x * (c.x - ctr.x) + n.z * (c.z - ctr.z) > 0) out++; else inward++;
  }
  check('ficus (low): saucer side faces point outward, its top faces up', out >= 8 && inward === 0 && up >= 8 && down === 0, { out, inward, up, down });
  // A leaf MASS, not a sapling with a few tip leaves (visual review r4 of
  // #77, item 12da4fab). Mutation: leafCount back to 36 -> fails.
  const full = build(THREE, pr, { detail: 'full' });
  const ls = meshes(full, /^leaf$/);
  check('ficus (full): >= 60 leaves', ls.length >= 60, ls.length);
  check('ficus (low): >= 12 leaves', meshes(g, /^leaf$/).length >= 12, meshes(g, /^leaf$/).length);
  // most of them massed low, round the top of the trunk, not up at the tips
  const trunkTop = bboxCm(meshes(full, /^trunk$/)[0]).maxY;
  const massed = ls.filter(o => { const b = bboxCm(o); return (b.minY + b.maxY) / 2 < trunkTop + 8; }).length;
  check('ficus (full): at least half the leaves massed round the trunk top', massed >= ls.length / 2, { massed, of: ls.length });
}

// ---- 12. jade ----------------------------------------------------------------
// A COMPACT CLUMP of pads on the rim, not rosettes on long bare stems
// standing ~15 cm above the pot (visual review r4 of #77, item 12da4fab).
// Mutation: pads only at the stem tips again (t 0.88..1) -> fails.
{
  const pr = PRESETS['jade-small'];
  for (const d of ['full', 'low']) {
    const g = build(THREE, pr, { detail: d });
    g.updateMatrixWorld(true);
    const rim = bboxCm(meshes(g, /^pot$/)[0]).maxY;
    const top = bboxCm(g).maxY;
    const pads = meshes(g, /^leaf$/).map(o => bboxCm(o));
    const lowest = Math.min(...pads.map(b => b.minY));
    const lowerHalf = pads.filter(b => (b.minY + b.maxY) / 2 < rim + (top - rim) / 2).length;
    check('jade (' + d + '): the lowest pads sit on the rim (within 2 cm)', lowest < rim + 2, { lowest, rim });
    check('jade (' + d + '): a third of the pads in the lower half of the plant', lowerHalf >= pads.length / 3, { lowerHalf, of: pads.length });
  }
}

console.log(`${passes} passed, ${failures} failed.`);
if (failures > 0) process.exit(1);
