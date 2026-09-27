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
// A real margin off the back plane (z=0), not just `z > 0` - a mesh sitting
// a fraction of a millimetre off the back panel would pass a bare `> 0`
// check while still being visually "at the back".
const BACK_MARGIN = 0.01;

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
  // No strip behind (or right at) the back plane - a real margin, not just
  // z > 0, so a mutation that puts a strip a fraction of a mm off the back
  // panel still trips this.
  check('LED wrap never sits near the back (z > margin)',
    [...wraps.front, ...wraps.side].every(m => m.position.z > BACK_MARGIN),
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
  // Code-review round 2: every hinged/fixed front shares ONE common face
  // plane - a cabinet WITH handles (the default) puts door/drawer/glass/
  // mirror all at depth - HANDLE_PROJECTION (their handle then projects the
  // rest of the way to depth), so a glass section never pokes past (or sits
  // behind) the solid door bands of the same front.
  check('door front face sits at depth - handle allowance', door && near(outerFaceZ(door), D - HANDLE, 0.002),
    door && outerFaceZ(door));
  check('drawer front face sits at depth - handle allowance', drawer && near(outerFaceZ(drawer), D - HANDLE, 0.002),
    drawer && outerFaceZ(drawer));
  // A glass or mirror front's FRAME (its stiles) is what lies in the plane,
  // 2 mm behind it (FRAME_BACKSET), and the pane sits 3 mm behind the frame
  // (PANE_RECESS): the pane used to lie IN the stiles' plane and z-fight
  // with them (item 19c25304). So: frame within 2.5 mm of the plane, pane
  // within 1 cm of it and at least 1 mm behind its own frame.
  const frames = [];
  g.traverse(o => { if (o.isMesh && o.name === 'cabinetDoorFrame') frames.push(o); });
  check('glass/mirror frames exist (2 stiles per cell)', frames.length === 4, frames.length);
  check('glass/mirror frame stiles lie in the shared front plane (within 2.5 mm)',
    frames.length && frames.every(f => near(outerFaceZ(f), D - HANDLE, 0.0025)), frames.map(outerFaceZ));
  check('glass door pane sits just behind the shared front plane (<= 1 cm)',
    glassDoor && outerFaceZ(glassDoor) < D - HANDLE && outerFaceZ(glassDoor) > D - HANDLE - 0.01, glassDoor && outerFaceZ(glassDoor));
  check('mirror door pane sits just behind the shared front plane (<= 1 cm)',
    mirrorDoor && outerFaceZ(mirrorDoor) < D - HANDLE && outerFaceZ(mirrorDoor) > D - HANDLE - 0.01, mirrorDoor && outerFaceZ(mirrorDoor));
  check('every pane is at least 1 mm behind every stile face (no shared plane)',
    frames.length && [glassDoor, mirrorDoor].every(pn => pn && frames.every(f => outerFaceZ(f) - outerFaceZ(pn) >= 0.001)));
  // None of them sit anywhere near the back (z=0) - the direct regression check.
  [door, drawer, glassDoor, mirrorDoor].forEach((m, i) => {
    check('front cell #' + i + ' is nowhere near the back (z > depth/2)', m && m.position.z > D / 2,
      m && m.position.z);
  });

  // A fully handleless cabinet (the chest of drawers preset) puts EVERY
  // front flush at depth instead - no clearance is needed when nothing on
  // the whole cabinet has a handle.
  const paramsNoHandles = Object.assign({}, params, { handles: false });
  const gnh = C.build(THREE, paramsNoHandles, {});
  let doorNH = null, drawerNH = null, glassNH = null, mirrorNH = null;
  gnh.traverse(o => {
    if (!o.isMesh) return;
    if (o.name === 'cabinetDoor' && !doorNH) doorNH = o;
    if (o.name === 'drawerFront' && !drawerNH) drawerNH = o;
    if (o.name === 'cabinetGlassDoor' && !glassNH) glassNH = o;
    if (o.name === 'cabinetMirrorDoor' && !mirrorNH) mirrorNH = o;
  });
  [['door', doorNH], ['drawer', drawerNH]].forEach(([name, m]) => {
    check('handleless cabinet: ' + name + ' front sits flush at depth', m && near(outerFaceZ(m), D, 0.002),
      m && outerFaceZ(m));
  });
  [['glass', glassNH], ['mirror', mirrorNH]].forEach(([name, m]) => {
    check('handleless cabinet: ' + name + ' pane sits just behind depth (<= 1 cm)', m && outerFaceZ(m) < D && outerFaceZ(m) > D - 0.01,
      m && outerFaceZ(m));
  });
  let handleCount = 0;
  gnh.traverse(o => { if (o.isMesh && (o.name === 'doorHandle' || o.name === 'drawerHandle')) handleCount++; });
  check('handleless cabinet: no handle meshes built at all', handleCount === 0, handleCount);
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
    check('emissive mesh "' + m.name + '" is not near the back (z > margin)', m.position.z > BACK_MARGIN,
      m.position.z);
    m.geometry.computeBoundingBox();
    const maxZ = m.position.z + m.geometry.boundingBox.max.z;
    check('emissive mesh "' + m.name + '" does not poke past the declared depth', maxZ <= D + 0.006, maxZ);
  });
}

