#!/usr/bin/env node
/**
 * Footstep turn-at-the-corner tests. No framework, no dependencies -
 * `node scripts/test-footstep-turn.mjs`.
 *
 * WHAT THIS GUARDS, AND WHY IT NEEDS A SYNTHETIC ROOM TO DO IT.
 *
 * walkFootsteps() lays a trail of prints into a room, and contains a rule for
 * what to do when the trail reaches a wall: step BACK one stride and turn ONCE
 * toward whichever side still has floor. That is what carries a trail around
 * the corner of an L-shaped room instead of walking it out through the wall.
 *
 * THAT BRANCH NEVER RUNS ON EITHER HOUSE THAT SHIPS TODAY. clearRun()
 * pre-measures the clear floor ahead BEFORE the walk starts, and printCount()
 * then caps the trail at 3, 4 or 6 prints by room area. Measured across all 17
 * rooms of both house profiles, every single room terminates on that COUNT CAP
 * — the walk stops long before any print could land outside the polygon, so
 * neither the in-loop containment check nor the turn below is ever reached.
 *
 * So the turn is correct code in an unreachable configuration, which is the
 * shape of thing that rots without anyone noticing. Three-way mutation
 * isolation on the shipped houses showed precisely that:
 *
 *   - break containment only          -> 0 prints outside (the count cap masks it)
 *   - remove the count limits only    -> 0 prints outside, and the turn FIRES
 *   - break both                      -> 329 prints outside, one room's trail
 *                                        reaching x=2450 in a house that ends
 *                                        at x=1284
 *
 * The middle row is the property worth freezing, and it is what this file
 * asserts: with the count caps lifted, a trail walked into an L-shaped room
 * must (a) keep every print inside the polygon, and (b) actually change
 * direction. A future change to the area caps, to STEP_CM, or a house profile
 * with one long thin room would otherwise be the first thing ever to execute
 * this branch — in front of a user.
 *
 * Lifting the caps is the whole reason walkFootsteps() takes nPrints and
 * maxIterations as arguments rather than computing them: a test cannot reach
 * the interesting behaviour of the shipped configuration, so it asks for the
 * configuration that reaches it.
 *
 * The room is synthetic rather than one of the demo house's. That is
 * deliberate: this asserts a property of the ALGORITHM, and pinning it to a
 * profile's polygon would make an unrelated edit to that house look like a
 * footstep regression.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { insidePoly, clearRun, polyAreaSqm, printCount, walkFootsteps, WALK_DEFAULTS } =
  await import(pathToFileURL(path.join(root, 'src/footstep-walk.js')).href);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS  ' + label); pass++; }
  else { console.log('FAIL  ' + label + (detail ? '   -> ' + detail : '')); fail++; }
}

// ---------------------------------------------------------------------------
// The fixture. An L, 6m east-west along the top and 5m north-south down the
// right-hand leg, both legs 2m wide. Plan coordinates in cm, wound the same
// way a house profile's polygon is.
//
//   (0,0) ------------------------- (600,0)
//     |                                 |
//     |            top leg              |
//   (0,200) ------------ (400,200)      |
//                          |            |
//                          |  right leg |
//                       (400,500) -- (600,500)
//
// The walk enters at the west end of the top leg heading EAST. It must run out
// of floor at x=600 and turn SOUTH down the right leg. The notch — the square
// below the top leg and left of the right leg — is the region a trail that
// failed to turn, or turned the wrong way, would stray into.
// ---------------------------------------------------------------------------
const L_ROOM = [[0, 0], [600, 0], [600, 500], [400, 500], [400, 200], [0, 200]];

// Sanity-check the fixture itself before asserting anything with it. A typo in
// the polygon that made it, say, a plain rectangle would let every assertion
// below pass while testing nothing.
{
  check('fixture: a point in the top leg is inside',
        insidePoly(L_ROOM, 300, 100) === true);
  check('fixture: a point in the right leg is inside',
        insidePoly(L_ROOM, 500, 400) === true);
  check('fixture: the NOTCH is outside (this is what makes it an L)',
        insidePoly(L_ROOM, 200, 400) === false,
        'if this is inside, the fixture is a rectangle and the turn is untested');
  check('fixture: a point beyond the east wall is outside',
        insidePoly(L_ROOM, 700, 100) === false);
}

// ---------------------------------------------------------------------------
// 1. THE CORE PROPERTY. Walk east into the L with the count caps lifted.
//    Every print must stay inside the polygon AND the direction must change.
//
//    Breaks if the turn branch is removed (the walk would stop at the wall
//    with no direction change), if `turned` is never set (it would turn
//    repeatedly), or if the turn arithmetic is broken (prints leave the room).
// ---------------------------------------------------------------------------
const LIFTED = 40;   // far more prints than any areaCap would ever allow
const walk = walkFootsteps({
  poly: L_ROOM,
  sx: 40, sy: 100,        // just inside the west end, on the top leg's centreline
  ux: 1, uy: 0,           // heading east, along the long leg
  nPrints: LIFTED,
  maxIterations: LIFTED * 5,
});

check('the walk laid a usable number of prints',
      walk.prints.length >= 20, 'laid ' + walk.prints.length);

{
  const outside = walk.prints.filter(p => !insidePoly(L_ROOM, p.x, p.y));
  check('ZERO prints fall outside the polygon',
        outside.length === 0,
        outside.length
          ? outside.length + ' outside, e.g. ' +
            outside.slice(0, 3).map(p => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(' ')
          : '');
}

check('the turn branch actually fired (walk.turned)',
      walk.turned === true,
      'if false, this test proves nothing about the turn - it never ran');

// The direction change is asserted from the PRINTS, independently of the
// `turned` flag. A flag can be set without the trail changing course; the
// prints are the thing a user sees.
const dirs = [];
for (const p of walk.prints) {
  const key = p.dirx + ',' + p.diry;
  if (dirs[dirs.length - 1] !== key) dirs.push(key);
}
check('the trail direction changes EXACTLY once',
      dirs.length === 2, 'direction runs: ' + JSON.stringify(dirs));
check('  ...starting eastward', dirs[0] === '1,0', 'first: ' + dirs[0]);
check('  ...and ending southward, down the L\'s other leg',
      dirs[1] === '0,1', 'second: ' + dirs[1]);

// Prints must appear in BOTH legs. A trail that turned immediately, or that
// stopped at the corner, could satisfy "direction changed once" while never
// really rounding the corner.
{
  const inTop = walk.prints.filter(p => p.y < 200).length;
  const inRight = walk.prints.filter(p => p.y > 200 && p.x > 400).length;
  check('prints were laid in the first leg', inTop > 0, 'top leg: ' + inTop);
  check('prints were laid in the second leg AFTER the corner',
        inRight > 0, 'right leg: ' + inRight);
}

// The turn happens once and only once: the rule is "turn ONCE", so a trail
// that ping-ponged between legs would be a regression even if it stayed inside.
check('the walk never turns a second time',
      dirs.length <= 2, 'direction runs: ' + JSON.stringify(dirs));

// Prints alternate LEFT and RIGHT of the walking line, starting on the left
// (side = +1 for the first print, which for a perpendicular of (-diry, dirx)
// puts it on the walker's left). Without this the stride could be mirrored --
// every print landing on the wrong foot -- and nothing else here would notice:
// containment, the turn and the direction runs all survive a mirrored stride.
{
  const half = WALK_DEFAULTS.STRIDE_CM / 2;
  // Assert the ALTERNATION first: consecutive prints within a leg must sit on
  // opposite sides of the walking line, a full stride apart across it. This is
  // measured from the prints themselves rather than by restating the formula
  // that produced them.
  let alternates = true;
  for (let i = 1; i < walk.prints.length; i++) {
    const a = walk.prints[i - 1], b = walk.prints[i];
    if (a.dirx !== b.dirx || a.diry !== b.diry) continue;  // leg change, skip
    const perpx = -b.diry, perpy = b.dirx;
    const oa = a.x * perpx + a.y * perpy;
    const ob = b.x * perpx + b.y * perpy;
    // Consecutive prints in a leg differ by a full stride across the line.
    if (Math.abs(Math.abs(ob - oa) - WALK_DEFAULTS.STRIDE_CM) > 1e-6) alternates = false;
  }
  check('consecutive prints alternate across the walking line by one stride',
        alternates, 'expected |offset delta| == ' + WALK_DEFAULTS.STRIDE_CM);

  // And the FIRST print is on the left of the line through the start point.
  // This is the half that a mirrored stride breaks.
  const p0 = walk.prints[0];
  const perpx = -p0.diry, perpy = p0.dirx;
  const offset0 = (p0.x - 40) * perpx + (p0.y - 100) * perpy;
  check('the first print is laid on the LEFT of the walking line',
        Math.abs(offset0 - half) < 1e-6,
        `offset=${offset0.toFixed(2)} expected ${half}`);
}

// ---------------------------------------------------------------------------
// 2. The SHIPPED configuration is unchanged by all of the above. This is the
//    control: it records that the count cap really is what stops the walk on a
//    normal room, so if a future change makes the turn reachable in shipped
//    config, THIS is the assertion that notices.
// ---------------------------------------------------------------------------
{
  const run = clearRun(L_ROOM, 40, 100, 1, 0, 1200);
  const area = polyAreaSqm(L_ROOM);
  const n = printCount(area, run, WALK_DEFAULTS.STEP_CM);
  const shipped = walkFootsteps({
    poly: L_ROOM, sx: 40, sy: 100, ux: 1, uy: 0, nPrints: n,
  });
  check('with the shipped caps the walk stops on the COUNT cap, not the wall',
        shipped.prints.length === n && shipped.turned === false,
        `area=${area.toFixed(1)}m2 run=${run} nPrints=${n} ` +
        `laid=${shipped.prints.length} turned=${shipped.turned}`);
  check('  ...and those prints are inside the polygon too',
        shipped.prints.every(p => insidePoly(L_ROOM, p.x, p.y)));
}

// ---------------------------------------------------------------------------
// 3. A DEAD END is not a corner. Walking into the closed end of a NARROW
//    corridor must simply stop, never turn into a wall.
//
//    The guard is `Math.max(lr, rr) < stepCm * 1.5`, i.e. a sideways run of
//    less than 51cm is a dead end rather than a corner. So the corridor here is
//    80cm wide: from its centreline there is at most 40cm of floor either way,
//    which is under the threshold. (A 120cm corridor is NOT a dead end by this
//    rule — it leaves 56cm each way and the walk legitimately turns across it.
//    That is worth stating because it is the obvious fixture to reach for and
//    it tests the opposite thing.)
//
//    Breaks if the dead-end guard is removed or its threshold is lowered.
// ---------------------------------------------------------------------------
{
  const NARROW = [[0, 0], [400, 0], [400, 80], [0, 80]];
  const w = walkFootsteps({
    poly: NARROW, sx: 30, sy: 40, ux: 1, uy: 0,
    nPrints: LIFTED, maxIterations: LIFTED * 5,
  });
  check('a dead end stops the walk rather than turning',
        w.turned === false, 'turned=' + w.turned);
  check('  ...and no print escapes the corridor',
        w.prints.every(p => insidePoly(NARROW, p.x, p.y)));
}

// ---------------------------------------------------------------------------
// 4. The turn picks the side that HAS floor. Same L, but entered from the
//    south end of the right leg heading north: the only way on is west along
//    the top leg, i.e. the opposite hand to case 1. A turn hardcoded to one
//    side would pass case 1 and fail here.
// ---------------------------------------------------------------------------
{
  const w = walkFootsteps({
    poly: L_ROOM, sx: 500, sy: 460, ux: 0, uy: -1,
    nPrints: LIFTED, maxIterations: LIFTED * 5,
  });
  check('entering from the other end also turns', w.turned === true);
  check('  ...and keeps every print inside',
        w.prints.every(p => insidePoly(L_ROOM, p.x, p.y)));
  const d = [];
  for (const p of w.prints) {
    const key = p.dirx + ',' + p.diry;
    if (d[d.length - 1] !== key) d.push(key);
  }
  check('  ...turning WEST into the top leg, not east into the wall',
        d.length === 2 && d[0] === '0,-1' && d[1] === '-1,0',
        'direction runs: ' + JSON.stringify(d));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
