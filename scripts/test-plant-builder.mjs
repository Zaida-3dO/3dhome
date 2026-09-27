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
 *   1. Every preset, at BOTH details, lands exactly on its own envelope:
 *      width/depth/height within 0.5 cm, x centred, bottom at y = 0, back
 *      at z = 0.
 *   2. Triangle caps (perf audit): corn-plant 800 / 300, wall-planter
 *      400 / 150, every other kind 600 / 200; 'low' strictly cheaper, and
 *      <= 0.6 x 'full' whenever full > 300.
 *   3. Finishes: every mesh tagged from the palette; glass / emissive kept;
 *      no THREE lights anywhere.
 *   4. Leaves are TWO-SIDED by duplicated, reversed faces (not a DoubleSide
 *      material, which would cost a merge bucket per room).
 *   5. Seed determinism: same seed -> identical layout; different seed ->
 *      different layout -- for every kind.
 *   6. Corn plant (scout d359c08e, follow-up 743c2deb): leaves measured ON
 *      THE BUILT OUTPUT, after the envelope fit -- the top tuft's leaves
 *      average 40-50 cm long, and leaves average 5-7 cm wide; three canes
 *      of clearly different heights.
 *   7. Wall planter: a FLAT BACK on the wall (a back face whose three
 *      corners, including the bottom point, lie on z = 0), ONE front apex
 *      at z = depth, the ceramic's open top at half the height, the wire's
 *      top apex at the very top ON the wall; low drops the wire; the three
 *      `contents` differ.
 *   8. Peace lily: a glass (kept) vase, roots and one spathe at full.
 *   9. Snake plant: pale margins at full, none at low.
 *  10. Trailing pothos: vines hang BELOW the pot base when trail > 0.
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
for (const [name, preset] of Object.entries(PRESETS)) {
  const full = build(THREE, preset, { detail: 'full' });
  const low = build(THREE, preset, { detail: 'low' });
  for (const [dname, g] of [['full', full], ['low', low]]) {
    const b = bboxCm(g);
    const tag = name + ' (' + dname + ')';
    check(tag + ': width == params within 0.5', near(b.maxX - b.minX, preset.width, 0.5), b);
    check(tag + ': centred on x', near((b.maxX + b.minX) / 2, 0, 0.5), b);
    check(tag + ': depth == params within 0.5', near(b.maxZ - b.minZ, preset.depth, 0.5), b);
    check(tag + ': back at z = 0', near(b.minZ, 0, 0.5), b);
    check(tag + ': height == params within 0.5', near(b.maxY - b.minY, preset.height, 0.5), b);
    check(tag + ': bottom at y = 0', near(b.minY, 0, 0.5), b);
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
    const vc = o.geometry.attributes.position.count / 2;   // front half
    const rows = (vc - 1) / 3;
    let len = 0, prev = wv(o, 1), w = 0;
    for (let r = 1; r < rows; r++) { const c = wv(o, r * 3 + 1); len += c.distanceTo(prev); prev = c; }
    len += wv(o, vc - 1).distanceTo(prev);
    for (let r = 0; r < rows; r++) w = Math.max(w, wv(o, r * 3).distanceTo(wv(o, r * 3 + 2)));
    return { len: len / CM, w: w / CM, baseY: wv(o, 1).y / CM };
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
    // mutation: build the wire at low detail too -> fails
    check(name + ': low detail drops the wire', meshes(low, /^wire$/).length === 0);
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
  const up = build(THREE, Object.assign({}, pr, { habit: 'upright' }), { detail: 'full' });
  const upPot = bboxCm(meshes(up, /^pot$/)[0]).minY;
  check('upright pothos: pot on the ground, trail ignored', near(upPot, 0, 0.5), upPot);
}

console.log(`${passes} passed, ${failures} failed.`);
if (failures > 0) process.exit(1);