// ---- 14. sliding doors overlap on two tracks and span the full width ------
// Code-review round 2: the 2-door sliding wardrobe preset must build EXACTLY
// 2 doors, not 4 - a `doors: N` sliding run is ONE cell spanning the full
// width, not N adjacent 'sliding' cells (which would each build their own
// independent 2-door run).
{
  const params = {
    width: 150, height: 236, depth: 60,
    fronts: [{ height: 228, cells: [
      { kind: 'sliding', width: 150, doors: 2, panels: ['white', 'mirror', 'mirror', 'white'] }
    ] }],
    plinth: { type: 'plinth', height: 8 }, gloss: false, color: '#ffffff', topColor: '#ffffff'
  };
  const g = C.build(THREE, params, {});
  g.updateMatrixWorld(true);
  const box = bbox(g);
  check('sliding wardrobe: bbox width matches params', near(box.max.x - box.min.x, 1.50, 0.01), box);

  const frames = [];
  g.traverse(o => { if (o.isMesh && o.name === 'slidingFrame') frames.push(o); });
  check('exactly 2 doors x 2 stiles = 4 frame stiles (NOT 8 - the regression this guards)',
    frames.length === 4, frames.length);
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

  // Overlap: the two doors' own x-spans (min/max across their 2 stiles each,
  // grouped by track/z) must INTERSECT at the middle seam, not just meet
  // edge-to-edge.
  const byTrack = new Map();
  frames.forEach(f => {
    const key = f.position.z.toFixed(4);
    if (!byTrack.has(key)) byTrack.set(key, []);
    byTrack.get(key).push(...xRange(f));
  });
  const doorSpans = [...byTrack.values()].map(xs => [Math.min(...xs), Math.max(...xs)]);
  check('exactly 2 door spans (one per track)', doorSpans.length === 2, doorSpans);
  const [d0, d1] = doorSpans;
  const overlaps = d0 && d1 && d0[0] < d1[1] - 0.001 && d1[0] < d0[1] - 0.001;
  check('the two doors overlap at the middle seam (not just meet edge-to-edge)', overlaps, doorSpans);

  // A run of MORE than 2 doors is also supported: doors: 4 should build 4
  // doors alternating tracks, still spanning the full width.
  const params4 = Object.assign({}, params, { fronts: [{ height: 228, cells: [
    { kind: 'sliding', width: 150, doors: 4, panels: ['white', 'mirror', 'mirror', 'white'] }
  ] }] });
  const g4 = C.build(THREE, params4, {});
  const frames4 = [];
  g4.traverse(o => { if (o.isMesh && o.name === 'slidingFrame') frames4.push(o); });
  check('doors: 4 builds 4 doors x 2 stiles = 8 frame stiles', frames4.length === 8, frames4.length);
}

