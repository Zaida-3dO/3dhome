/**
 * Footstep trail placement — the geometry-only half of the presence footsteps.
 *
 * WHY THIS IS ITS OWN MODULE.
 *
 * The footstep walk in home3d-scene.js decides WHERE each print goes, then
 * builds a THREE.PlaneGeometry for it. Those are two different jobs, and only
 * the second needs a GPU. Keeping them fused made the placement rules — which
 * are pure arithmetic over a polygon — reachable only by constructing a whole
 * scene, so nothing could test them.
 *
 * That mattered for one branch in particular. `walkFootsteps` contains a
 * step-back-and-turn-once rule that carries a trail around the corner of an
 * L-shaped room instead of walking it through a wall. On the houses that ship
 * today that branch NEVER RUNS: `clearRun` pre-measures the floor ahead before
 * the walk starts, and the `areaCap`/`fits` count limits then stop the walk
 * well short of any wall. Every room on both houses terminates on the count
 * cap. So the turn is correct code that the shipped configuration cannot
 * exercise, and the first thing ever to run it would be a future change to
 * areaCap, STEP_CM, or a house profile with a long thin room — in front of a
 * user.
 *
 * Splitting it out is what lets scripts/test-footstep-turn.mjs walk a
 * synthetic L-shaped room with the count caps lifted and assert the turn
 * actually fires and keeps every print inside the polygon. See that file.
 *
 * Nothing here touches THREE, the DOM, or any module-level state: every
 * function takes what it needs and returns a value. The caller keeps all
 * rendering.
 *
 * Units are centimetres in the house's plan coordinates throughout, matching
 * the polygons in a house profile's geometry.json.
 */

/**
 * Is a point inside the room polygon? Ray casting.
 *
 * Used so a trail in an L-shaped room stays on that room's actual floor
 * instead of crossing into the notch, which is the one way a floor decal
 * betrays that it was placed from a bounding box.
 *
 * @param {Array<[number, number]>} poly  Room polygon, closed implicitly.
 * @param {number} px
 * @param {number} py
 * @returns {boolean}
 */
export function insidePoly(poly, px, py) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * How far you can walk from (x,y) along (dx,dy) before leaving the room,
 * capped at `limit`.
 *
 * Sampled rather than solved analytically: the polygon is arbitrary (up to 8
 * verts on the houses here) and this runs a few dozen times at BUILD time
 * only, so a clean 8cm sample beats an edge-intersection routine nobody can
 * read.
 *
 * @returns {number} Distance in cm, a multiple of 8 unless it returns `limit`.
 */
export function clearRun(poly, x, y, dx, dy, limit) {
  const STEP = 8;
  let t = 0;
  while (t + STEP <= limit) {
    if (!insidePoly(poly, x + dx * (t + STEP), y + dy * (t + STEP))) return t;
    t += STEP;
  }
  return limit;
}

/** Shoelace area in m², for sizing the trail to the room. */
export function polyAreaSqm(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2 / 10000;
}

/**
 * The stride constants. Exported so a caller and a test agree on them by
 * construction rather than by two copies that can drift.
 */
export const WALK_DEFAULTS = Object.freeze({
  STEP_CM: 34,      // stride length, centimetres
  STRIDE_CM: 17,    // left/right offset from the walking line
  PRINT_CM: 26,     // long axis of one print
  PAD_CM: 55,       // how far in from the threshold the trail starts
});

/**
 * How many prints to lay. Two limits, whichever is tighter: what physically
 * fits in the clear run ahead, and what suits the room's size. A small room
 * such as an en suite or a bathroom should read as a few steps in through the
 * door, not as a march from one wall to the other.
 *
 * @param {number} areaSqm  Room area in m².
 * @param {number} run      Clear run ahead in cm.
 * @param {number} stepCm   Stride length in cm.
 * @returns {number}
 */
export function printCount(areaSqm, run, stepCm) {
  const areaCap = (areaSqm < 5) ? 3 : (areaSqm < 9) ? 4 : 6;
  const fits = Math.floor((run - 12) / stepCm) + 1;
  return Math.max(2, Math.min(areaCap, fits));
}

