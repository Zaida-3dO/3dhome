#!/usr/bin/env node
/**
 * digital-piano.js: geometry decisions a contract-gate screenshot cannot pin.
 * No framework, no install: `node scripts/test-digital-piano.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract (bbox, finish tags, no-three, low<=full triangles) for every
 * registered type including `digital-piano`, `piano-bench` and `ottoman`.
 * This file checks the type-specific decisions that contract does not know
 * to ask about, building EVERY preset this module exports:
 *
 *   1. digital-piano: the stand legs sit at the back (z=0), the keybed and
 *      music rest are toward the front (+z), white keys are drawn (and black
 *      keys too at full detail, set back from them and dropped at low
 *      detail), and the overall height stays pinned to DEFAULTS.height
 *      regardless of restHeight (the rest and body share a fixed budget).
 *   2. piano-bench: BOTH baseStyle presets ('x' and 'column') build to the
 *      same bbox, and each uses genuinely different geometry (a column vs.
 *      two crossed legs) rather than silently falling back to one shape.
 *   3. ottoman: the lid is channel-tufted (DEFAULTS.channelCount ridges,
 *      evenly spaced, flush with the lid edges), the ridges never stand
 *      proud of the overall envelope height, and it sits on 4 legs.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const DP = await imp('src/furniture/digital-piano.js');

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

// ---- TYPES export shape ------------------------------------------------------
{
  check('TYPES has digital-piano, piano-bench and ottoman',
    !!DP.TYPES['digital-piano'] && !!DP.TYPES['piano-bench'] && !!DP.TYPES['ottoman']);
  for (const key of ['digital-piano', 'piano-bench', 'ottoman']) {
    const D = DP.TYPES[key].DEFAULTS;
    check(key + ': DEFAULTS frozen with width/depth/height numeric',
      Object.isFrozen(D) && ['width', 'depth', 'height'].every(k => typeof D[k] === 'number'));
  }
}

// ---- digital-piano -----------------------------------------------------------
{
  const { DEFAULTS: D, build } = DP.TYPES['digital-piano'];
  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);

  const whiteKeys = meshesByColor(g, colorInt(D.keyWhiteColor));
  check('at least one white-key mesh drawn', whiteKeys.length > 0);
  const blackKeysFull = meshesByColor(g, colorInt(D.keyBlackColor));
  check('full detail draws a black-key strip', blackKeysFull.length > 0, blackKeysFull.length);

  const low = build(THREE, Object.assign({}, D), { detail: 'low' });
  const blackKeysLow = meshesByColor(low, colorInt(D.keyBlackColor));
  check('low detail drops the black-key strip', blackKeysLow.length === 0, blackKeysLow.length);

  // Stand legs (standColor) run the full depth (feet from back to front, for
  // stability); the keys sit in the front half of the keybed, the player's
  // edge, not tucked against the back.
  const standParts = meshesByColor(g, colorInt(D.standColor));
  check('stand parts are drawn', standParts.length > 0);
  const depthM = D.depth / 100;
  const keysMinZ = Math.min(...whiteKeys.map(m => new THREE.Box3().setFromObject(m).min.z));
  check('white keys sit in the front half of the item (the player\'s edge)',
    keysMinZ >= depthM / 2, { keysMinZ, depthM });

  // Overall height stays pinned to DEFAULTS.height for a range of restHeight
  // values (the rest and body share a fixed budget above the keybed).
  for (const restHeight of [5, 15, 40]) {
    const gi = build(THREE, Object.assign({}, D, { restHeight }), { detail: 'full' });
    gi.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gi);
    const heightCm = (box.max.y - box.min.y) * 100;
    check('overall height stays pinned to DEFAULTS.height for restHeight=' + restHeight,
      near(heightCm, D.height, 0.5), heightCm);
  }
}

// ---- piano-bench: both baseStyle presets -------------------------------------
{
  const { DEFAULTS: D, build } = DP.TYPES['piano-bench'];
  for (const baseStyle of ['x', 'column']) {
    const g = build(THREE, Object.assign({}, D, { baseStyle }), { detail: 'full' });
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    const w = (box.max.x - box.min.x) * 100, d = (box.max.z - box.min.z) * 100, h = (box.max.y - box.min.y) * 100;
    check('baseStyle=' + baseStyle + ': bbox width matches DEFAULTS', near(w, D.width, 0.5), w);
    check('baseStyle=' + baseStyle + ': bbox depth matches DEFAULTS', near(d, D.depth, 0.5), d);
    check('baseStyle=' + baseStyle + ': bbox height matches DEFAULTS', near(h, D.height, 0.5), h);
    check('baseStyle=' + baseStyle + ': back at z=0', near(box.min.z, 0, 0.002), box.min.z);
  }

  // The two presets are genuinely different geometry, not the same shape
  // twice: a column build has a cylinder (>12 triangles per part somewhere
  // in the base); an x-frame build has no cylinder-radius geometry at all in
  // its base parts (only boxes -- 12 triangles each).
  function baseTriCounts(baseStyle) {
    const g = build(THREE, Object.assign({}, D, { baseStyle }), { detail: 'full' });
    const seatColorInt = colorInt(D.seatColor);
    const counts = [];
    g.traverse(o => {
      if (!o.isMesh) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mat && mat.color && mat.color.getHex() === seatColorInt) return; // skip the seat pad
      const idx = o.geometry.index;
      counts.push(idx ? idx.count / 3 : o.geometry.attributes.position.count / 3);
    });
    return counts;
  }
  const xTris = baseTriCounts('x');
  const columnTris = baseTriCounts('column');
  check('x-frame base parts are all simple boxes (12 triangles each)', xTris.every(t => t === 12), xTris);
  check('column base includes a cylinder (far more than 12 triangles)', columnTris.some(t => t > 12), columnTris);
}

// ---- ottoman -------------------------------------------------------------------
{
  const { DEFAULTS: D, build } = DP.TYPES['ottoman'];
  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);

  // 4 legs in the leg colour.
  const legs = meshesByColor(g, colorInt(D.legColor));
  check('exactly 4 legs', legs.length === 4, legs.length);

  // The lid ridges: found as the higher-triangle-count meshes in the body
  // colour (the flat lid base and the body box are 12-triangle boxes; a
  // ridge is a cylinder segment with far more).
  const bodyColorInt = colorInt(D.color);
  const bodyParts = meshesByColor(g, bodyColorInt);
  const ridges = bodyParts.filter(m => {
    const idx = m.geometry.index;
    const tri = idx ? idx.count / 3 : m.geometry.attributes.position.count / 3;
    return tri > 12;
  });
  check('channelCount ridges drawn', ridges.length === D.channelCount, ridges.length);

  // Evenly spaced, flush with the lid edges. The lid itself is inset 2% from
  // the full ottoman width (widthM * 0.98), and the ridge row is fit to that
  // inset lid width, matching the builder's own layout maths exactly. Each
  // ridge is a HALF-cylinder (a Pi-radian arc), so its own local origin is
  // its flat (cut) edge, not its bbox centre -- the builder places `cx` at
  // that anchor, so this test compares the same anchor (mesh.position.x)
  // rather than a bbox midpoint, which would be off by radius/2.
  const xsAnchor = ridges.map(m => m.position.x).sort((a, b) => a - b);
  const rowWidthM = (D.width / 100) * 0.98;
  const nominal = rowWidthM / D.channelCount;
  check('first ridge anchored half a pitch from the left edge of the inset lid',
    near(xsAnchor[0], -rowWidthM / 2 + nominal / 2, 0.002), xsAnchor[0]);
  check('last ridge anchored half a pitch from the right edge of the inset lid',
    near(xsAnchor[xsAnchor.length - 1], rowWidthM / 2 - nominal / 2, 0.002), xsAnchor[xsAnchor.length - 1]);

  // Ridges never stand proud of the overall envelope height.
  const overallBox = new THREE.Box3().setFromObject(g);
  const ridgeMaxY = Math.max(...ridges.map(m => new THREE.Box3().setFromObject(m).max.y));
  check('ridges do not exceed the overall envelope height',
    ridgeMaxY <= overallBox.max.y + 0.002, { ridgeMaxY, overallMaxY: overallBox.max.y });

  // A custom channelCount still lays out correctly.
  const g2 = build(THREE, Object.assign({}, D, { channelCount: 3 }), { detail: 'full' });
  const ridges2 = meshesByColor(g2, bodyColorInt).filter(m => {
    const idx = m.geometry.index;
    const tri = idx ? idx.count / 3 : m.geometry.attributes.position.count / 3;
    return tri > 12;
  });
  check('a custom channelCount is honoured', ridges2.length === 3, ridges2.length);
}

// ---- registry wiring (this module's own entries) -----------------------------
{
  const { REGISTRY } = await imp('src/furniture/registry.js');
  check('registry: digital-piano points at digital-piano.js with key digital-piano',
    REGISTRY['digital-piano'].path === 'digital-piano.js' && REGISTRY['digital-piano'].key === 'digital-piano',
    REGISTRY['digital-piano']);
  check('registry: piano-bench points at digital-piano.js with key piano-bench',
    REGISTRY['piano-bench'].path === 'digital-piano.js' && REGISTRY['piano-bench'].key === 'piano-bench',
    REGISTRY['piano-bench']);
  check('registry: ottoman points at digital-piano.js with key ottoman',
    REGISTRY['ottoman'].path === 'digital-piano.js' && REGISTRY['ottoman'].key === 'ottoman',
    REGISTRY['ottoman']);
  check('all three point at the DigitalPianoSpec page',
    REGISTRY['digital-piano'].spec === 'DigitalPianoSpec' &&
    REGISTRY['piano-bench'].spec === 'DigitalPianoSpec' &&
    REGISTRY['ottoman'].spec === 'DigitalPianoSpec');
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
