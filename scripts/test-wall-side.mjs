#!/usr/bin/env node
/**
 * Which face of a wall is the room's -- the probe in house-loader's
 * wallSide(). No framework, no install: `node scripts/test-wall-side.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   The side used to be the side of the wall's centreline that the room's
 *   BOUNDING-BOX MIDPOINT lay on. For an L-shaped room that is wrong on any
 *   wall bounding one of the L's arms: the bbox midpoint sits out in the
 *   notch, on the far side of the wall. Windows then get their frame on the
 *   room face, curtains hang outside the building, and a cabinet backs into
 *   the wall facing the next room -- in a house nobody looks at from that
 *   side, so it survives review.
 *
 *   The fixture below is a SYNTHETIC L-shaped hallway (made-up numbers) with
 *   the same shape of problem: wall 7 bounds its east-west arm from the north,
 *   wall 15 bounds its north-south arm from the west, and the hallway's bbox
 *   midpoint is north of wall 7 and west of wall 15. THE OLD HEURISTIC FAILS
 *   THIS FIXTURE on both walls; the test asserts that too, so the fixture can
 *   never quietly stop reproducing the bug it exists for.
 *
 *   Also: a room polygon traced a few cm off the wall face (a single fixed
 *   probe step lands in the gap on both sides), an ambiguous centre resolved
 *   from the item's ends, the "neither side" skip and the "both sides"
 *   fallback-with-warning, and a regression over the demo house -- every demo
 *   window and curtain must land on the same side it always did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HouseLoader } = await imp('src/house-loader.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
function compile(doc) {
  const warnings = [];
  const w = console.warn;
  console.warn = m => warnings.push(String(m));
  try { return { house: HouseLoader.compile(doc, ''), warnings: warnings }; } finally { console.warn = w; }
}
/** The rule this replaced, kept here only to prove the fixture reproduces it. */
function oldBboxSide(room, wall) {
  const horizontal = Math.abs(wall.y1 - wall.y2) < Math.abs(wall.x1 - wall.x2);
  const at = horizontal ? wall.y1 : wall.x1;
  const mid = horizontal ? (room.y1 + room.y2) / 2 : (room.x1 + room.x2) / 2;
  return mid >= at ? 1 : -1;
}

// ---- The L fixture ----------------------------------------------------------
//
//      x: 0            390 400      500
//   y 0  +-------------+  |  +-------+
//        |   store     |  15 | hall  |      hall = an L: the east arm
//        |             |  |  |  arm B|      (x 400..500, y 0..200) plus the
//    190 +-------------+  |  |       |      south arm (x 0..500, y 200..300).
//   ===== wall 7 (y=195, x 0..400) ==+       |
//    200 +-------------------------+       |
//        |          hall arm A             |
//    300 +---------------------------------+
//
// Hallway bbox: x 0..500, y 0..300 -> midpoint (250, 150): NORTH of wall 7
// (y 195) and WEST of wall 15 (x 395). Both wrong.
function lHouse(opts) {
  const o = opts || {};
  const g = o.gap || 0;   // how far the hall polygon is traced off wall faces
  return {
    kind: 'geometry', schemaVersion: '1.2', id: 'l', name: 'L', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      { id: 7, start: [0, 195], end: [400, 195], thickness: 10 },
      { id: 15, start: [395, 0], end: [395, 195], thickness: 10 },
      { id: 30, start: [0, 305], end: [505, 305], thickness: 10, exterior: true },
      { id: 31, start: [900, 0], end: [900, 300], thickness: 10 }
    ] },
    rooms: [
      { id: 'hall', label: 'Hall', polygon: o.hallPoly || [
        [400 + g, 0], [500, 0], [500, 300], [0, 300], [0, 200 + g], [400 + g, 200 + g]
      ] },
      { id: 'store', label: 'Store', polygon: [[0, 0], [390, 0], [390, 190], [0, 190]] }
    ],
    windows: o.windows || [],
    curtains: o.curtains || [],
    furniture: o.furniture || []
  };
}

// ---- 1. the fixture reproduces the old bug ---------------------------------
{
  const { house } = compile(lHouse());
  const hall = house.rooms.hall;
  check('fixture: old bbox rule puts hall NORTH of wall 7 (the bug)', oldBboxSide(hall, house.wallsById[7]) === -1);
  check('fixture: old bbox rule puts hall WEST of wall 15 (the bug)', oldBboxSide(hall, house.wallsById[15]) === -1);
}