// ---- 15. the owner's review (items 145a2df1, 19c25304, 7cea6f9f) ----------
// Every preset on the spec page, from the shared list the z-fighting test
// also builds.
const { CABINET_PRESETS } = await imp('scripts/lib-cabinet-presets.mjs');
const fs = await import('node:fs');
function meshesNamed(g, name) {
  const out = [];
  g.traverse(o => { if (o.isMesh && o.name === name) out.push(o); });
  return out;
}
function mbox(o) { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o); }

// 15a. The wide mirrored wardrobe preset is gone (the owner: delete it).
check('the wide mirrored wardrobe preset is deleted', !CABINET_PRESETS.wideMirroredWardrobe);

// 15b. Triangle caps (perf audit): every preset <= 800 full, <= 400 low.
Object.keys(CABINET_PRESETS).forEach(k => {
  const p = CABINET_PRESETS[k].params;
  const tf = triangleCount(C.build(THREE, p, { detail: 'full' }));
  const tl = triangleCount(C.build(THREE, p, { detail: 'low' }));
  check(k + ': full triangles <= 800', tf <= 800, tf);
  check(k + ': low triangles <= 400', tl <= 400, tl);
});

// 15c. Mirrors run the full door height (the 2-door mirrored wardrobe had a
// ~7 cm gap above and below each pane).
{
  const p = CABINET_PRESETS.mirroredWardrobe2Door.params;
  const g = C.build(THREE, p, {});
  const panes = meshesNamed(g, 'cabinetMirrorDoor');
  check('mirrored wardrobe: two mirror panes', panes.length === 2, panes.length);
  const rowBot = p.plinth.height / 100, rowTop = p.height / 100;
  panes.forEach(pn => {
    const b = mbox(pn);
    check('mirror pane reaches within 5 mm of the row top (full height)', b.max.y >= rowTop - 0.005, b.max.y);
    check('mirror pane reaches within 5 mm of the row bottom (full height)', b.min.y <= rowBot + 0.005, b.min.y);
  });
  // Frame stiles never lie in the carcass's outer planes.
  const stiles = meshesNamed(g, 'cabinetDoorFrame');
  const W = p.width / 100, H = p.height / 100;
  check('mirror stiles stay inside the carcass outline (>= 1 mm in)', stiles.every(s => {
    const b = mbox(s);
    return b.min.x >= -W / 2 + 0.001 && b.max.x <= W / 2 - 0.001 && b.max.y <= H - 0.001;
  }));
}

// 15d. The carcass sides and back stop under the top panel (the TV console's
// dark top used to share its end faces with the white sides).
{
  const p = CABINET_PRESETS.tvConsole.params;
  const g = C.build(THREE, p, {});
  const H = p.height / 100;
  const topY0 = mbox(meshesNamed(g, 'carcassTop')[0]).min.y;
  const sides = meshesNamed(g, 'carcassSide').concat(meshesNamed(g, 'carcassBack'));
  check('TV console: sides and back exist', sides.length === 3, sides.length);
  check('TV console: no side or back runs up into the top panel', sides.every(s => mbox(s).max.y <= topY0 + 1e-6),
    sides.map(s => mbox(s).max.y));
  const botY1 = mbox(meshesNamed(g, 'carcassBottom')[0]).max.y;
  check('TV console: no side or back runs down into the bottom panel', sides.every(s => mbox(s).min.y >= botY1 - 1e-6));
  check('TV console: the top still spans the full width and reaches the full height',
    Math.abs(mbox(meshesNamed(g, 'carcassTop')[0]).max.y - H) < 1e-6);
}

