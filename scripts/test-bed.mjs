#!/usr/bin/env node
/**
 * bed.js: geometry decisions a contract-gate screenshot cannot pin.
 * No framework, no install: `node scripts/test-bed.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract (bbox, finish tags, no-three, low<=full triangles) for every
 * registered type including `bed`. This file checks the type-specific
 * decisions that contract does not know to ask about:
 *
 *   1. The headboard is channel-tufted: DEFAULTS.channelCount distinct
 *      WIDE padded channels stand proud of the backing panel, evenly spaced
 *      and flush with the panel's own edges (no wasted margin), butted
 *      together with only a small crease between neighbours (not thin poles
 *      with wide gaps), each taller than it is wide (a vertical channel).
 *   2. `height` is honoured directly as the headboard height (there is no
 *      separate headboardHeight param): the built envelope equals `height`
 *      whenever the headboard is the tallest part, and never shrinks below
 *      the base+mattress stack if `height` is set shorter than that.
 *   3. duvet:false removes the duvet mesh (and pillow presence is unaffected
 *      by it); detail:'low' drops the pillows.
 *   4. The pillows sit at the HEADBOARD end (small z, near the backing
 *      panel), resting on the mattress -- NOT at the foot where the duvet
 *      is, and not poking out of it. A reviewer mutation that moved the
 *      pillows to the foot must fail this check.
 *   5. A second size (non-default width/depth) still builds a coherent bed:
 *      channel count is preserved, and the back stays at z=0.
 *   6. Colours land on the right parts: headboard colour != mattress colour
 *      != base colour, and each actually appears on the geometry it should.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const Bed = await imp('src/furniture/bed.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function meshesByColor(group, hex) {
  const out = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.color && mat.color.getHex() === hex) out.push(o);
  });
  return out;
}
const colorInt = hex => parseInt(hex.slice(1), 16);

// ---- shape and exports ------------------------------------------------------
{
  check('exports TYPE "bed"', Bed.TYPE === 'bed');
  check('DEFAULTS frozen with width/depth/height numeric',
    Object.isFrozen(Bed.DEFAULTS) &&
    ['width', 'depth', 'height'].every(k => typeof Bed.DEFAULTS[k] === 'number'));
}

// ---- channel-tufted headboard ------------------------------------------------
{
  const D = Bed.DEFAULTS;
  const g = Bed.build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);

  const headboardColorInt = colorInt(D.headboardColor);
  const headboardMeshes = meshesByColor(g, headboardColorInt);
  // backing panel (1 box) + n channels
  check('headboard: backing + channelCount meshes in the headboard colour',
    headboardMeshes.length === D.channelCount + 1, headboardMeshes.length);

  // Identify the channels (cylinders, not the flat backing box) by triangle
  // count: a CylinderGeometry has far more triangles than a 12-triangle box.
  const channels = headboardMeshes.filter(m => {
    const idx = m.geometry.index;
    const triCount = idx ? idx.count / 3 : m.geometry.attributes.position.count / 3;
    return triCount > 12;
  });
  check('headboard: exactly channelCount channel meshes found', channels.length === D.channelCount, channels.length);

  // Evenly spaced and flush with the panel edges.
  const xs = channels.map(m => {
    const b = new THREE.Box3().setFromObject(m);
    return (b.min.x + b.max.x) / 2;
  }).sort((a, b) => a - b);
  const widthM = D.width / 100;
  const nominal = widthM / D.channelCount;
  check('headboard: first channel centred half a pitch from the left edge',
    near(xs[0], -widthM / 2 + nominal / 2, 0.005), xs[0]);
  check('headboard: last channel centred half a pitch from the right edge',
    near(xs[xs.length - 1], widthM / 2 - nominal / 2, 0.005), xs[xs.length - 1]);

  // Each channel is taller than it is wide (a vertical channel, not a flat
  // slab), and WIDE relative to its own share of the headboard -- reads as a
  // padded channel, not a thin pole: at least 80% of the nominal pitch,
  // leaving only a small crease between neighbours.
  const oneChannelBox = new THREE.Box3().setFromObject(channels[0]);
  const cw = oneChannelBox.max.x - oneChannelBox.min.x;
  const ch = oneChannelBox.max.y - oneChannelBox.min.y;
  check('a channel is taller than it is wide', ch > cw, { cw, ch });
  check('a channel is WIDE (at least 80% of its own pitch, not a thin pole)',
    cw >= nominal * 0.8, { cw, nominal, ratio: cw / nominal });

  // Adjacent channels are separated by only a SMALL crease -- not a wide gap
  // (a thin-pole regression would leave a gap comparable to the pole width).
  const sortedByX = channels.slice().sort((a, b) => a.position.x - b.position.x);
  const b0 = new THREE.Box3().setFromObject(sortedByX[0]);
  const b1 = new THREE.Box3().setFromObject(sortedByX[1]);
  const gap = b1.min.x - b0.max.x;
  check('adjacent channels are separated by only a small crease (< 15% of the pitch)',
    gap >= 0 && gap < nominal * 0.15, { gap, nominal });

  // The channels stand proud of the backing panel (protrude further in +z
  // than the flat backing alone).
  const backingBox = new THREE.Box3().setFromObject(headboardMeshes.find(m => !channels.includes(m)));
  const channelBox = new THREE.Box3().setFromObject(channels[0]);
  check('channels protrude beyond the flat backing panel', channelBox.max.z > backingBox.max.z + 0.001,
    { backingMaxZ: backingBox.max.z, channelMaxZ: channelBox.max.z });
}

// ---- `height` is honoured directly (no separate headboardHeight) ----------
{
  const D = Bed.DEFAULTS;
  const g = Bed.build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  const heightCm = (box.max.y - box.min.y) * 100;
  check('overall height == DEFAULTS.height (the headboard is taller than base+mattress)',
    near(heightCm, D.height, 0.5), heightCm);

  // A custom `height` is honoured exactly, not silently ignored.
  const customHeight = Object.assign({}, D, { height: 140 });
  const gCustom = Bed.build(THREE, customHeight, { detail: 'full' });
  gCustom.updateMatrixWorld(true);
  const boxCustom = new THREE.Box3().setFromObject(gCustom);
  check('a custom height=140 is honoured exactly (not ignored)',
    near((boxCustom.max.y - boxCustom.min.y) * 100, 140, 0.5),
    (boxCustom.max.y - boxCustom.min.y) * 100);

  // A `height` shorter than the base+mattress stack: the stack decides the
  // overall envelope instead (never shrinks below what the mattress needs).
  const shortHeight = Object.assign({}, D, { height: 20 });
  const g2 = Bed.build(THREE, shortHeight, { detail: 'full' });
  g2.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(g2);
  const stackTopCm = D.baseHeight + D.mattressHeight;
  check('a height shorter than the base+mattress stack does not shrink the overall height below the stack',
    (box2.max.y - box2.min.y) * 100 >= stackTopCm - 0.5,
    { builtHeightCm: (box2.max.y - box2.min.y) * 100, stackTopCm });
}

// ---- duvet toggle and low detail --------------------------------------------
{
  const D = Bed.DEFAULTS;
  const duvetColorInt = colorInt(D.duvetColor);

  const withDuvet = Bed.build(THREE, Object.assign({}, D, { duvet: true }), { detail: 'full' });
  check('duvet:true draws at least one duvet mesh', meshesByColor(withDuvet, duvetColorInt).length > 0);

  const noDuvet = Bed.build(THREE, Object.assign({}, D, { duvet: false }), { detail: 'full' });
  check('duvet:false draws no duvet mesh', meshesByColor(noDuvet, duvetColorInt).length === 0);

  // Pillow count: 2 at full detail, 0 at low.
  const pillowColorInt = colorInt(D.pillowColor);
  const full = Bed.build(THREE, Object.assign({}, D), { detail: 'full' });
  const low = Bed.build(THREE, Object.assign({}, D), { detail: 'low' });
  check('full detail draws 2 pillows', meshesByColor(full, pillowColorInt).length === 2,
    meshesByColor(full, pillowColorInt).length);
  check('low detail drops the pillows', meshesByColor(low, pillowColorInt).length === 0,
    meshesByColor(low, pillowColorInt).length);
}

// ---- pillows are at the HEADBOARD end, not the foot -------------------------
// The headboard is the furniture contract's BACK face (z=0); the head of the
// bed -- and the pillows -- belong at that small-z end, resting on the
// mattress against the headboard. A reviewer found a real bug here: pillows
// built at 192-214 cm from the headboard (i.e. at the FOOT, poking out of
// the duvet) on a 220 cm-deep bed. This check pins the fix: the pillows'
// whole z-range must sit near the headboard end and be entirely clear of the
// duvet's own z-range at the foot.
{
  const D = Bed.DEFAULTS;
  const depthCm = D.depth;
  const pillowColorInt = colorInt(D.pillowColor);
  const duvetColorInt = colorInt(D.duvetColor);
  const g = Bed.build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);

  const pillows = meshesByColor(g, pillowColorInt);
  check('found the 2 pillows for this check', pillows.length === 2, pillows.length);
  const pillowZs = pillows.map(m => new THREE.Box3().setFromObject(m));
  const pillowMinZCm = Math.min(...pillowZs.map(b => b.min.z)) * 100;
  const pillowMaxZCm = Math.max(...pillowZs.map(b => b.max.z)) * 100;

  // Near the headboard: well within the first third of the bed's depth, not
  // anywhere close to the 192-214 cm range the bug produced on this profile.
  check('pillows sit near the headboard end (whole z-range within the first third of the bed depth)',
    pillowMaxZCm < depthCm / 3, { pillowMinZCm, pillowMaxZCm, thirdCm: depthCm / 3 });
  check('pillows are NOT at the foot (nowhere near the last third of the bed depth)',
    pillowMaxZCm < depthCm * 2 / 3, { pillowMaxZCm, twoThirdsCm: depthCm * 2 / 3 });

  // Never overlaps the duvet's own z-range (which sits at the foot).
  const duvetParts = meshesByColor(g, duvetColorInt);
  check('duvet is present for this check', duvetParts.length > 0);
  const duvetBox = new THREE.Box3().setFromObject(duvetParts[0]);
  check('pillows do not overlap the duvet (poke out of it)',
    pillowMaxZCm * 0.01 <= duvetBox.min.z + 1e-6,
    { pillowMaxZCm, duvetMinZCm: duvetBox.min.z * 100 });
}

// ---- a second size still builds coherently ----------------------------------
{
  const D = Bed.DEFAULTS;
  const custom = Object.assign({}, D, { width: 137, depth: 190, channelCount: 5 });
  const g = Bed.build(THREE, custom, { detail: 'full' });
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  check('a non-default size builds to its own bbox width', near((box.max.x - box.min.x) * 100, 137, 0.5));
  check('a non-default size builds to its own bbox depth', near((box.max.z - box.min.z) * 100, 190, 0.5));
  check('back stays at z=0 for a non-default size', near(box.min.z, 0, 0.002), box.min.z);

  const headboardColorInt = colorInt(D.headboardColor);
  const channelMeshes = meshesByColor(g, headboardColorInt).filter(m => {
    const idx = m.geometry.index;
    const triCount = idx ? idx.count / 3 : m.geometry.attributes.position.count / 3;
    return triCount > 12;
  });
  check('channelCount override is honoured', channelMeshes.length === 5, channelMeshes.length);
}

// ---- colours land on distinct parts -----------------------------------------
{
  const D = Bed.DEFAULTS;
  check('headboard colour differs from mattress colour', D.headboardColor !== D.mattressColor);
  check('base colour differs from mattress colour', D.baseColor !== D.mattressColor);
  const g = Bed.build(THREE, Object.assign({}, D), { detail: 'full' });
  check('base colour actually appears on the built geometry', meshesByColor(g, colorInt(D.baseColor)).length > 0);
  check('mattress colour actually appears on the built geometry', meshesByColor(g, colorInt(D.mattressColor)).length > 0);
}

// ---- registry wiring ----------------------------------------------------------
{
  const { REGISTRY } = await imp('src/furniture/registry.js');
  check('registry: bed points at bed.js with no key (single-type module)',
    REGISTRY['bed'].path === 'bed.js' && REGISTRY['bed'].key === null, REGISTRY['bed']);
  check('registry: bed points at the BedSpec page', REGISTRY['bed'].spec === 'BedSpec');
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
