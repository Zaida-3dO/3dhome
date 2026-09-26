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
 *      vertical flutes stand proud of the backing panel, evenly spaced and
 *      flush with the panel's own edges (no wasted margin), each taller than
 *      it is wide (a vertical flute, not a lump).
 *   2. The channels are the tallest feature and set the overall envelope: at
 *      DEFAULTS a headboard shorter than the base+mattress stack still caps
 *      the item's height at max(headboardHeight, base+mattress top).
 *   3. duvet:false removes the duvet mesh (and pillow presence is unaffected
 *      by it); detail:'low' drops the pillows.
 *   4. A second size (non-default width/depth) still builds a coherent bed:
 *      channel count is preserved, and the back stays at z=0.
 *   5. Colours land on the right parts: headboard colour != mattress colour
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

  // Each channel is taller than it is wide (a vertical flute).
  const oneChannelBox = new THREE.Box3().setFromObject(channels[0]);
  const cw = oneChannelBox.max.x - oneChannelBox.min.x;
  const ch = oneChannelBox.max.y - oneChannelBox.min.y;
  check('a channel is taller than it is wide', ch > cw, { cw, ch });

  // The channels stand proud of the backing panel (protrude further in +z
  // than the flat backing alone).
  const backingBox = new THREE.Box3().setFromObject(headboardMeshes.find(m => !channels.includes(m)));
  const channelBox = new THREE.Box3().setFromObject(channels[0]);
  check('channels protrude beyond the flat backing panel', channelBox.max.z > backingBox.max.z + 0.001,
    { backingMaxZ: backingBox.max.z, channelMaxZ: channelBox.max.z });
}

// ---- overall envelope: headboard sets the height at DEFAULTS ---------------
{
  const D = Bed.DEFAULTS;
  const g = Bed.build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  const heightCm = (box.max.y - box.min.y) * 100;
  check('overall height == headboardHeight at DEFAULTS (headboard is taller than base+mattress)',
    near(heightCm, D.headboardHeight, 0.5), heightCm);

  // A shorter headboard than the base+mattress stack: the stack decides the
  // overall envelope instead.
  const shortHeadboard = Object.assign({}, D, { headboardHeight: 20 });
  const g2 = Bed.build(THREE, shortHeadboard, { detail: 'full' });
  g2.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(g2);
  const stackTopCm = D.baseHeight + D.mattressHeight;
  check('a headboard shorter than the base+mattress stack does not shrink the overall height below the stack',
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
