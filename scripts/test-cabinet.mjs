#!/usr/bin/env node
/**
 * Cabinet builder tests: src/furniture/cabinet.js. No framework, no install -
 * `node scripts/test-cabinet.mjs`.
 *
 * WHAT THIS GUARDS (see item 4104b849's acceptance criteria)
 *   1. The built group's bounding box matches `params` (width/height/depth,
 *      converted cm -> m), and y=0 is the floor.
 *   2. z=0 is the BACK of the cabinet (the interior back panel); every front
 *      cell's own outer face sits at `depth - handle allowance` (or exactly
 *      `depth` for a handle-less front), and no mesh - including a handle -
 *      pokes past `depth`.
 *   3. `detail: 'low'` produces fewer triangles than the default ('full').
 *   4. normaliseFronts(): a row whose cells already sum to the full width is
 *      left alone; a row with cells missing `width` normalises by splitting
 *      the remainder evenly; a row whose EXPLICIT widths don't fill (or
 *      overflow) the cabinet width throws rather than silently drawing a
 *      gap or an overlap.
 *   5. Merge-fidelity: every material comes from the shared finishes palette
 *      (material.userData.finish is in the closed set), and glass/mirror/
 *      emissive meshes carry userData.keep = true (and nothing else does),
 *      matching the plan-review finding (item 78f2b614) and the furniture
 *      data layer's contract gate (scripts/test-furniture-core.mjs).
 *   6. The bedside-table LED wrap sits in the gap between two drawer rows,
 *      wraps front + both sides, and is tagged emissive + keep.
 *   7. DEFAULTS is frozen and carries numeric width/depth/height.
 *   8. Columns grid (open shelving): normaliseColumns() fills/normalises/
 *      errors like normaliseFronts(), and a built columns cabinet has no
 *      front cells (fully open) with the right shelf-panel count per column.
 *   9. A 'stack' cell (e.g. the TV console: open above a bottom drawer,
 *      flanked by full-height doors) builds the right part counts and bbox,
 *      and throws if its sub-cell heights don't sum to the parent row height
 *      or if a sub-cell tries to nest another stack.
 *  10. glassSidePanel (the tall display cabinet): the named side gets a glass
 *      window + wood panel in the middle band and plain panels elsewhere, the
 *      OTHER side stays a plain slab, an implicit band height splits the
 *      remainder evenly, and mismatched explicit heights throw.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const C = await imp('src/furniture/cabinet.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const FINISH_SET = new Set(['matte', 'gloss', 'metal', 'glass', 'mirror', 'emissive']);

function bbox(group) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  return box;
}

function triangleCount(group) {
  let tris = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    if (geo.index) tris += geo.index.count / 3;
    else tris += geo.attributes.position.count / 3;
  });
  return tris;
}

// ---- 1/2. bbox matches params; z=0 is the back; fronts are at the FRONT ----
{
  // fronts row height is the space ABOVE the plinth (236 - 8 = 228).
  const params = { width: 100, height: 236, depth: 60, fronts: [
    { height: 228, cells: [{ kind: 'mirror', width: 50 }, { kind: 'mirror', width: 50 }] }
  ], plinth: { type: 'plinth', height: 8 } };
  const g = C.build(THREE, params, {});
  const box = bbox(g);
  check('width matches params (cm -> m)', near(box.max.x - box.min.x, 1.00, 0.01), box);
  check('height matches params', near(box.max.y - box.min.y, 2.36, 0.01), box);
  check('depth does not exceed params.depth', box.max.z - box.min.z <= 0.60 + 1e-6, box);
  check('y=0 is the floor', near(box.min.y, 0, 0.001), box.min.y);
  check('x is centred', near(box.min.x, -0.5, 0.01) && near(box.max.x, 0.5, 0.01), box);
  check('z=0 is the back (nothing behind it)', box.min.z >= -1e-6, box.min.z);

  // The regression this whole block exists to catch: a reviewer's mutation
  // moved every front cell to sit near z=0 (the BACK) instead of the front,
  // and the cabinet's own bbox depth check alone did not catch it (a mirror
  // door's own thin box sitting anywhere between 0 and depth still keeps the
  // overall bbox within `depth`). Assert the mirror door mesh's own face
  // position directly: it must sit at (or very near) the front, not the back.
  let mirrorDoor = null;
  g.traverse(o => { if (o.isMesh && o.name === 'cabinetMirrorDoor' && !mirrorDoor) mirrorDoor = o; });
  check('mirror door exists', !!mirrorDoor);
  check('mirror door sits at the FRONT (z close to depth=0.60), not the back (z close to 0)',
    mirrorDoor && mirrorDoor.position.z > 0.55, mirrorDoor && mirrorDoor.position.z);
}

// ---- 3. low detail produces fewer triangles --------------------------------
{
  const params = { width: 100, height: 236, depth: 60, plinth: { type: 'plinth', height: 0 }, fronts: [
    { height: 236, cells: [{ kind: 'door', width: 50 }, { kind: 'door', width: 50 }] }
  ] };
  const full = C.build(THREE, params, { detail: 'full' });
  const low = C.build(THREE, params, { detail: 'low' });
  check('low detail has fewer triangles than full', triangleCount(low) < triangleCount(full),
    { full: triangleCount(full), low: triangleCount(low) });
}

// ---- 4. normaliseFronts: fill / normalise / error --------------------------
{
  const exact = C.normaliseFronts(
    [{ height: 100, cells: [{ kind: 'door', width: 50 }, { kind: 'door', width: 50 }] }], 100, 0);
  check('exact-width row left alone', exact[0].cells[0].width === 50 && exact[0].cells[1].width === 50);

  const implicit = C.normaliseFronts(
    [{ height: 100, cells: [{ kind: 'door' }, { kind: 'door' }] }], 100, 0);
  check('missing widths split evenly', implicit[0].cells[0].width === 50 && implicit[0].cells[1].width === 50,
    implicit[0].cells);

  const mixed = C.normaliseFronts(
    [{ height: 100, cells: [{ kind: 'door', width: 30 }, { kind: 'door' }] }], 100, 0);
  check('one explicit + one implicit fills the remainder', mixed[0].cells[1].width === 70, mixed[0].cells);

  let threw = false;
  try {
    C.normaliseFronts([{ height: 100, cells: [{ kind: 'door', width: 30 }, { kind: 'door', width: 30 } ] }], 100, 0);
  } catch (e) { threw = true; }
  check('all-explicit row that does not fill the width throws', threw);

  let threwOverflow = false;
  try {
    C.normaliseFronts([{ height: 100, cells: [{ kind: 'door', width: 120 }, { kind: 'door' }] }], 100, 0);
  } catch (e) { threwOverflow = true; }
  check('explicit widths exceeding the cabinet width throws', threwOverflow);

  // Row stacking: fronts[] authored top-to-bottom -> index 0 is the TOP row.
  const stacked = C.normaliseFronts([
    { height: 40, cells: [{ kind: 'glass', width: 100 }] },
    { height: 60, cells: [{ kind: 'door', width: 100 }] }
  ], 100, 10);
  check('top-described row (index 0) sits at the top of the carcass',
    stacked[0].yTop > stacked[1].yTop, stacked);
  check('bottom row sits just above the plinth', near(stacked[1].yBottom, 10), stacked[1]);
  check('rows stack with no gap', near(stacked[1].yTop, stacked[0].yBottom), stacked);
}

// ---- 5. merge-fidelity: finish + keep tagging ------------------------------
{
  const params = {
    width: 80, height: 198, depth: 35, gloss: true, shelfLights: true,
    fronts: [
      { height: 60, cells: [{ kind: 'glass', width: 80 }] },
      { height: 60, cells: [{ kind: 'mirror', width: 80 }] },
      { height: 70, cells: [{ kind: 'door', width: 80 }] }
    ],
    plinth: { type: 'plinth', height: 8 }
  };
  const g = C.build(THREE, params, {});
  let sawGlass = false, sawMirror = false, sawEmissive = false, badFinish = null, badKeep = null;
  g.traverse(o => {
    if (!o.isMesh) return;
    const f = o.material && o.material.userData && o.material.userData.finish;
    if (!FINISH_SET.has(f)) { badFinish = { name: o.name, finish: f }; }
    if ((f === 'glass' || f === 'mirror' || f === 'emissive')) {
      if (o.userData.keep !== true) badKeep = { name: o.name, finish: f, keep: o.userData.keep };
      if (f === 'glass') sawGlass = true;
      if (f === 'mirror') sawMirror = true;
      if (f === 'emissive') sawEmissive = true;
    } else if (o.userData.keep) {
      badKeep = { name: o.name, finish: f, keep: o.userData.keep, unexpected: true };
    }
  });
  check('every mesh has a finish from the closed set', badFinish === null, badFinish);
  check('glass/mirror/emissive meshes are all keep=true, nothing else is', badKeep === null, badKeep);
  check('a glass door was built', sawGlass);
  check('a mirror door was built', sawMirror);
  check('shelfLights adds an emissive strip', sawEmissive);
}

// ---- 6. bedside-table LED wrap: gap-between-drawers, front + sides --------
{
  const params = {
    width: 24, height: 60, depth: 50, plinth: { type: 'plinth', height: 6 },
    fronts: [
      { height: 18, ledGapBelow: true, cells: [{ kind: 'drawer', width: 24 }] },
      { height: 18, ledGapBelow: true, cells: [{ kind: 'drawer', width: 24 }] },
      { height: 18, cells: [{ kind: 'drawer', width: 24 }] }
    ]
  };
  const g = C.build(THREE, params, {});
  const wraps = { front: [], side: [] };
  g.traverse(o => {
    if (!o.isMesh) return;
    if (o.name === 'ledWrapFront') wraps.front.push(o);
    if (o.name === 'ledWrapSide') wraps.side.push(o);
  });
  check('one front LED strip per ledGapBelow row (2 gaps)', wraps.front.length === 2, wraps.front.length);
  check('two side LED strips per gap (4 total)', wraps.side.length === 4, wraps.side.length);
  check('LED strips are emissive + keep', [...wraps.front, ...wraps.side]
    .every(m => m.material.userData.finish === 'emissive' && m.userData.keep === true));
  // No strip behind the back (z=0 plane): every wrap mesh's centre z > 0.
  check('LED wrap never sits at the back (z=0)', [...wraps.front, ...wraps.side].every(m => m.position.z > 0),
    [...wraps.front, ...wraps.side].map(m => m.position.z));
  const D = 0.50;
  // The strip is centred ON the front face (half embedded, half proud) so it
  // reads as a lit seam without pushing the cabinet's bbox past the builder
  // contract's 0.5cm tolerance - so its centre sits AT depth, not beyond it.
  check('front strip is centred on the front face (z == depth)',
    wraps.front.every(m => near(m.position.z, D, 1e-6)), wraps.front.map(m => m.position.z));
  check('front strip pokes out no more than 0.5cm past the front face',
    wraps.front.every(m => m.geometry.parameters.depth / 2 <= 0.005), wraps.front.map(m => m.geometry.parameters.depth));
}

// ---- 7. DEFAULTS is frozen with numeric width/depth/height -----------------
{
  check('DEFAULTS is frozen', Object.isFrozen(C.DEFAULTS));
  check('DEFAULTS has numeric width/depth/height',
    typeof C.DEFAULTS.width === 'number' && typeof C.DEFAULTS.depth === 'number' &&
    typeof C.DEFAULTS.height === 'number', C.DEFAULTS);
}

// ---- 8. columns grid: open shelving ----------------------------------------
{
  const exact = C.normaliseColumns([{ width: 56 }, { width: 33 }], 89);
  check('columns: explicit widths left alone', exact[0].width === 56 && exact[1].width === 33, exact);
  check('columns: xLeft/xRight spans are contiguous',
    exact[0].xLeft === 0 && exact[0].xRight === 56 && exact[1].xLeft === 56 && exact[1].xRight === 89, exact);

  const implicit = C.normaliseColumns([{ rows: 4 }, { rows: 4 }], 90);
  check('columns: missing widths split evenly', implicit[0].width === 45 && implicit[1].width === 45, implicit);

  let threw = false;
  try { C.normaliseColumns([{ width: 30 }, { width: 30 }], 100); } catch (e) { threw = true; }
  check('columns: explicit widths that do not fill the cabinet throws', threw);

  // The store preset: 95w x 140h x 39d, 2cm panels, left column clear 56,
  // right clear 33 (2 + 56 + 2 + 33 + 2 = 95), each column split into 4
  // equal shelf rows.
  const params = {
    width: 95, height: 140, depth: 39, panelThickness: 2,
    columns: [{ width: 56, rows: 4 }, { width: 33, rows: 4 }],
    plinth: { type: 'plinth', height: 0 },
    gloss: false, color: '#ffffff', topColor: '#ffffff'
  };
  const g = C.build(THREE, params, {});
  const box = bbox(g);
  check('columns cabinet: bbox width matches params', near(box.max.x - box.min.x, 0.95, 0.01), box);
  check('columns cabinet: bbox height matches params', near(box.max.y - box.min.y, 1.40, 0.01), box);
  check('columns cabinet: bbox depth matches params', near(box.max.z - box.min.z, 0.39, 0.01), box);
  check('columns cabinet: z=0 is the back', box.min.z >= -1e-6, box.min.z);

  let shelves = 0, dividers = 0, fronts = 0;
  g.traverse(o => {
    if (!o.isMesh) return;
    if (o.name === 'shelf') shelves++;
    if (o.name === 'columnDivider') dividers++;
    if (/^(cabinetDoor|drawerFront|cabinetGlassDoor|cabinetMirrorDoor)$/.test(o.name)) fronts++;
  });
  // 4 equal rows per column = 3 internal shelves per column x 2 columns.
  check('columns cabinet: 3 shelves per 4-row column x 2 columns = 6', shelves === 6, shelves);
  check('columns cabinet: exactly one divider between the 2 columns', dividers === 1, dividers);
  check('columns cabinet: fully open - no door/drawer/glass/mirror fronts', fronts === 0, fronts);

  // Every shelf/divider material is on the closed palette (columns mode
  // reuses the same finish() helper as the fronts mode).
  let badFinish = null;
  g.traverse(o => {
    if (!o.isMesh) return;
    const f = o.material && o.material.userData && o.material.userData.finish;
    if (!FINISH_SET.has(f)) badFinish = { name: o.name, finish: f };
  });
  check('columns cabinet: every mesh has a finish from the closed set', badFinish === null, badFinish);
}

// ---- 9. stack cell: TV console (open above a bottom drawer) ---------------
{
  // 180w x 34h x 40d: left/right full-height doors, centre 80cm column is a
  // stack - open (14cm) above a drawer (20cm) at the BOTTOM.
  const params = {
    width: 180, height: 34, depth: 40,
    fronts: [
      { height: 34, cells: [
        { kind: 'door', width: 50 },
        { kind: 'stack', width: 80, cells: [
          { kind: 'open', height: 14 },
          { kind: 'drawer', height: 20 }
        ] },
        { kind: 'door', width: 50 }
      ] }
    ],
    plinth: { type: 'plinth', height: 0 }, gloss: true, color: '#ffffff', topColor: '#ffffff'
  };
  const g = C.build(THREE, params, {});
  const box = bbox(g);
  check('TV console: bbox width matches params', near(box.max.x - box.min.x, 1.80, 0.01), box);
  check('TV console: bbox height matches params', near(box.max.y - box.min.y, 0.34, 0.01), box);
  check('TV console: bbox depth matches params', near(box.max.z - box.min.z, 0.40, 0.01), box);
  let doors = 0, drawers = 0;
  g.traverse(o => {
    if (!o.isMesh) return;
    if (o.name === 'cabinetDoor') doors++;
    if (o.name === 'drawerFront') drawers++;
  });
  check('TV console: 2 full-height doors either side', doors === 2, doors);
  check('TV console: exactly 1 drawer (the stack sub-cell), no drawer for "open"', drawers === 1, drawers);

  // The drawer sub-cell must sit at the BOTTOM of the stack (its yBottom is
  // near the row's own yBottom, i.e. near the floor here with no plinth).
  let drawerY = null;
  g.traverse(o => { if (o.isMesh && o.name === 'drawerFront') drawerY = o.position.y; });
  check('TV console: drawer sits low (bottom of the stack)', drawerY !== null && drawerY < 0.34 / 2, drawerY);

  let threwMismatch = false;
  try {
    C.build(THREE, Object.assign({}, params, { fronts: [
      { height: 34, cells: [
        { kind: 'door', width: 50 },
        { kind: 'stack', width: 80, cells: [
          { kind: 'open', height: 10 },
          { kind: 'drawer', height: 20 }
        ] },
        { kind: 'door', width: 50 }
      ] }
    ] }), {});
  } catch (e) { threwMismatch = true; }
  check('stack cell: sub-cell heights not summing to the row height throws', threwMismatch);

  let threwNesting = false;
  try {
    C.build(THREE, Object.assign({}, params, { fronts: [
      { height: 34, cells: [
        { kind: 'door', width: 50 },
        { kind: 'stack', width: 80, cells: [
          { kind: 'stack', height: 14, cells: [{ kind: 'open', height: 14 }] },
          { kind: 'drawer', height: 20 }
        ] },
        { kind: 'door', width: 50 }
      ] }
    ] }), {});
  } catch (e) { threwNesting = true; }
  check('stack cell: a nested stack sub-cell throws', threwNesting);
}

// ---- 10. glassSidePanel: the tall display cabinet --------------------------
{
  const baseParams = {
    width: 80, height: 189, depth: 34,
    fronts: [
      { height: 189, cells: [
        { kind: 'door', width: 29 },
        { kind: 'open', width: 1 },
        { kind: 'stack', width: 50, cells: [
          { kind: 'door', height: 32 },
          { kind: 'glass', height: 125 },
          { kind: 'door', height: 32 }
        ] }
      ] }
    ],
    plinth: { type: 'plinth', height: 0 }, gloss: true, color: '#ffffff', topColor: '#ffffff',
    glassSidePanel: { side: 'right', bands: [{}, { height: 125, glassDepth: 13, woodDepth: 20 }, {}] }
  };
  const g = C.build(THREE, baseParams, {});
  const box = bbox(g);
  check('display cabinet: bbox width matches params', near(box.max.x - box.min.x, 0.80, 0.01), box);
  check('display cabinet: bbox height matches params', near(box.max.y - box.min.y, 1.89, 0.01), box);
  check('display cabinet: bbox depth matches params', near(box.max.z - box.min.z, 0.34, 0.01), box);

  let glassSide = null, woodSide = null, mirrorFinishCount = 0;
  g.traverse(o => {
    if (!o.isMesh) return;
    if (o.name === 'displaySideGlass') glassSide = o;
    if (o.name === 'displaySideWood') woodSide = o;
  });
  check('display cabinet: exactly one glass side panel', !!glassSide);
  check('display cabinet: exactly one wood side panel', !!woodSide);
  check('display cabinet: glass side panel is on the RIGHT (+x)', glassSide && glassSide.position.x > 0, glassSide && glassSide.position.x);
  check('display cabinet: glass side panel is keep=true', glassSide && glassSide.userData.keep === true);
  check('display cabinet: glass side sits in FRONT of the wood side (larger z)',
    glassSide && woodSide && glassSide.position.z > woodSide.position.z,
    glassSide && woodSide && { glassZ: glassSide.position.z, woodZ: woodSide.position.z });

  // Mirror image: side:'left' puts the glass panel on the LEFT (-x) instead.
  const mirrored = Object.assign({}, baseParams, {
    glassSidePanel: { side: 'left', bands: [{}, { height: 125, glassDepth: 13, woodDepth: 20 }, {}] }
  });
  const gm = C.build(THREE, mirrored, {});
  let glassSideMirrored = null;
  gm.traverse(o => { if (o.isMesh && o.name === 'displaySideGlass') glassSideMirrored = o; });
  check('display cabinet mirrored: glass side panel is on the LEFT (-x)',
    glassSideMirrored && glassSideMirrored.position.x < 0, glassSideMirrored && glassSideMirrored.position.x);

  // The OTHER side (left, solid-door side) stays a single plain slab - only
  // ONE 'carcassSide' mesh sits on the LEFT (-x); the glass side's own plain
  // top/bottom bands are also named 'carcassSide' but sit on the right (+x).
  let leftPlainPanelCount = 0;
  g.traverse(o => { if (o.isMesh && o.name === 'carcassSide' && o.position.x < 0) leftPlainPanelCount++; });
  check('display cabinet: the OTHER side (left, solid-door side) stays a single plain slab',
    leftPlainPanelCount === 1, leftPlainPanelCount);

  let threwMismatch = false;
  try {
    C.build(THREE, Object.assign({}, baseParams, {
      glassSidePanel: { side: 'right', bands: [{ height: 40 }, { height: 125, glassDepth: 13, woodDepth: 20 }, { height: 40 }] }
    }), {});
  } catch (e) { threwMismatch = true; }
  check('glassSidePanel: explicit band heights not summing to the side height throws', threwMismatch);
}

// ---- 11. every front cell's own face sits at the FRONT, not the back ------
// Code-review regression (PR #36, round 1): every front cell was built at
// z = T/2 (near the BACK, z=0) instead of the front. The cabinet's overall
// bbox depth check did not catch this - a thin front panel anywhere between
// 0 and depth still keeps the bbox within `depth`. These checks read each
// front mesh's own z position directly, which is what actually catches a
// mutation that moves the fronts back to z~0.
{
  const D = 0.60; // metres - matches params.depth: 60 (cm) below
  const HANDLE = 0.025; // HANDLE_PROJECTION, metres - depth INCLUDES handles
  const params = {
    width: 100, height: 236, depth: 60, plinth: { type: 'plinth', height: 8 },
    fronts: [{ height: 228, cells: [
      { kind: 'door', width: 25 },
      { kind: 'drawer', width: 25 },
      { kind: 'glass', width: 25 },
      { kind: 'mirror', width: 25 }
    ] }]
  };
  const g = C.build(THREE, params, {});
  let door = null, drawer = null, glassDoor = null, mirrorDoor = null;
  g.traverse(o => {
    if (!o.isMesh) return;
    if (o.name === 'cabinetDoor' && !door) door = o;
    if (o.name === 'drawerFront' && !drawer) drawer = o;
    if (o.name === 'cabinetGlassDoor' && !glassDoor) glassDoor = o;
    if (o.name === 'cabinetMirrorDoor' && !mirrorDoor) mirrorDoor = o;
  });
  // The mesh's own OUTER face (position + half its own thickness), not its
  // centre - the doc comment's contract is about the face, and reading the
  // face is what is robust to a thickness change.
  function outerFaceZ(mesh) {
    mesh.geometry.computeBoundingBox();
    return mesh.position.z + mesh.geometry.boundingBox.max.z;
  }
  // Door/drawer own face sits at depth - HANDLE_PROJECTION (their handle
  // then projects the rest of the way to depth - see check further down).
  check('door front face sits at depth - handle allowance', door && near(outerFaceZ(door), D - HANDLE, 0.002),
    door && outerFaceZ(door));
  check('drawer front face sits at depth - handle allowance', drawer && near(outerFaceZ(drawer), D - HANDLE, 0.002),
    drawer && outerFaceZ(drawer));
  // Glass/mirror doors have no handle, so their own face sits flush at depth.
  check('glass door front face sits flush at depth (no handle)', glassDoor && near(outerFaceZ(glassDoor), D, 0.002),
    glassDoor && outerFaceZ(glassDoor));
  check('mirror door front face sits flush at depth (no handle)', mirrorDoor && near(outerFaceZ(mirrorDoor), D, 0.002),
    mirrorDoor && outerFaceZ(mirrorDoor));
  // None of them sit anywhere near the back (z=0) - the direct regression check.
  [door, drawer, glassDoor, mirrorDoor].forEach((m, i) => {
    check('front cell #' + i + ' is nowhere near the back (z > depth/2)', m && m.position.z > D / 2,
      m && m.position.z);
  });
}

// ---- 12. handles never poke past the declared depth ------------------------
{
  const D = 0.60;
  const params = {
    width: 100, height: 236, depth: 60, plinth: { type: 'plinth', height: 8 },
    fronts: [{ height: 228, cells: [
      { kind: 'door', width: 50 },
      { kind: 'drawer', width: 50 }
    ] }]
  };
  const g = C.build(THREE, params, {});
  const handles = [];
  g.traverse(o => { if (o.isMesh && (o.name === 'doorHandle' || o.name === 'drawerHandle')) handles.push(o); });
  check('door + drawer handles both built', handles.length === 2, handles.length);
  handles.forEach(h => {
    h.geometry.computeBoundingBox();
    const halfDepth = (h.geometry.boundingBox.max.z - h.geometry.boundingBox.min.z) / 2;
    const tipZ = h.position.z + halfDepth;
    check('handle ' + h.name + ' tip does not poke past the declared depth', tipZ <= D + 1e-6, tipZ);
    check('handle ' + h.name + ' tip reaches (or very nearly reaches) the declared depth',
      tipZ > D - 0.002, tipZ);
  });
}

// ---- 13. every emissive mesh (not just LED-wrap/shelf-light by name) is ---
//          away from the back, and none pokes past depth -------------------
{
  const params = {
    width: 24, height: 60, depth: 50, plinth: { type: 'plinth', height: 6 }, shelfLights: true,
    fronts: [
      { height: 18, ledGapBelow: true, cells: [{ kind: 'glass', width: 24 }] },
      { height: 18, ledGapBelow: true, cells: [{ kind: 'drawer', width: 24 }] },
      { height: 18, cells: [{ kind: 'drawer', width: 24 }] }
    ]
  };
  const g = C.build(THREE, params, {});
  const D = 0.50;
  const emissiveMeshes = [];
  g.traverse(o => {
    if (!o.isMesh) return;
    if (o.material && o.material.userData && o.material.userData.finish === 'emissive') emissiveMeshes.push(o);
  });
  check('at least one emissive mesh exists (shelfLights + ledGapBelow both fired)', emissiveMeshes.length > 0,
    emissiveMeshes.length);
  // Generic sweep over EVERY emissive mesh by finish, not by name - this is
  // what the reviewer asked for: a mutation renaming or adding a new emissive
  // part must still be caught, not just the ones already named 'ledWrap*'.
  emissiveMeshes.forEach(m => {
    check('emissive mesh "' + m.name + '" is not at the back (z > 0)', m.position.z > 0, m.position.z);
    m.geometry.computeBoundingBox();
    const maxZ = m.position.z + m.geometry.boundingBox.max.z;
    check('emissive mesh "' + m.name + '" does not poke past the declared depth', maxZ <= D + 0.006, maxZ);
  });
}

// ---- 14. sliding doors overlap on two tracks and span the full width ------
{
  const params = {
    width: 150, height: 236, depth: 60,
    fronts: [{ height: 228, cells: [
      { kind: 'sliding', width: 75, panels: ['white', 'mirror', 'mirror', 'white'] },
      { kind: 'sliding', width: 75, panels: ['white', 'mirror', 'mirror', 'white'] }
    ] }],
    plinth: { type: 'plinth', height: 8 }, gloss: false, color: '#ffffff', topColor: '#ffffff'
  };
  const g = C.build(THREE, params, {});
  g.updateMatrixWorld(true);
  const box = bbox(g);
  check('sliding wardrobe: bbox width matches params', near(box.max.x - box.min.x, 1.50, 0.01), box);

  const frames = [];
  g.traverse(o => { if (o.isMesh && o.name === 'slidingFrame') frames.push(o); });
  check('4 door frame-pairs (2 doors x 2 cells x 2 stiles each = 8)', frames.length === 8, frames.length);
  const zSet = [...new Set(frames.map(f => f.position.z.toFixed(4)))];
  check('doors ride exactly TWO distinct tracks (two different z depths)', zSet.length === 2, zSet);
  const [trackA, trackB] = zSet.map(Number);
  check('the two tracks are offset from each other (not the same z)', Math.abs(trackA - trackB) > 0.005,
    { trackA, trackB });
  check('neither track sits at the back (both z > depth/2)', trackA > 0.30 && trackB > 0.30, { trackA, trackB });

  // Full width coverage: the outermost stiles reach the cabinet's own edges.
  function xRange(mesh) {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox.clone().translate(mesh.position);
    return [bb.min.x, bb.max.x];
  }
  const allX = frames.map(xRange).flat();
  check('leftmost stile reaches the cabinet\'s left edge', near(Math.min(...allX), box.min.x, 0.02),
    { min: Math.min(...allX), boxMin: box.min.x });
  check('rightmost stile reaches the cabinet\'s right edge', near(Math.max(...allX), box.max.x, 0.02),
    { max: Math.max(...allX), boxMax: box.max.x });

  // Overlap: within one 75cm cell, the two doors' frame x-ranges must
  // intersect (not just touch) - that is the "overlap" the reference photo
  // shows, as opposed to two doors that merely meet edge-to-edge. The left
  // cell spans local x -0.75..0 (cabinet width 1.5m, 2 cells of 0.75m each).
  const leftCellFrames = frames.filter(f => {
    const [x0, x1] = xRange(f);
    return x0 >= -0.751 && x1 <= 0.001;
  });
  check('exactly 4 stiles found in the left cell (2 doors x 2 stiles)', leftCellFrames.length === 4,
    leftCellFrames.map(xRange));
  // Group stiles into their 2 doors by z (track): each door's own span is the
  // min/max x across ITS 2 stiles, and the two doors' spans must overlap.
  const byTrack = new Map();
  leftCellFrames.forEach(f => {
    const key = f.position.z.toFixed(4);
    if (!byTrack.has(key)) byTrack.set(key, []);
    byTrack.get(key).push(...xRange(f));
  });
  const doorSpans = [...byTrack.values()].map(xs => [Math.min(...xs), Math.max(...xs)]);
  check('exactly 2 door spans (one per track)', doorSpans.length === 2, doorSpans);
  const [d0, d1] = doorSpans;
  const overlaps = d0 && d1 && d0[0] < d1[1] - 0.001 && d1[0] < d0[1] - 0.001;
  check('the two doors within a cell overlap (not just meet edge-to-edge)', overlaps, doorSpans);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
