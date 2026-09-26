#!/usr/bin/env node
/**
 * Windows + curtains: loader pass-through and the geometry decisions that a
 * screenshot cannot pin. No framework, no install -
 * `node scripts/test-wall-fittings.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. house-loader compiles `windows[]` / `curtains[]` into what the renderer
 *      reads -- every authored field lands, defaults fill the gaps, a broken
 *      reference is skipped with a warning rather than thrown.
 *   2. The inside/outside decision. It is DERIVED from `room` (which side of
 *      the wall the room lies on). Get it backwards and every window renders
 *      with its frame on the room face and every curtain hangs outside the
 *      building -- in a house nobody is looking at from that side, so it
 *      would survive review.
 *   3. The cavity-wall sandwich: `throughWalls` must widen the cill to the
 *      outer leaf's face.
 *   4. Curtain stacking: a blackout hung in front of a sheer must never fold
 *      back through it. Checked on the real vertex positions, not on the
 *      formula, so a change to either the budget or the fold maths trips it.
 *   5. The balcony door lands at the authored compass end of the run on a
 *      wall whose local frame is rotated 180 degrees.
 *
 * The scene half builds real three.js geometry (the vendored module is plain
 * ESM and needs no DOM for geometry), so it exercises the same code the page
 * runs rather than a copy of it.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HouseLoader } = await imp('src/house-loader.js');
const THREE = await imp('vendor/three-r160/three.module.min.js');
const F = await imp('src/wall-fittings.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// An illustrative south-facing cavity wall: inner leaf 4 (30 cm) with an
// outer skin 32 (10 cm) south of it; the room lies NORTH of both.
function house(extra) {
  return Object.assign({
    kind: 'geometry', schemaVersion: '1.1', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      { id: 4, start: [0, 600], end: [1000, 600], exterior: true, thickness: 30 },
      { id: 32, start: [0, 620], end: [1000, 620], exterior: true, thickness: 10 },
      { id: 7, start: [500, 0], end: [500, 585], thickness: 10 },
      { id: 9, start: [0, 0], end: [1000, 0], exterior: true, thickness: 20 }
    ] },
    rooms: [{ id: 'living', label: 'Living', polygon: [[10, 10], [490, 10], [490, 585], [10, 585]] }]
  }, extra);
}
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

// ---- 1. absent keys compile to empty lists ---------------------------------
{
  const h = quiet(() => HouseLoader.compile(house({}), ''));
  check('no windows key -> []', Array.isArray(h.windows) && h.windows.length === 0, h.windows);
  check('no curtains key -> []', Array.isArray(h.curtains) && h.curtains.length === 0, h.curtains);
}

// ---- 2/3. window pass-through, side derivation, the sandwich ---------------
const windowsDoc = [
  { id: 'bay', room: 'living', wall: 4, throughWalls: [32], centre: 250, width: 100, height: 200, sill: 10 },
  { id: 'plain', room: 'living', wall: 4, centre: 400, width: 60, height: 100 },
  { id: 'glaze', kind: 'balcony', room: 'living', wall: 4, throughWalls: [32], centre: 150, width: 200,
    height: 210, sill: 5, doorSide: 'west', frameColor: '#102030' },
  { id: 'ghost', room: 'living', wall: 99, centre: 1, width: 1, height: 1 },
  { id: 'nowhere', room: 'attic', wall: 4, centre: 1, width: 1, height: 1 },
  { id: 'badend', kind: 'balcony', room: 'living', wall: 4, centre: 700, width: 100, height: 100, doorSide: 'north' },
  { id: 'crosscut', room: 'living', wall: 4, throughWalls: [7], centre: 300, width: 50, height: 50 }
];
const h = quiet(() => HouseLoader.compile(house({ windows: windowsDoc }), ''));
const byId = Object.fromEntries(h.windows.map(w => [w.id, w]));
{
  const b = byId.bay;
  check('window compiled', !!b);
  check('window fields pass through', b && b.c === 250 && b.w === 100 && b.h === 200 && b.sill === 10 &&
    b.room === 'living' && b.wallId === 4 && b.kind === 'window', b);
  check('room north of a south wall -> inDir -1', b && b.inDir === -1, b && b.inDir);
  check('outer face is the SOUTH face of the host', b && near(b.outerFace, 615), b && b.outerFace);
  check('host thickness carried', b && b.hostThickness === 30);
  check('throughWalls kept', b && b.throughWallIds.length === 1 && b.throughWallIds[0] === 32, b && b.throughWallIds);
  check('sandwich depth beyond the host = outer leaf 10 cm', b && near(b.beyond, 10), b && b.beyond);
  check('exterior host flagged', b && b.exterior === true);
  check('sill defaults to 90', byId.plain && byId.plain.sill === 90, byId.plain && byId.plain.sill);
  check('no throughWalls -> beyond 0', byId.plain && byId.plain.beyond === 0);
  check('topSplit defaults to 0.5', byId.plain && byId.plain.topSplit === 0.5);
  const g = byId.glaze;
  check('balcony kind + doorEnd', g && g.kind === 'balcony' && g.doorEnd === 'west', g);
  check('frameColor hex -> int', g && g.frameColor === 0x102030, g && g.frameColor);
  check('missing wall -> skipped', !byId.ghost);
  check('missing room -> skipped', !byId.nowhere);
  check('doorSide off the wall axis -> falls back to west', byId.badend && byId.badend.doorEnd === 'west',
    byId.badend && byId.badend.doorEnd);
  check('non-parallel throughWall ignored', byId.crosscut && byId.crosscut.throughWallIds.length === 0);
  check('warnings name the skipped window', h.warnings.some(m => m.includes('"ghost"')) &&
    h.warnings.some(m => m.includes('"nowhere"')), h.warnings);

  // Room SOUTH of a wall: the same wall seen from the other side flips.
  const hs = quiet(() => HouseLoader.compile(house({
    rooms: [{ id: 'yard', label: 'Yard', polygon: [[10, 20], [490, 20], [490, 300], [10, 300]] }],
    windows: [{ id: 'n', room: 'yard', wall: 9, centre: 100, width: 50, height: 50 }]
  }), ''));
  check('room south of a wall -> inDir +1', hs.windows[0] && hs.windows[0].inDir === 1, hs.windows[0]);
}

// ---- 4. curtains: pass-through, defaults, stacking --------------------------
const curtainsDoc = [
  { id: 'blackout', room: 'living', wall: 4, centre: 250, width: 300, offset: 12.5,
    outerColor: '#224466', innerColor: '#cc8844', openPct: 0, cornice: { sideFaces: false } },
  { id: 'sheer', room: 'living', wall: 4, centre: 250, width: 300, offset: 3.5, opacity: 0.4, openPct: 0,
    outerColor: '#eeddaa', innerColor: '#eeddaa', cornice: { enabled: false } },
  { id: 'plainc', room: 'living', wall: 4, centre: 700, width: 100 },
  { id: 'lost', room: 'living', wall: 123, centre: 1, width: 1 }
];
const hc = quiet(() => HouseLoader.compile(house({ curtains: curtainsDoc }), ''));
const cById = Object.fromEntries(hc.curtains.map(c => [c.id, c]));
{
  const bo = cById.blackout, sh = cById.sheer, pc = cById.plainc;
  check('curtain colours pass through', bo && bo.outerColor === 0x224466 && bo.innerColor === 0xcc8844, bo);
  check('curtain openPct passes through', bo && bo.openPct === 0);
  check('opaque curtain is not a sheer', bo && bo.sheer === false && bo.opacity === 1);
  check('opacity < 1 makes a sheer', sh && sh.sheer === true && sh.opacity === 0.4, sh);
  check('cornice.enabled false -> no cornice', sh && sh.cornice === null);
  check('sideFaces false carried', bo && bo.cornice && bo.cornice.sideFaces === false);
  check('curtain hangs on the ROOM face', bo && near(bo.roomFace, 585), bo && bo.roomFace);
  check('defaults: floor-to-ceiling, open, pink/blue, 5+2 pleats',
    pc && pc.top === 250 && pc.drop === 250 && pc.openPct === 100 && pc.outerColor === 0xd98aa8 &&
    pc.innerColor === 0x5f86c4 && pc.outerPleats === 5 && pc.innerPleats === 2, pc);
  check('default offset = half the default 18 cm cornice', pc && pc.offset === 9, pc && pc.offset);
  check('curtain on a missing wall -> skipped', !cById.lost);
  check('room span carried for a wall-to-wall cornice', bo && bo.roomSpan[0] === 10 && bo.roomSpan[1] === 490,
    bo && bo.roomSpan);
  // Budget: sheer = 3.5 - 0 (no lining) - 2.5 wall clearance = 1.
  // Blackout = 12.5 - 2 (lining) - (3.5 + 1 + 1 layer gap) = 5.
  check('sheer fold budget', sh && near(sh.maxAmp, 1), sh && sh.maxAmp);
  check('blackout stacked in front of the sheer', bo && near(bo.maxAmp, 5), bo && bo.maxAmp);
  check('unstacked curtain gets the wall-only budget (9 - 2 - 2.5)', pc && near(pc.maxAmp, 4.5), pc && pc.maxAmp);
}

// ---- scene geometry --------------------------------------------------------
function zRange(group) {
  let lo = Infinity, hi = -Infinity;
  group.traverse(o => {
    if (!o.isMesh || !/^curtain_/.test(o.name)) return;
    const p = o.geometry.attributes.position.array;
    for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  });
  return [lo, hi];
}
{
  // Both drawn closed AND fully open: the gathered pose folds deepest.
  for (const pct of [0, 100]) {
    const bo = Object.assign({}, cById.blackout, { openPct: pct });
    const sh = Object.assign({}, cById.sheer, { openPct: pct });
    const [boLo] = zRange(F.buildCurtain(THREE, bo, true).group);
    const [shLo, shHi] = zRange(F.buildCurtain(THREE, sh, true).group);
    check('sheer never touches the wall (open ' + pct + ')', shLo > 0.02, shLo);
    check('blackout lining stays in front of the sheer (open ' + pct + ')', boLo > shHi, { boLo, shHi });
  }
  const sheerBuilt = F.buildCurtain(THREE, cById.sheer, true);
  const sheerFabric = [];
  sheerBuilt.group.traverse(o => { if (o.isMesh && /^curtain_/.test(o.name)) sheerFabric.push(o); });
  check('sheer has no lining (2 surfaces, not 4)', sheerFabric.length === 2, sheerFabric.length);
  check('sheer keeps its own opacity', sheerFabric.every(m => m.material.transparent && near(m.material.opacity, 0.4)));
  check('sheer fabric stays out of the wall fade', sheerFabric.every(m => sheerBuilt.fadeMeshes.indexOf(m) === -1));
  const boBuilt = F.buildCurtain(THREE, cById.blackout, true);
  const names = [];
  boBuilt.group.traverse(o => { if (o.isMesh) names.push(o.name); });
  check('blackout has 4 fabric surfaces + wall-to-wall cornice (no ends) + strip',
    names.filter(n => /^curtain_/.test(n)).length === 4 && names.includes('corniceFront') &&
    !names.includes('corniceSide') && names.includes('corniceLightStrip'), names);

  // Windows: verticals, fade membership, cill depth, balcony door end.
  const v = F.windowVerticals(byId.bay);
  check('glazing 10..210 cm, hole 6..214 cm', near(v.openBot, 0.10) && near(v.openTop, 2.10) &&
    near(v.holeBot, 0.06) && near(v.holeTop, 2.14), v);
  const vLow = F.windowVerticals(Object.assign({}, byId.bay, { sill: 0 }));
  check('a sill under the reveal is raised to it', near(vLow.openBot, 0.04) && near(vLow.holeBot, 0), vLow);

  const bay = F.buildWindow(THREE, byId.bay, true);
  let glass = 0, cill = null;
  bay.group.traverse(o => {
    if (o.isMesh && /Glass$/.test(o.name)) { glass++; check('glass not in fade', bay.fadeMeshes.indexOf(o) === -1, o.name); }
    if (o.name === 'windowCill') cill = o;
  });
  check('window has fixed + sash glass', glass === 2, glass);
  check('frame is in the fade', bay.fadeMeshes.some(m => m.name === 'windowFrame'));
  cill.geometry.computeBoundingBox();
  const cb = cill.geometry.boundingBox.clone().translate(cill.position);
  check('cill spans outer skin face (-10 cm) to room face (+30 cm)', near(cb.min.z, -0.10) && near(cb.max.z, 0.30), cb);

  const g = F.buildWindow(THREE, byId.glaze, true);
  F.placeOnWall(g.group, byId.glaze, byId.glaze.outerFace, x => x * 0.01, y => y * 0.01);
  g.group.updateMatrixWorld(true);
  let pivot = null, mullion = null;
  g.group.traverse(o => { if (o.name === 'balconyDoorPivot') pivot = o; if (o.name === 'balconyMullion') mullion = o; });
  const pw = new THREE.Vector3(), mw = new THREE.Vector3();
  pivot.getWorldPosition(pw); mullion.getWorldPosition(mw);
  // Run is 150 +/- 100 cm: the west jamb is at x = 0.5 m, the door 25% of the run.
  check('balcony door hinge is on the WEST jamb', near(pw.x, 0.5, 1e-4), pw.x);
  check('mullion sits a quarter-run east of it', near(mw.x, 1.0, 1e-4), mw.x);
  // No sliver between the fixed pane and the east jamb (the spec page had one).
  let fixedGlass = null;
  g.group.traverse(o => { if (o.name === 'balconyFixedGlass') fixedGlass = o; });
  const fb = new THREE.Box3().setFromObject(fixedGlass);
  check('fixed pane reaches the east jamb (x = 2.5 m)', near(fb.max.x, 2.5, 1e-4), fb.max.x);
  check('fixed pane starts at the mullion face', near(fb.min.x, 1.0 + 0.035, 1e-4), fb.min.x);
  check('window frame sits on the host OUTER face', near(g.group.position.z, 6.15, 1e-6), g.group.position.z);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
