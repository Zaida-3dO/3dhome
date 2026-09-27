#!/usr/bin/env node
/**
 * footstepPath (authored waypoint routes) + the door gap. No framework, no
 * dependencies - `node scripts/test-footstep-path.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. PATH FOLLOWING. walkPath() lays prints along an authored polyline, one
 *      stride apart, alternating left/right, facing along the line.
 *   2. DIRECTION. Waypoint order is the direction of travel: the first print
 *      is at the first waypoint, and reversing the waypoints reverses both the
 *      order and every print's heading.
 *   3. DOOR GAP. No print, authored OR automatic, within DOOR_GAP_CM of any
 *      door opening (placeTrail applies it to both branches).
 *   4. L-SHAPED ROOM. A path turning the corner of an L stays on the room's
 *      floor, actually turns, and the smoothed corner produces intermediate
 *      headings rather than an instant 90-degree flip.
 *   5. FALLBACK. house-loader resolves points relative to the room's bbox min
 *      corner, and a path with ANY waypoint outside the room polygon (or a
 *      malformed one) is dropped with a warning, leaving footstepZone / the
 *      automatic walk in charge. A valid path takes precedence over a zone.
 *
 * All rooms here are invented rectangles/Ls with round, obviously fictional
 * coordinates -- never a real house.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const walk = await imp('src/footstep-walk.js');
const { HouseLoader } = await imp('src/house-loader.js');
const {
  insidePoly, walkFootsteps, WALK_DEFAULTS,
  walkPath, doorOpenings, applyDoorGap, clearOfDoors, distToSegment, placeTrail, DOOR_GAP_CM,
} = walk;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS  ' + label); pass++; }
  else { console.log('FAIL  ' + label + (detail !== undefined ? '   -> ' + JSON.stringify(detail) : '')); fail++; }
}
const must = (name, fn) => {
  if (typeof fn !== 'function' && typeof fn !== 'number') {
    console.log('FAIL  src/footstep-walk.js does not export ' + name);
    process.exit(1);
  }
};
must('walkPath', walkPath); must('doorOpenings', doorOpenings); must('applyDoorGap', applyDoorGap);
must('placeTrail', placeTrail); must('DOOR_GAP_CM', DOOR_GAP_CM);

const { STEP_CM, STRIDE_CM } = WALK_DEFAULTS;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// 1. Path following on a straight line.
// ---------------------------------------------------------------------------
const RECT = [[1000, 1000], [1600, 1000], [1600, 1300], [1000, 1300]];
{
  const pts = [[1100, 1150], [1500, 1150]];            // 400 cm due east
  const { prints } = walkPath({ points: pts, poly: RECT });
  const expected = Math.round(400 / STEP_CM) + 1;
  check('straight path: one print per (fitted) stride over the whole line', prints.length === expected,
        { got: prints.length, expected });
  check('straight path: first print starts at the first waypoint (along the line)',
        near(prints[0].x, 1100), prints[0]);
  check('straight path: last print lands ON the last waypoint (along the line)',
        near(prints.at(-1).x, 1500), prints.at(-1));
  const fitted = 400 / (prints.length - 1);
  check('straight path: fitted stride stays within 15% of STEP_CM',
        Math.abs(fitted - STEP_CM) / STEP_CM <= 0.15, fitted);
  let steps = true, sides = true, heading = true;
  for (let i = 0; i < prints.length; i++) {
    const p = prints[i];
    if (!near(p.dirx, 1) || !near(p.diry, 0)) heading = false;
    // Alternates either side of the walking line y = 1150, by STRIDE/2.
    const want = 1150 + ((i % 2 === 0) ? 1 : -1) * STRIDE_CM / 2;
    if (!near(p.y, want)) sides = false;
    if (i && !near(p.x - prints[i - 1].x, fitted)) steps = false;
  }
  check('straight path: consecutive prints evenly spaced by the fitted stride', steps);
  check('straight path: prints alternate left/right by STRIDE_CM/2', sides, prints.map(p => p.y));
  check('straight path: every print faces along the line (+x)', heading);
}

// ---------------------------------------------------------------------------
// 2. Direction: waypoint order is the direction of travel.
// ---------------------------------------------------------------------------
{
  const fwd = walkPath({ points: [[1100, 1100], [1400, 1250]], poly: RECT }).prints;
  const rev = walkPath({ points: [[1400, 1250], [1100, 1100]], poly: RECT }).prints;
  const dx = 300 / Math.hypot(300, 150), dy = 150 / Math.hypot(300, 150);
  check('direction: forward path heads from first waypoint towards last',
        fwd.every(p => near(p.dirx, dx) && near(p.diry, dy)), fwd[0]);
  check('direction: reversed path heads the other way',
        rev.every(p => near(p.dirx, -dx) && near(p.diry, -dy)), rev[0]);
  check('direction: reversed path starts at the other end',
        Math.hypot(rev[0].x - 1400, rev[0].y - 1250) <= STRIDE_CM / 2 + 1e-6, rev[0]);
  // Prints advance monotonically along the travel direction.
  const proj = fwd.map(p => (p.x - 1100) * dx + (p.y - 1100) * dy);
  check('direction: prints are in walking order', proj.every((v, i) => i === 0 || v > proj[i - 1]), proj);
}

// ---------------------------------------------------------------------------
// 2b. The trail ARRIVES: the last print is on the last waypoint for any path
//     length, not up to a stride short of it (a fixed 34cm stride stopped a
//     real bathroom trail ~20cm short of the bath it was drawn to).
// ---------------------------------------------------------------------------
{
  let worst = 0, worstLen = 0, spacingOk = true;
  for (let len = 20; len <= 500; len += 7) {
    const ps = walkPath({ points: [[1050, 1150], [1050 + len, 1150]], poly: RECT }).prints;
    const miss = Math.abs(ps.at(-1).x - (1050 + len));
    if (miss > worst) { worst = miss; worstLen = len; }
    if (len >= 3 * STEP_CM) {
      for (let i = 1; i < ps.length; i++) {
        const d = ps[i].x - ps[i - 1].x;
        if (Math.abs(d - STEP_CM) / STEP_CM > 0.2) spacingOk = false;
      }
    }
  }
  check('endpoint: last print on the last waypoint for every length 20..500cm', worst < 1e-6, { worst, worstLen });
  check('endpoint: fitted stride within 20% of STEP_CM once a path is >= 3 strides', spacingOk);
  // Multi-segment, smoothed: still ends on the last waypoint.
  const ps = walkPath({ points: [[1100, 1100], [1300, 1100], [1300, 1260]], poly: RECT }).prints;
  const last = ps.at(-1);
  check('endpoint: smoothed multi-segment path ends on its last waypoint (within the stride offset)',
        Math.hypot(last.x - 1300, last.y - 1260) <= STRIDE_CM / 2 + 1e-6, last);
}

// ---------------------------------------------------------------------------
// 3. Door gap.
// ---------------------------------------------------------------------------
check('DOOR_GAP_CM is about 40 cm', DOOR_GAP_CM >= 35 && DOOR_GAP_CM <= 45, DOOR_GAP_CM);
{
  // One door in the WEST wall (a north-south wall at x=1000), 80 wide, centred
  // at y=1150; one in the NORTH wall (east-west, y=1000) centred at x=1400.
  const doors = [
    { id: 'west', wall: 'z', at: 1000, c: 1150, w: 80 },
    { id: 'north', wall: 'x', at: 1000, c: 1400, w: 80 },
  ];
  const op = doorOpenings(doors);
  check('doorOpenings: north-south wall -> vertical segment at x=at',
        op[0].ax === 1000 && op[0].bx === 1000 && op[0].ay === 1110 && op[0].by === 1190, op[0]);
  check('doorOpenings: east-west wall -> horizontal segment at y=at',
        op[1].ay === 1000 && op[1].by === 1000 && op[1].ax === 1360 && op[1].bx === 1440, op[1]);
  check('clearOfDoors: a point just inside the gap is refused',
        !clearOfDoors(1000 + DOOR_GAP_CM - 1, 1150, op));
  check('clearOfDoors: a point just outside the gap is allowed',
        clearOfDoors(1000 + DOOR_GAP_CM + 1, 1150, op));
  check('clearOfDoors: measured to the END of the opening, not only its centre',
        !clearOfDoors(1000 + 20, 1190 + 20, op));

  // An authored path starting right AT the west door and walking east, then
  // passing directly under the north door.
  const room = { poly: RECT, footstepPath: { points: [[1005, 1150], [1400, 1150], [1400, 1030]], smooth: false } };
  const raw = walkPath({ points: room.footstepPath.points, poly: RECT, smooth: false }).prints;
  const { prints, source } = placeTrail({ room, openings: op, auto: () => { throw new Error('auto must not run'); } });
  const minDist = ps => Math.min(...ps.map(p => Math.min(...op.map(o => distToSegment(p.x, p.y, o.ax, o.ay, o.bx, o.by)))));
  check('door gap (authored): the raw path DID reach into the gap (fixture is meaningful)',
        minDist(raw) < DOOR_GAP_CM, minDist(raw));
  check('door gap (authored): no print within DOOR_GAP_CM of any door', minDist(prints) >= DOOR_GAP_CM, minDist(prints));
  check('door gap (authored): only the offending prints were dropped',
        prints.length > 0 && prints.length < raw.length, { kept: prints.length, raw: raw.length });
  check('door gap (authored): source is the path', source === 'path', source);

  // Automatic trail: the scene hands placeTrail its auto walk; the gap must
  // apply to that too. Walk in straight from the west door with a
  // deliberately short pad so the first print lands in the gap.
  const autoRoom = { poly: RECT, footstepPath: null };
  const autoRaw = walkFootsteps({ poly: RECT, sx: 1010, sy: 1150, ux: 1, uy: 0, nPrints: 6 }).prints;
  const autoRes = placeTrail({ room: autoRoom, openings: op, auto: () => autoRaw });
  check('door gap (automatic): raw auto trail DID reach into the gap', minDist(autoRaw) < DOOR_GAP_CM, minDist(autoRaw));
  check('door gap (automatic): no print within DOOR_GAP_CM once placed', minDist(autoRes.prints) >= DOOR_GAP_CM,
        minDist(autoRes.prints));
  check('door gap (automatic): source is auto', autoRes.source === 'auto', autoRes.source);
  check('door gap (automatic): no floor -> empty trail, not a throw',
        placeTrail({ room: autoRoom, openings: op, auto: () => null }).prints.length === 0);
}

// ---------------------------------------------------------------------------
// 4. L-shaped room.
// ---------------------------------------------------------------------------
{
  // An L: a 600x150 east-west leg along the south, and a 150-wide north-south
  // leg rising at its east end. The notch (north-west) is NOT floor.
  const L = [[2000, 2000], [2600, 2000], [2600, 2600], [2450, 2600], [2450, 2150], [2000, 2150]];
  L.reverse(); // winding must not matter
  const pts = [[2050, 2075], [2525, 2075], [2525, 2550]];   // east, then south... in plan y-south
  const smooth = walkPath({ points: pts, poly: L }).prints;
  const sharp = walkPath({ points: pts, poly: L, smooth: false }).prints;
  check('L room: every print on the room floor (smoothed)', smooth.every(p => insidePoly(L, p.x, p.y)),
        smooth.filter(p => !insidePoly(L, p.x, p.y)));
  check('L room: no print in the notch', smooth.every(p => !(p.x < 2450 && p.y > 2150)));
  check('L room: the trail turns (starts heading east, ends heading south)',
        near(smooth[0].dirx, 1) && near(smooth.at(-1).diry, 1), [smooth[0], smooth.at(-1)]);
  const diag = smooth.filter(p => p.dirx > 0.2 && p.diry > 0.2);
  check('L room: smoothing gives the corner intermediate headings', diag.length >= 1, diag.length);
  check('L room: smooth:false turns on the spot (no intermediate headings)',
        sharp.every(p => near(Math.abs(p.dirx) + Math.abs(p.diry), 1)));
  check('L room: smoothing keeps the endpoints', near(smooth[0].x, 2050) &&
        Math.hypot(smooth.at(-1).x - 2525, smooth.at(-1).y - 2550) < STEP_CM + STRIDE_CM);
  // A print whose centre would fall outside the polygon is dropped, not drawn
  // in the neighbouring room: a path hugging the notch's inside corner.
  const hug = walkPath({ points: [[2050, 2145], [2440, 2145]], poly: L, smooth: false }).prints;
  check('L room: prints pushed across a wall by the stride offset are dropped',
        hug.every(p => insidePoly(L, p.x, p.y)) && hug.length < Math.floor(390 / STEP_CM) + 1, hug.length);
}

// ---------------------------------------------------------------------------
// 5. Loader: resolution, validation, fallback, precedence.
// ---------------------------------------------------------------------------
{
  const warnings = [];
  const quiet = fn => { const w = console.warn; console.warn = m => warnings.push(String(m)); try { return fn(); } finally { console.warn = w; } };
  const doc = extra => ({
    kind: 'geometry', schemaVersion: '1.1', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      { id: 1, start: [500, 500], end: [800, 500], exterior: true, thickness: 10 },
      { id: 2, start: [500, 500], end: [500, 800], exterior: true, thickness: 10 },
    ] },
    rooms: [Object.assign({ id: 'r', label: 'R', polygon: [[500, 500], [800, 500], [800, 800], [500, 800]] }, extra)],
  });
  const zone = { from: [10, 10], to: [100, 100], relativeTo: 'room' };
  const compile = extra => quiet(() => HouseLoader.compile(doc(extra), '')).rooms.r;

  check('loader: no footstepPath -> null', compile({}).footstepPath === null, compile({}).footstepPath);
  const ok = compile({ footstepPath: { points: [[50, 60], [250, 200]], relativeTo: 'room' } });
  check('loader: waypoints resolved relative to the bbox min corner',
        JSON.stringify(ok.footstepPath && ok.footstepPath.points) === JSON.stringify([[550, 560], [750, 700]]),
        ok.footstepPath);
  check('loader: smooth defaults to true', ok.footstepPath && ok.footstepPath.smooth === true);
  const noSmooth = compile({ footstepPath: { points: [[50, 60], [250, 200]], relativeTo: 'room', smooth: false } });
  check('loader: smooth:false carried through', noSmooth.footstepPath && noSmooth.footstepPath.smooth === false);

  warnings.length = 0;
  const outside = compile({ footstepPath: { points: [[50, 60], [350, 200]], relativeTo: 'room' }, footstepZone: zone });
  check('fallback: a waypoint outside the room polygon drops the whole path', outside.footstepPath === null, outside.footstepPath);
  check('fallback: ...with a warning naming the waypoint', warnings.some(w => /footstepPath waypoint 1/.test(w)), warnings);
  check('fallback: ...and the footstepZone is still in force', outside.footstepZone !== null, outside.footstepZone);
  check('fallback: one waypoint -> ignored', compile({ footstepPath: { points: [[50, 60]], relativeTo: 'room' } }).footstepPath === null);
  check('fallback: unknown relativeTo -> ignored',
        compile({ footstepPath: { points: [[50, 60], [60, 70]], relativeTo: 'house' } }).footstepPath === null);
  check('fallback: non-numeric waypoint -> ignored',
        compile({ footstepPath: { points: [[50, 60], ['a', 70]], relativeTo: 'room' } }).footstepPath === null);

  // Precedence: a valid path beats a zone -- the auto walk is never consulted.
  const both = compile({ footstepPath: { points: [[50, 150], [250, 150]], relativeTo: 'room' }, footstepZone: zone });
  let autoCalled = false;
  const res = placeTrail({ room: both, openings: [], auto: () => { autoCalled = true; return []; } });
  check('precedence: footstepPath wins over footstepZone', res.source === 'path' && !autoCalled && res.prints.length > 0,
        { source: res.source, autoCalled });
  check('precedence: prints follow the path, not the zone rectangle',
        res.prints.every(p => Math.abs(p.y - 650) <= STRIDE_CM / 2 + 1e-6), res.prints.map(p => p.y));
  const zoneOnly = compile({ footstepZone: zone });
  const res2 = placeTrail({ room: zoneOnly, openings: [], auto: () => [{ x: 1, y: 2, dirx: 1, diry: 0 }] });
  check('precedence: no path -> the automatic/zone walk is used', res2.source === 'auto' && res2.prints.length === 1);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