// 15e. Overlay fronts: nothing of the carcass or base stands proud of the
// fronts -- the tall display cabinet named, glass side panel and plinth
// included (the owner: "the top and sides overshoot the front doors").
['tallDisplayCabinet', 'tallDisplayCabinetMirror', 'bedsideTableLedNarrow', 'bedsideTableLedWide'].forEach(k => {
  const p = CABINET_PRESETS[k].params;
  const g = C.build(THREE, p, {});
  const D = p.depth / 100;
  const faceZ = p.handles === false ? D : D - 0.025;
  const leaves = meshesNamed(g, 'cabinetDoor').concat(meshesNamed(g, 'drawerFront'));
  check(k + ': has door/drawer leaves', leaves.length > 0);
  const leafBack = Math.min(...leaves.map(l => mbox(l).min.z));
  const carcassNames = ['carcassTop', 'carcassBottom', 'carcassSide', 'carcassBack', 'displaySideGlass', 'displaySideWood'];
  const proud = [];
  carcassNames.forEach(n => meshesNamed(g, n).forEach(m => { if (mbox(m).max.z > leafBack + 1e-4) proud.push([n, mbox(m).max.z, leafBack]); }));
  // The plinth sits UNDER the fronts, set back from their face by its inset
  // (a shadow recess), never level with or proud of them.
  meshesNamed(g, 'plinth').forEach(m => { if (mbox(m).max.z > faceZ - 0.005) proud.push(['plinth', mbox(m).max.z, faceZ]); });
  check(k + ': no carcass, glass-side or plinth part stands proud of the fronts', proud.length === 0, proud);
  const W = p.width / 100, H = p.height / 100;
  const outline = new THREE.Box3();
  leaves.forEach(l => outline.union(mbox(l)));
  check(k + ': the fronts reach the carcass sides (flush, no side lip)',
    Math.abs(outline.min.x + W / 2) < 1e-4 && Math.abs(outline.max.x - W / 2) < 1e-4, [outline.min.x, outline.max.x]);
  check(k + ': the top front reaches the top (flush, no top lip)', Math.abs(outline.max.y - H) < 1e-4, outline.max.y);
  check(k + ': the leaves sit in the front plane', leaves.every(l => Math.abs(mbox(l).max.z - faceZ) < 1e-4));
});
// ... and an overlay cabinet WITH handles still fills its declared depth.
{
  const p = CABINET_PRESETS.tallDisplayCabinet.params;
  const b = bbox(C.build(THREE, p, {}));
  check('display cabinet: the handles still reach the declared depth', Math.abs(b.max.z - p.depth / 100) < 0.001, b.max.z);
}

// 15f. The finish param: unset follows `gloss`; an explicit finish wins.
{
  const base = { width: 60, height: 80, depth: 40, plinth: { type: 'plinth', height: 0 },
    fronts: [{ height: 80, cells: [{ kind: 'door', width: 60 }] }] };
  const finishOf = (g, name) => meshesNamed(g, name)[0].material.userData.finish;
  check('resolveFinish: unset + gloss:false -> matte', C.resolveFinish({ gloss: false }) === 'matte');
  check('resolveFinish: unset + gloss:true -> gloss', C.resolveFinish({ gloss: true }) === 'gloss');
  check('resolveFinish: finish satin wins over gloss:true', C.resolveFinish({ gloss: true, finish: 'satin' }) === 'satin');
  check('resolveFinish: an unknown finish falls back to gloss', C.resolveFinish({ gloss: false, finish: 'metal' }) === 'matte');
  const gm = C.build(THREE, Object.assign({}, base, { gloss: false }), {});
  check('unset finish + gloss:false: carcass and door are matte', finishOf(gm, 'carcassSide') === 'matte' && finishOf(gm, 'cabinetDoor') === 'matte');
  const gs = C.build(THREE, Object.assign({}, base, { finish: 'satin' }), {});
  ['carcassTop', 'carcassBottom', 'carcassSide', 'carcassBack', 'cabinetDoor'].forEach(n =>
    check('finish satin applies to ' + n, finishOf(gs, n) === 'satin', finishOf(gs, n)));
  const shelving = C.build(THREE, Object.assign({}, CABINET_PRESETS.openShelving2Columns.params, { finish: 'satin' }), {});
  check('finish satin applies to open-shelving shelves and dividers',
    meshesNamed(shelving, 'shelf').every(m => m.material.userData.finish === 'satin') &&
    meshesNamed(shelving, 'columnDivider').every(m => m.material.userData.finish === 'satin'));
  check('DEFAULTS.finish is null (follow gloss)', C.DEFAULTS.finish === null);
  check('DEFAULTS.overlayFronts is false (the old look)', C.DEFAULTS.overlayFronts === false);
}

