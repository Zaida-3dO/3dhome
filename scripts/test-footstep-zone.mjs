#!/usr/bin/env node
/**
 * footstepZone: loader parsing + walk confinement. No framework, no
 * dependencies - `node scripts/test-footstep-zone.mjs`.
 *
 * WHAT THIS GUARDS
 *
 * `rooms[].footstepZone` (schema) lets a house profile confine the presence
 * footstep trail to a rectangle instead of the room's full polygon, for rooms
 * where the polygon alone does not describe the floor that is actually clear
 * (a kitchen's counters and table, a hallway's L that reads as walking into a
 * side room). Two things can silently break this feature and neither would be
 * caught by the existing footstep-turn test, which never authors a zone at
 * all:
 *
 *   1. house-loader.js must resolve `from`/`to` -- authored RELATIVE TO THE
 *      ROOM'S OWN BBOX MIN CORNER -- into absolute plan coordinates, sorting
 *      the corners so `from` need not be top-left. Get the offset backwards
 *      and a zone silently drifts to the wrong part of the room, which is a
 *      change nobody would notice without overlaying the two rectangles by
 *      hand.
 *   2. A malformed zone (missing corner, wrong `relativeTo`) must fall back to
 *      automatic placement (null), not throw and not compile to garbage
 *      coordinates -- the same "warn and carry on" rule as every other guard
 *      in this loader.
 *   3. Once resolved, home3d-scene.js's footstep section must confine the
 *      WALK itself to the zone rectangle, not just clip strays afterwards --
 *      this file asserts that against the pure walkFootsteps()/insidePoly()
 *      arithmetic in src/footstep-walk.js, the same functions the scene calls
 *      after substituting the zone rectangle for the room polygon (see
 *      home3d-scene.js's footstep section: `const poly = zone ? [...] :
 *      rm.poly`).
 *
 * A room with NO footstepZone must resolve to `footstepZone: null` and must
 * walk its own polygon exactly as before -- this is the regression case the
 * item's acceptance criteria call out explicitly.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HouseLoader } = await imp('src/house-loader.js');
const { insidePoly, walkFootsteps, clearRun, polyAreaSqm, printCount, WALK_DEFAULTS } =
  await imp('src/footstep-walk.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS  ' + label); pass++; }
  else { console.log('FAIL  ' + label + (detail !== undefined ? '   -> ' + JSON.stringify(detail) : '')); fail++; }
}
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

// A rectangular room whose bbox min corner is NOT the origin, specifically so
// a test that forgot to add the bbox offset back on would fail rather than
// coincidentally pass. Kitchen-shaped: 341x290cm, bbox min at (303, 10.2).
function houseDoc(footstepZone) {
  return {
    kind: 'geometry', schemaVersion: '1.1', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      { id: 1, start: [303, 10.2], end: [644, 10.2], exterior: true, thickness: 10 },
      { id: 2, start: [303, 10.2], end: [303, 300.6], exterior: true, thickness: 10 }
    ] },
    rooms: [Object.assign(
      { id: 'kitchen', label: 'Kitchen', polygon: [[303, 10.2], [644, 10.2], [644, 300.6], [303, 300.6]] },
      footstepZone ? { footstepZone } : {}
    )]
  };
}

// ---------------------------------------------------------------------------
// 1. Absent field -> null, unchanged behaviour.
// ---------------------------------------------------------------------------
{
  const h = quiet(() => HouseLoader.compile(houseDoc(null), ''));
  check('no footstepZone -> resolves to null', h.rooms.kitchen.footstepZone === null,
        h.rooms.kitchen.footstepZone);
}

// ---------------------------------------------------------------------------
// 2. Present field -> resolved to ABSOLUTE plan coordinates, bbox offset
//    added back on, corners sorted regardless of authoring order.
// ---------------------------------------------------------------------------
{
  // bbox min is (303, 10.2). from/to authored relative to it; to is
  // deliberately given as the SMALLER corner to prove sorting, not just offset.
  const h = quiet(() => HouseLoader.compile(
    houseDoc({ from: [141, 218], to: [40, 90], relativeTo: 'room' }), ''
  ));
  const z = h.rooms.kitchen.footstepZone;
  check('zone resolved (not null)', z !== null, z);
  check('x1 = bbox.x1 + min(fromX,toX)', z && Math.abs(z.x1 - (303 + 40)) < 1e-9, z);
  check('y1 = bbox.y1 + min(fromY,toY)', z && Math.abs(z.y1 - (10.2 + 90)) < 1e-9, z);
  check('x2 = bbox.x1 + max(fromX,toX)', z && Math.abs(z.x2 - (303 + 141)) < 1e-9, z);
  check('y2 = bbox.y1 + max(fromY,toY)', z && Math.abs(z.y2 - (10.2 + 218)) < 1e-9, z);
}

// ---------------------------------------------------------------------------
// 3. Malformed zone -> falls back to null (automatic placement), never throws.
// ---------------------------------------------------------------------------
{
  const wrongRelative = quiet(() => HouseLoader.compile(
    houseDoc({ from: [0, 0], to: [10, 10], relativeTo: 'fixture' }), ''
  ));
  check('unrecognised relativeTo -> null, not thrown',
        wrongRelative.rooms.kitchen.footstepZone === null, wrongRelative.rooms.kitchen.footstepZone);

  const missingCorner = quiet(() => HouseLoader.compile(
    houseDoc({ from: [0, 0], relativeTo: 'room' }), ''
  ));
  check('missing `to` -> null, not thrown',
        missingCorner.rooms.kitchen.footstepZone === null, missingCorner.rooms.kitchen.footstepZone);
}

// ---------------------------------------------------------------------------
// 4. THE ACCEPTANCE PROPERTY: walking the zone rectangle (as home3d-scene.js
//    does by substituting it for `poly`) confines every print inside the
//    zone, even though the room's actual polygon is much larger. This is what
//    "__home3dSensors.presence('kitchen', true) confines prints inside it"
//    reduces to once you take the DOM and THREE out of the picture.
// ---------------------------------------------------------------------------
{
  const ROOM_POLY = [[303, 10.2], [644, 10.2], [644, 300.6], [303, 300.6]]; // 341x290
  const ZONE = { x1: 343, y1: 100.2, x2: 583, y2: 220.2 };                  // 240x120, well inside
  const zonePoly = [[ZONE.x1, ZONE.y1], [ZONE.x2, ZONE.y1], [ZONE.x2, ZONE.y2], [ZONE.x1, ZONE.y2]];

  const { STEP_CM, STRIDE_CM } = WALK_DEFAULTS;
  const sx = ZONE.x1 + 30, sy = (ZONE.y1 + ZONE.y2) / 2;
  const run = clearRun(zonePoly, sx, sy, 1, 0, 1200);
  const area = polyAreaSqm(zonePoly);
  const nPrints = printCount(area, run, STEP_CM);
  const walk = walkFootsteps({ poly: zonePoly, sx, sy, ux: 1, uy: 0, nPrints, stepCm: STEP_CM, strideCm: STRIDE_CM });

  check('walk laid at least one print', walk.prints.length > 0, walk.prints.length);
  check('every print stays inside the ZONE rectangle',
        walk.prints.every(p => insidePoly(zonePoly, p.x, p.y)),
        walk.prints.filter(p => !insidePoly(zonePoly, p.x, p.y)));

  // The property that actually matters to a room owner tuning this: the trail
  // must NOT reach floor that is inside the room polygon but OUTSIDE the zone
  // (e.g. the counter run this zone was drawn to avoid). Pick a point inside
  // ROOM_POLY, outside ZONE.
  const outsideZoneButInRoom = [320, 30]; // near the room's own corner, far from the zone
  check('sanity: that point is inside the room polygon',
        insidePoly(ROOM_POLY, ...outsideZoneButInRoom));
  check('sanity: that point is OUTSIDE the zone',
        !insidePoly(zonePoly, ...outsideZoneButInRoom));
  check('no print ever lands there or anywhere else outside the zone',
        walk.prints.every(p => !(Math.abs(p.x - outsideZoneButInRoom[0]) < 1 && Math.abs(p.y - outsideZoneButInRoom[1]) < 1)));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