// ---- 2. furniture, window and curtain on wall 7 all face into the arm -------
{
  const { house, warnings } = compile(lHouse({
    windows: [{ id: 'w7', room: 'hall', wall: 7, centre: 200, width: 80, height: 100 }],
    curtains: [{ id: 'c7', room: 'hall', wall: 7, centre: 200, width: 120 }],
    furniture: [
      { id: 'f7', room: 'hall', type: 'box', wall: 7, centre: 200 },
      { id: 'f15', room: 'hall', type: 'box', wall: 15, centre: 100 },
      { id: 's7', room: 'store', type: 'box', wall: 7, centre: 200 },
      { id: 's15', room: 'store', type: 'box', wall: 15, centre: 100 }
    ]
  }));
  const win = house.windows.find(w => w.id === 'w7');
  const cur = house.curtains.find(c => c.id === 'c7');
  const byId = id => house.furniture.find(f => f.id === id);
  check('window on wall 7 compiles', !!win, warnings);
  check('window on wall 7 faces south into the arm (inDir +1)', win && win.inDir === 1, win && win.inDir);
  check('window on wall 7: room face is the south face', win && win.outerFace === 190, win && win.outerFace);
  check('curtain on wall 7 hangs on the south face', cur && cur.inDir === 1 && cur.roomFace === 200, cur && [cur.inDir, cur.roomFace]);
  const f7 = byId('f7');
  check('furniture on wall 7 faces south (rotation 0)', f7 && f7.rotationDeg === 0, f7);
  check('furniture on wall 7: back on the south face', f7 && f7.y === 200 && f7.x === 200, f7);
  const f15 = byId('f15');
  check('furniture on wall 15 faces east into the arm (rotation 270)', f15 && f15.rotationDeg === 270, f15);
  check('furniture on wall 15: back on the east face', f15 && f15.x === 400 && f15.y === 100, f15);
  // The neighbour on the other side still faces its own way.
  check('store item on wall 7 faces north (180)', byId('s7') && byId('s7').rotationDeg === 180, byId('s7'));
  check('store item on wall 15 faces west (90)', byId('s15') && byId('s15').rotationDeg === 90, byId('s15'));
  check('no side warnings for unambiguous items', !warnings.some(w => /side of wall/.test(w)), warnings);
}

// ---- 3. a room polygon traced a gap off the wall face -----------------------
// 7 cm off: the nearest probe step (5 cm past the face) lands in the gap on
// both sides. The probe must step further rather than report "neither".
{
  const { house, warnings } = compile(lHouse({
    gap: 7,
    furniture: [{ id: 'g7', room: 'hall', type: 'box', wall: 7, centre: 200 }]
  }));
  const g7 = house.furniture.find(f => f.id === 'g7');
  check('gap: item still compiles', !!g7, warnings);
  check('gap: still faces into the arm', g7 && g7.rotationDeg === 0, g7);
}

// ---- 4. an ambiguous centre is resolved from the item's ends ----------------
// A column notch in the hall right at the item's centre (x 190..210, reaching
// 60 cm into the room) makes every probe at the centre land outside the room.
// A centimetre in from each end of a 60 cm item, the room is there.
{
  const notched = [[400, 0], [500, 0], [500, 300], [0, 300], [0, 200],
    [190, 200], [190, 260], [210, 260], [210, 200], [400, 200]];
  const { house, warnings } = compile(lHouse({
    hallPoly: notched,
    furniture: [
      { id: 'wide', room: 'hall', type: 'box', wall: 7, centre: 200, params: { width: 60 } },
      { id: 'narrow', room: 'hall', type: 'box', wall: 7, centre: 200, params: { width: 10 } }
    ]
  }));
  const wide = house.furniture.find(f => f.id === 'wide');
  check('ambiguous centre: a wide item is resolved from its ends', wide && wide.rotationDeg === 0, warnings);
  check('ambiguous centre: an item entirely in the notch is skipped (neither side)',
    !house.furniture.some(f => f.id === 'narrow'));
  check('ambiguous centre: the skip names "neither side"',
    warnings.some(w => /"narrow".*neither side of wall 7/.test(w)), warnings);
}

// ---- 5. neither side: the room is nowhere near the wall ---------------------
{
  const { house, warnings } = compile(lHouse({
    windows: [{ id: 'far', room: 'hall', wall: 31, centre: 100, width: 50, height: 50 }]
  }));
  check('neither: window on a wall its room does not touch is skipped', house.windows.length === 0, house.windows);
  check('neither: warns', warnings.some(w => /"far".*neither side of wall 31/.test(w)), warnings);
}

// ---- 6. both sides: a stub wall inside the room -----------------------------
// Falls back to the bbox midpoint -- and must SAY so, never silently.
{
  const doc = lHouse({ furniture: [{ id: 'stub', room: 'wide', type: 'box', wall: 40, centre: 100 }] });
  doc.walls.segments.push({ id: 40, start: [50, 100], end: [150, 100], thickness: 10 });
  doc.rooms.push({ id: 'wide', label: 'Wide', polygon: [[0, 0], [300, 0], [300, 400], [0, 400]] });
  const { house, warnings } = compile(doc);
  const stub = house.furniture.find(f => f.id === 'stub');
  // bbox midpoint y 200 >= 100 -> south -> rotation 0.
  check('both: falls back to the bbox midpoint side', stub && stub.rotationDeg === 0, stub);
  check('both: warns that it fell back', warnings.some(w => /"stub".*BOTH sides of wall 40.*bounding-box/.test(w)), warnings);
}

// ---- 7. regression: the demo house is unchanged -----------------------------
{
  const demo = JSON.parse(fs.readFileSync(path.join(root, 'houses/demo/geometry.json'), 'utf8'));
  const { house, warnings } = compile(demo);
  check('demo: every window compiles', house.windows.length === (demo.windows || []).length, warnings);
  check('demo: every curtain compiles', house.curtains.length === (demo.curtains || []).length, warnings);
  check('demo: has fittings to check', house.windows.length > 0 && house.curtains.length > 0);
  [].concat(house.windows, house.curtains).forEach(it => {
    const expected = oldBboxSide(house.rooms[it.room], house.wallsById[it.wallId]);
    check('demo: ' + it.id + ' keeps its side', it.inDir === expected, { got: it.inDir, expected: expected });
  });
  check('demo: no side warnings', !warnings.some(w => /side of wall/.test(w)), warnings);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
