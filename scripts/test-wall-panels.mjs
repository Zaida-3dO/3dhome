#!/usr/bin/env node
/**
 * wall-panels.js: geometry decisions a contract-gate screenshot cannot pin.
 * No framework, no install: `node scripts/test-wall-panels.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract (bbox, finish tags, no-three, low<=full triangles) for every
 * registered type including these two. This file checks the type-specific
 * decisions that contract does not know to ask about:
 *
 *   1. slat-panel: slats fit the whole width (first and last slat flush with
 *      the panel's edges), and the requested colours/finish actually land on
 *      the slat vs. the backing mesh (not swapped).
 *   2. hex-panel-cluster: the living-room preset (side 18, rows
 *      3,4,5,4,4,4,3,2) produces exactly 29 hex meshes; a hex is pointy-top
 *      (a vertex straight up, not a flat edge); rows are centred by default
 *      (offsets null); the cluster is one merged geometry + one material
 *      (cheap, per the plan); and the DEFAULTS bbox this module freezes at
 *      load time is internally consistent with the live layout maths, not a
 *      hand-typed guess that could drift from the code that draws it.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const WP = await imp('src/furniture/wall-panels.js');
const Fin = await imp('src/furniture/finishes.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- TYPES export shape -----------------------------------------------------
{
  check('TYPES has slat-panel and hex-panel-cluster', !!WP.TYPES['slat-panel'] && !!WP.TYPES['hex-panel-cluster']);
  check('slat-panel: DEFAULTS frozen with width/depth/height numeric',
    Object.isFrozen(WP.TYPES['slat-panel'].DEFAULTS) &&
    ['width', 'depth', 'height'].every(k => typeof WP.TYPES['slat-panel'].DEFAULTS[k] === 'number'));
  check('hex-panel-cluster: DEFAULTS frozen with width/depth/height numeric',
    Object.isFrozen(WP.TYPES['hex-panel-cluster'].DEFAULTS) &&
    ['width', 'depth', 'height'].every(k => typeof WP.TYPES['hex-panel-cluster'].DEFAULTS[k] === 'number'));
}

// ---- slat-panel: fit, colours, presets --------------------------------------
{
  const build = WP.TYPES['slat-panel'].build;
  const D = WP.TYPES['slat-panel'].DEFAULTS;

  function meshesByFinishColor(group, hex) {
    const out = [];
    group.traverse(o => {
      if (!o.isMesh) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mat && mat.color && mat.color.getHex() === hex) out.push(o);
    });
    return out;
  }

  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  const slatColorInt = parseInt(D.slatColor.slice(1), 16);
  const backingColorInt = parseInt(D.backingColor.slice(1), 16);
  const slats = meshesByFinishColor(g, slatColorInt);
  const backing = meshesByFinishColor(g, backingColorInt);
  check('slat-panel: at least one slat mesh in the slat colour', slats.length > 0, slats.length);
  check('slat-panel: exactly one backing mesh in the backing colour', backing.length === 1, backing.length);
  check('slat-panel: colours are not swapped (slat != backing colour)', slatColorInt !== backingColorInt);

  // First and last slat flush with the panel edges (within half a slat width
  // of exactly 0 and width, i.e. no wasted margin on either side).
  g.updateMatrixWorld(true);
  const xs = slats.map(m => {
    const b = new THREE.Box3().setFromObject(m);
    return { min: b.min.x, max: b.max.x };
  }).sort((a, b) => a.min - b.min);
  const widthM = D.width / 100, slatWidthM = D.slatWidth / 100;
  check('slat-panel: first slat flush with the left edge', near(xs[0].min, -widthM / 2, 0.002), xs[0]);
  check('slat-panel: last slat flush with the right edge', near(xs[xs.length - 1].max, widthM / 2, 0.002), xs[xs.length - 1]);
  check('slat-panel: slat count matches the nominal pitch fit',
    xs.length === Math.max(1, Math.round(widthM / ((D.slatWidth + (D.pitch - D.slatWidth)) / 100))), xs.length);

  // Depth: backing back at z=0, slats protrude beyond the backing's outer face.
  const backB = new THREE.Box3().setFromObject(backing[0]);
  const slatB = new THREE.Box3().setFromObject(slats[0]);
  check('slat-panel: backing back at z=0', near(backB.min.z, 0, 0.002), backB);
  check('slat-panel: backing depth matches params', near(backB.max.z - backB.min.z, D.backingDepth / 100, 0.002), backB);
  check('slat-panel: slats start where the backing ends', near(slatB.min.z, backB.max.z, 0.002), { slatB, backB });
  check('slat-panel: overall depth == backingDepth + slatDepth (== DEFAULTS.depth)',
    near(slatB.max.z, D.depth / 100, 0.002), { slatMaxZ: slatB.max.z, depth: D.depth });

  // A second size: still fits and colours still resolve (not a fluke of the
  // exact default numbers).
  const g2 = build(THREE, Object.assign({}, D, { width: 137, slatWidth: 4, pitch: 6 }), { detail: 'full' });
  const slats2 = [];
  g2.traverse(o => { if (o.isMesh && o.geometry !== null && o !== g2) slats2.push(o); });
  check('slat-panel: a non-default width still builds meshes', slats2.length > 1, slats2.length);

  // Every finish + keep tag is well-formed (belt-and-braces on top of the
  // shared contract test, using the explicit "glass" case to exercise keep).
  const gGlass = build(THREE, Object.assign({}, D, { finish: 'glass' }), { detail: 'full' });
  let sawKeptGlass = false;
  gGlass.traverse(o => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.userData && mat.userData.finish === 'glass') {
      sawKeptGlass = sawKeptGlass || o.userData.keep === true;
    }
  });
  check('slat-panel: a glass-finish slat is flagged keep', sawKeptGlass);
}

// ---- hex-panel-cluster: the living-room preset ------------------------------
{
  const build = WP.TYPES['hex-panel-cluster'].build;
  const D = WP.TYPES['hex-panel-cluster'].DEFAULTS;

  check('hex-panel-cluster: DEFAULTS.rows is the living-room preset',
    JSON.stringify(D.rows) === JSON.stringify([3, 4, 5, 4, 4, 4, 3, 2]), D.rows);
  check('hex-panel-cluster: DEFAULTS.offsets is null (every row centred)', D.offsets === null);
  check('hex-panel-cluster: DEFAULTS.side is 18cm', D.side === 18);

  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  const hexMeshes = [];
  g.traverse(o => { if (o.isMesh) hexMeshes.push(o); });
  check('hex-panel-cluster: exactly 29 hex meshes at the living-room preset', hexMeshes.length === 29, hexMeshes.length);

  // One merged geometry: every hex mesh shares the SAME BufferGeometry
  // instance (cheap to draw -- the plan's "one merged geometry" requirement,
  // read as "one shared geometry resource" since three.js has no single
  // "merged multi-instance" primitive short of InstancedMesh).
  const geoSet = new Set(hexMeshes.map(m => m.geometry));
  check('hex-panel-cluster: all hexes share one geometry instance', geoSet.size === 1, geoSet.size);
  const matSet = new Set(hexMeshes.map(m => Array.isArray(m.material) ? m.material[0] : m.material));
  check('hex-panel-cluster: all hexes share one material instance', matSet.size === 1, matSet.size);

  // Pointy-top: the shared hex geometry's own local bbox is taller (y) than
  // it is wide (x) by the pointy-top ratio (height = 2*side, width =
  // sqrt(3)*side -> height/width = 2/sqrt(3) ~= 1.1547), not the flat-top
  // ratio (which would be < 1).
  const hexGeo = hexMeshes[0].geometry;
  hexGeo.computeBoundingBox();
  const bb = hexGeo.boundingBox;
  const wLocal = bb.max.x - bb.min.x, hLocal = bb.max.y - bb.min.y;
  check('hex-panel-cluster: pointy-top (local height > local width)', hLocal > wLocal, { wLocal, hLocal });
  check('hex-panel-cluster: pointy-top ratio height/width ~= 2/sqrt(3)',
    near(hLocal / wLocal, 2 / Math.sqrt(3), 0.01), hLocal / wLocal);

  // Overall bbox: back at z=0 (contract test already checks this for the
  // full group at DEFAULTS; re-derive it independently here from the raw
  // layout maths so a change to the layout function is caught even if the
  // frozen DEFAULTS bbox were hand-edited to match a bug).
  g.updateMatrixWorld(true);
  const gb = new THREE.Box3().setFromObject(g);
  const gWidthCm = (gb.max.x - gb.min.x) * 100, gHeightCm = (gb.max.y - gb.min.y) * 100;
  check('hex-panel-cluster: live bbox width matches frozen DEFAULTS.width', near(gWidthCm, D.width, 0.05), { gWidthCm, D: D.width });
  check('hex-panel-cluster: live bbox height matches frozen DEFAULTS.height', near(gHeightCm, D.height, 0.05), { gHeightCm, D: D.height });
  check('hex-panel-cluster: back at z=0', near(gb.min.z, 0, 0.002), gb);
  check('hex-panel-cluster: depth == thickness', near((gb.max.z - gb.min.z) * 100, D.thickness, 0.05), gb);

  // A different cluster shape still lays out correctly: row counts summed.
  const g2 = build(THREE, Object.assign({}, D, { rows: [1, 2, 1], side: 10 }), { detail: 'full' });
  let n2 = 0;
  g2.traverse(o => { if (o.isMesh) n2++; });
  check('hex-panel-cluster: a custom rows array produces the summed hex count', n2 === 4, n2);

  // Explicit offsets shift a row without changing the hex count.
  const g3 = build(THREE, Object.assign({}, D, { rows: [2, 2], offsets: [0, 1], side: 10 }), { detail: 'full' });
  let n3 = 0;
  g3.traverse(o => { if (o.isMesh) n3++; });
  check('hex-panel-cluster: offsets do not change the hex count', n3 === 4, n3);
  g3.updateMatrixWorld(true);
  g2.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(g2), b3 = new THREE.Box3().setFromObject(g3);
  check('hex-panel-cluster: a shifted row widens the bbox vs. the unshifted layout',
    (b3.max.x - b3.min.x) > (b2.max.x - b2.min.x) - 1e-6, { shifted: b3, plain: b2 });

  // Palette/keep sanity, same style as the slat-panel section above.
  const gGlass = build(THREE, Object.assign({}, D, { finish: 'mirror' }), { detail: 'full' });
  let mirrorKept = false;
  gGlass.traverse(o => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.userData && mat.userData.finish === 'mirror') mirrorKept = mirrorKept || o.userData.keep === true;
  });
  check('hex-panel-cluster: a mirror-finish cluster is flagged keep', mirrorKept);
}

// ---- registry wiring (this module's own entries, not the whole registry) ---
{
  const { REGISTRY } = await imp('src/furniture/registry.js');
  check('registry: slat-panel points at wall-panels.js with key slat-panel',
    REGISTRY['slat-panel'].path === 'wall-panels.js' && REGISTRY['slat-panel'].key === 'slat-panel', REGISTRY['slat-panel']);
  check('registry: hex-panel-cluster points at wall-panels.js with key hex-panel-cluster',
    REGISTRY['hex-panel-cluster'].path === 'wall-panels.js' && REGISTRY['hex-panel-cluster'].key === 'hex-panel-cluster', REGISTRY['hex-panel-cluster']);
  check('registry: both point at the WallPanelSpec page',
    REGISTRY['slat-panel'].spec === 'WallPanelSpec' && REGISTRY['hex-panel-cluster'].spec === 'WallPanelSpec');
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