/**
 * Walk a trail of footprints into a room and return WHERE each one goes.
 *
 * Returns placements only — no geometry, no meshes. The caller turns each
 * placement into whatever it renders.
 *
 * The walk starts at (sx, sy) heading along the unit vector (ux, uy),
 * alternating left and right of the walking line by STRIDE_CM/2. If a print
 * would land outside the polygon the walk steps BACK one stride and turns ONCE
 * toward whichever side still has floor — that is what carries a trail around
 * the corner of an L instead of out of it — and gives up if neither side has
 * room for a stride and a half (a dead end, not a corner).
 *
 * @param {object} opts
 * @param {Array<[number,number]>|null} opts.poly
 *        Room polygon. If null, `bounds` is used as a rectangular fallback and
 *        NO turn is attempted (there is no polygon to find a corner in).
 * @param {{x1:number,y1:number,x2:number,y2:number}} [opts.bounds]
 *        Rectangular fallback, required when `poly` is null.
 * @param {number} opts.sx  Start x.
 * @param {number} opts.sy  Start y.
 * @param {number} opts.ux  Initial direction x (unit).
 * @param {number} opts.uy  Initial direction y (unit).
 * @param {number} opts.nPrints  How many prints to lay.
 * @param {number} [opts.stepCm]    Defaults to WALK_DEFAULTS.STEP_CM.
 * @param {number} [opts.strideCm]  Defaults to WALK_DEFAULTS.STRIDE_CM.
 * @param {number} [opts.maxIterations]
 *        Loop bound. Defaults to nPrints + 4, which is the shipped behaviour:
 *        enough slack for a turn (which consumes an iteration without laying a
 *        print) without letting a pathological polygon spin. A test lifting the
 *        count caps raises this alongside nPrints.
 * @returns {{prints: Array<{x:number,y:number,dirx:number,diry:number}>, turned: boolean}}
 *          `prints` in walking order; `turned` is whether the turn branch fired.
 */
export function walkFootsteps(opts) {
  const {
    poly, bounds, sx, sy, ux, uy, nPrints,
    stepCm = WALK_DEFAULTS.STEP_CM,
    strideCm = WALK_DEFAULTS.STRIDE_CM,
  } = opts;
  const maxIterations = (opts.maxIterations === undefined)
    ? nPrints + 4
    : opts.maxIterations;

  const prints = [];
  let wx = sx, wy = sy, dirx = ux, diry = uy, turned = false;

  for (let i = 0; prints.length < nPrints && i < maxIterations; i++) {
    const perpx = -diry, perpy = dirx;
    const side = (prints.length % 2 === 0) ? 1 : -1;
    const fx = wx + perpx * side * (strideCm / 2);
    const fy = wy + perpy * side * (strideCm / 2);

    const outside = poly
      ? !insidePoly(poly, fx, fy)
      : (fx < bounds.x1 || fx > bounds.x2 || fy < bounds.y1 || fy > bounds.y2);

    if (outside) {
      // The leg ran out. Rather than dropping this print and marching on
      // regardless — which is what used to leave a trail petering out through
      // a wall — step back and turn ONCE toward whichever side still has
      // floor. That is what carries a trail around the corner of an L instead
      // of out of it.
      if (turned || !poly) break;
      const bx = wx - dirx * stepCm, by = wy - diry * stepCm;
      const lr = clearRun(poly, bx, by, -diry, dirx, 1200);
      const rr = clearRun(poly, bx, by, diry, -dirx, 1200);
      if (Math.max(lr, rr) < stepCm * 1.5) break;   // a dead end, not a corner
      wx = bx; wy = by;
      if (lr >= rr) { const t = dirx; dirx = -diry; diry = t; }
      else { const t = dirx; dirx = diry; diry = -t; }
      turned = true;
      continue;
    }

    prints.push({ x: fx, y: fy, dirx, diry });
    wx += dirx * stepCm;
    wy += diry * stepCm;
  }

  return { prints, turned };
}