// 15g. The display interior (scout 80edd3ff): lining, 2 glass shelves at 35
// and 80, a vertical LED strip, contents that stay INSIDE the section, and
// no horizontal shelf light.
['tallDisplayCabinet', 'tallDisplayCabinetMirror'].forEach(k => {
  const p = CABINET_PRESETS[k].params;
  const g = C.build(THREE, p, { detail: 'full' });
  const shelves = meshesNamed(g, 'interiorShelf');
  check(k + ': two glass shelves', shelves.length === 2 && shelves.every(s => s.material.userData.finish === 'glass'), shelves.length);
  const floor = meshesNamed(g, 'interiorFloor')[0];
  check(k + ': an interior floor', !!floor);
  if (floor && shelves.length === 2) {
    const fy = mbox(floor).max.y;
    const hs = shelves.map(s => Math.round((mbox(s).min.y - fy) * 100)).sort((a, b) => a - b);
    check(k + ': shelves at 35 and 80 cm above the section floor', hs[0] === 35 && hs[1] === 80, hs);
  }
  const lining = meshesNamed(g, 'interiorLining').concat(meshesNamed(g, 'interiorDivider'));
  check(k + ': dark lining (back, ceiling, wall, divider)', lining.length >= 4 &&
    lining.every(m => m.material.color.getHexString() === '2b2426'), lining.length);
  const strip = meshesNamed(g, 'interiorLedStrip');
  check(k + ': one vertical emissive LED strip, pink by default', strip.length === 1 &&
    strip[0].material.userData.finish === 'emissive' && strip[0].material.color.getHexString() === 'ff4fa0');
  if (strip.length && floor) {
    const sb = mbox(strip[0]);
    check(k + ': the strip runs the section height (> 1 m) at the back', sb.max.y - sb.min.y > 1.0 && sb.min.z < 0.02, sb);
  }
  check(k + ': no horizontal shelf light', meshesNamed(g, 'shelfLight').length === 0);
  // Contents: <= 150 triangles, and every piece inside the section's clear
  // box (between the lining/divider walls, behind the glass, on or above a
  // floor/shelf and under the ceiling).
  const contents = [];
  g.traverse(o => { if (o.isMesh && /^contents/.test(o.name)) contents.push(o); });
  const tris = contents.reduce((s, o) => s + (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3, 0);
  check(k + ': contents present and <= 150 triangles', contents.length > 0 && tris <= 150, { n: contents.length, tris });
  const walls = lining.concat(strip);
  const clear = { x0: -Infinity, x1: Infinity };
  const glassPane = meshesNamed(g, 'cabinetGlassDoor')[0];
  const paneBack = glassPane ? mbox(glassPane).min.z : Infinity;
  const ceil = Math.min(...meshesNamed(g, 'interiorLining').map(m => mbox(m).min.y).filter(y => y > 1.0));
  const W = p.width / 100;
  const inside = contents.filter(o => {
    const b = mbox(o);
    return b.max.z <= paneBack - 0.002 && b.max.y <= ceil + 1e-6 && b.min.y >= mbox(floor).max.y - 0.001 &&
      b.min.x >= -W / 2 && b.max.x <= W / 2;
  });
  check(k + ': every content piece is inside the section (behind the glass, under the ceiling, on the floor)',
    inside.length === contents.length, contents.filter(o => inside.indexOf(o) === -1).map(o => [o.name, mbox(o)]));
  // Nothing pokes through a glass shelf: a piece standing on a level stays
  // below the next shelf's underside.
  const shelfBottoms = shelves.map(s => mbox(s).min.y), shelfTops = shelves.map(s => mbox(s).max.y);
  const crossing = contents.filter(o => {
    const b = mbox(o);
    return shelves.some((s, i) => b.min.y < shelfTops[i] - 0.001 && b.max.y > shelfBottoms[i] + 0.001);
  });
  check(k + ': no content piece passes through a glass shelf', crossing.length === 0, crossing.map(o => o.name));
  const low = C.build(THREE, p, { detail: 'low' });
  let lowContents = 0;
  low.traverse(o => { if (o.isMesh && /^contents/.test(o.name)) lowContents++; });
  check(k + ': contents dropped at low detail', lowContents === 0, lowContents);
});

// 15h. The LED bedside tables (scout 80edd3ff): no plinth but a 1 cm shadow
// recess, drawers 21/18/15, two recessed light channels with independent
// colours wrapping the front and both sides (never the back), and a glow
// band on the drawer below each.
['bedsideTableLedNarrow', 'bedsideTableLedWide'].forEach(k => {
  const p = CABINET_PRESETS[k].params;
  const g = C.build(THREE, p, { detail: 'full' });
  const W = p.width / 100, D = p.depth / 100;
  const drawers = meshesNamed(g, 'drawerFront');
  check(k + ': three drawers', drawers.length === 3, drawers.length);
  const hs = drawers.map(d => mbox(d)).sort((a, b) => b.min.y - a.min.y);
  check(k + ': drawers top-to-bottom tallest to shortest (21 / 18 / 15 rows)',
    hs.length === 3 && (hs[0].max.y - hs[0].min.y) > (hs[1].max.y - hs[1].min.y) && (hs[1].max.y - hs[1].min.y) > (hs[2].max.y - hs[2].min.y));
  const recesses = meshesNamed(g, 'channelRecess');
  check(k + ': two recessed channels', recesses.length === 2, recesses.length);
  recesses.forEach(r => {
    const b = mbox(r);
    check(k + ': channel set back ~1.5 cm from the front', Math.abs(b.max.z - (D - 0.015)) < 0.001, b.max.z);
    check(k + ': channel set in ~1.5 cm from each side', Math.abs(b.max.x - (W / 2 - 0.015)) < 0.001 && Math.abs(b.min.x + (W / 2 - 0.015)) < 0.001);
  });
  const sides = meshesNamed(g, 'carcassSide');
  check(k + ': the carcass sides are split round both channels (3 segments a side)', sides.length === 6, sides.length);
  const fronts = meshesNamed(g, 'channelStripFront'), sideStrips = meshesNamed(g, 'channelStripSide');
  check(k + ': a front strip per channel and two side strips per channel', fronts.length === 2 && sideStrips.length === 4);
  const colours = fronts.map(f => f.material.color.getHexString()).sort();
  check(k + ': the two channels have their own colours', colours.length === 2 && colours[0] !== colours[1], colours);
  check(k + ': every strip is emissive and kept', fronts.concat(sideStrips).every(s =>
    s.material.userData.finish === 'emissive' && s.userData.keep === true));
  check(k + ': no strip reaches the back (never wraps it)', sideStrips.every(s => mbox(s).min.z > 0.015));
  const glows = meshesNamed(g, 'channelGlow');
  check(k + ': a glow band on the drawer below each channel, in the drawer\'s own plane', glows.length === 2 &&
    glows.every(gl => Math.abs(mbox(gl).max.z - D) < 1e-4 && gl.material.userData.finish === 'emissive'), glows.length);
  const plinth = meshesNamed(g, 'plinth')[0];
  check(k + ': a 2 cm base set back 1 cm (shadow recess)', plinth && Math.abs(mbox(plinth).max.y - 0.02) < 1e-4 &&
    Math.abs(mbox(plinth).max.z - (D - 0.01)) < 1e-4 && Math.abs(mbox(plinth).max.x - (W / 2 - 0.01)) < 1e-4);
  check(k + ': handleless', meshesNamed(g, 'drawerHandle').length === 0);
  check(k + ': white satin', drawers.every(d => d.material.userData.finish === 'satin'));
  const b = bbox(g);
  check(k + ': bbox matches params', near(b.max.x - b.min.x, W, 0.005) && near(b.max.y - b.min.y, p.height / 100, 0.005) &&
    near(b.max.z - b.min.z, D, 0.005), b);
});

// 15i. The APPROVED presets did not move (plan review r2, finding 1). Every
// front, handle, plinth/wheel, top/bottom and shelf part of the chest of
// drawers, sliding wardrobe, open shelving, mobile pedestal and TV console
// has exactly the bounding box it had before this change
// (scripts/fixtures/cabinet-approved-fronts.json, captured from f3e0cb2's
// builder). Deliberate exceptions: the pedestal's TOP drawer handle, which
// used to run up into the top panel (its face in the panel's front plane)
// and now stops under it.
{
  const fx = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/cabinet-approved-fronts.json'), 'utf8'));
  const KEEP = new Set(['cabinetDoor', 'drawerFront', 'doorHandle', 'drawerHandle', 'slidingWhitePanel', 'slidingRail', 'slidingFrame', 'shelf', 'columnDivider', 'carcassTop', 'carcassBottom', 'plinth', 'wheel', 'leg']);
  Object.keys(fx.params).forEach(k => {
    const g = C.build(THREE, fx.params[k], { detail: 'full' });
    const now = [];
    g.traverse(o => {
      if (!o.isMesh || !KEEP.has(o.name)) return;
      const b = mbox(o);
      const r = v => Math.round(v * 10000) / 10000;
      now.push([o.name, o.material.userData.finish, r(b.min.x), r(b.min.y), r(b.min.z), r(b.max.x), r(b.max.y), r(b.max.z)]);
    });
    now.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    const was = fx.parts[k];
    const exempt = row => k === 'pedestal' && row[0] === 'drawerHandle' && row[7] > 0 && row[6] > 0.55;
    const a = was.filter(r => !exempt(r)).map(r => JSON.stringify(r));
    const b = now.filter(r => !exempt(r)).map(r => JSON.stringify(r));
    const missing = a.filter(x => b.indexOf(x) === -1), extra = b.filter(x => a.indexOf(x) === -1);
    check('approved preset ' + k + ': every front/handle/base/top/shelf part is exactly where it was',
      missing.length === 0 && extra.length === 0, { missing: missing.slice(0, 4), extra: extra.slice(0, 4) });
  });
}

// 15j. The page and the test list agree: every preset on the Cabinet spec
// page is in scripts/lib-cabinet-presets.mjs with the same params, so the
// z-fighting, cap and contract checks above build what the page shows.
{
  const html = fs.readFileSync(path.join(root, 'specs/CabinetSpec.html'), 'utf8');
  const m = html.match(/const PRESETS = (\{[\s\S]*?\n\});/);
  check('CabinetSpec.html has a PRESETS block', !!m);
  if (m) {
    // eslint-disable-next-line no-new-func
    const pagePresets = new Function('return (' + m[1] + ');')();
    Object.keys(pagePresets).forEach(k => {
      check('page preset ' + k + ' is in lib-cabinet-presets.mjs with the same params',
        !!CABINET_PRESETS[k] && JSON.stringify(CABINET_PRESETS[k].params) === JSON.stringify(pagePresets[k].params));
    });
  }
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
