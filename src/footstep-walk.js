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

/**
 * The Y-axis turn that makes one footprint quad point its toe along the walk.
 *
 * The caller builds each print as a PlaneGeometry whose +Y edge carries the
 * ball of the foot (the footprint canvas draws the ball pad at the top, and
 * CanvasTexture.flipY maps the canvas top to v=1, the plane's +Y edge), lays
 * it flat with rotateX(-PI/2) — which sends +Y to world -Z — and then turns it
 * with rotateY(printYaw(dirx, diry)). Plan x maps to world +X and plan y to
 * world +Z, so the toe must end up along world (dirx, 0, diry).
 *
 * rotateY(b) takes (0,0,-1) to (-sin b, 0, -cos b). Setting that equal to
 * (cos phi, 0, sin phi), with phi = atan2(diry, dirx), gives b = -phi - PI/2.
 * The previous `-phi + PI/2` differs by exactly PI: it pointed every toe
 * AGAINST the walk, so each trail read as walking backwards
 * (scripts/test-footprint-orientation.mjs).
 *
 * @param {number} dirx  Walking direction x, in plan coordinates.
 * @param {number} diry  Walking direction y, in plan coordinates.
 * @returns {number} Radians for rotateY.
 */
export function printYaw(dirx, diry) {
  return -Math.atan2(diry, dirx) - Math.PI / 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Door gap — a rule for EVERY trail, authored or automatic.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How close a print's centre may come to any door opening, in cm.
 *
 * A trail is meant to read as someone walking about INSIDE one room. A print
 * sitting on or right beside a threshold reads instead as someone standing in
 * the doorway between two rooms — and on a floor plan it visibly straddles the
 * wall line. So no print is laid within this distance of any door's opening,
 * whichever room the door belongs to and whichever way the trail was placed.
 *
 * Measured from the print's CENTRE to the nearest point of the door's opening
 * (the segment of wall line the leaf fills when shut). The centre, not the
 * print's edge, so a trail down the middle of a ~1m corridor lined with doors
 * still fits: the centre line of a 99cm corridor puts each alternating print
 * ~41cm from either wall line.
 */
export const DOOR_GAP_CM = 40;

/**
 * The opening each compiled door leaves in its wall, as a segment in plan cm.
 *
 * Takes the loader's compiled door schedule (`wall` is the axis the wall runs
 * along: 'x' means an east-west wall at y = `at`; anything else a north-south
 * wall at x = `at`; `c` is the door's centre along the wall and `w` its width).
 *
 * @param {Array<{id:string, wall:string, at:number, c:number, w:number}>} doors
 * @returns {Array<{id:string, ax:number, ay:number, bx:number, by:number}>}
 */
export function doorOpenings(doors) {
  return (doors || []).map(d => {
    const half = (d.w || 0) / 2;
    return (d.wall === 'x')
      ? { id: d.id, ax: d.c - half, ay: d.at, bx: d.c + half, by: d.at }
      : { id: d.id, ax: d.at, ay: d.c - half, bx: d.at, by: d.c + half };
  });
}

/** Distance from a point to a segment. */
export function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + vx * t, qy = ay + vy * t;
  return Math.hypot(px - qx, py - qy);
}

/**
 * Is (x, y) at least `gapCm` from every door opening?
 *
 * @param {number} x
 * @param {number} y
 * @param {Array<{ax:number,ay:number,bx:number,by:number}>} openings  From doorOpenings().
 * @param {number} [gapCm]  Defaults to DOOR_GAP_CM.
 */
export function clearOfDoors(x, y, openings, gapCm = DOOR_GAP_CM) {
  for (const o of openings) {
    if (distToSegment(x, y, o.ax, o.ay, o.bx, o.by) < gapCm) return false;
  }
  return true;
}

/**
 * Drop every print that sits within the door gap. Order is preserved, so the
 * trail still walks the way it did; a dropped print simply is not drawn.
 *
 * @template {{x:number,y:number}} P
 * @param {P[]} prints
 * @param {Array<{ax:number,ay:number,bx:number,by:number}>} openings
 * @param {number} [gapCm]
 * @returns {P[]}
 */
export function applyDoorGap(prints, openings, gapCm = DOOR_GAP_CM) {
  return prints.filter(p => clearOfDoors(p.x, p.y, openings, gapCm));
}

// ─────────────────────────────────────────────────────────────────────────────
// Authored paths — `rooms[].footstepPath`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Round a polyline's corners by Chaikin corner-cutting, keeping both
 * endpoints exactly where they were authored.
 *
 * Each pass replaces every interior corner with two points a quarter and three
 * quarters of the way along its neighbouring segments. Two passes turn a sharp
 * right angle into a curve a walker could actually follow, while the start
 * (just inside the room, clear of the door) and the end (where the owner said
 * the walk stops) stay put.
 *
 * @param {Array<[number,number]>} points
 * @param {number} [passes]
 * @returns {Array<[number,number]>}
 */
export function smoothPolyline(points, passes = 2) {
  let pts = points.map(p => [p[0], p[1]]);
  if (pts.length < 3) return pts;
  for (let k = 0; k < passes; k++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const q = [ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25];
      const r = [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75];
      if (i > 0) out.push(q);
      if (i < pts.length - 2) out.push(r);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/**
 * Lay prints along an authored polyline, in waypoint order.
 *
 * The walking line starts exactly on the first waypoint and ends exactly on
 * the last, advancing by a stride FITTED to the path length (the whole
 * division of the path nearest `stepCm`), so the trail runs from the first
 * waypoint to the last — waypoint order IS the direction of travel. Each
 * print sits `strideCm / 2` either side of the line, alternating, and faces
 * along the line's direction at that point.
 *
 * Unlike the automatic walk there is no count cap: the author drew the length
 * they wanted.
 *
 * @param {object} opts
 * @param {Array<[number,number]>} opts.points  Absolute plan cm, >= 2.
 * @param {Array<[number,number]>|null} [opts.poly]
 *        Room polygon. A print whose centre falls outside it (a stride offset
 *        across a wall on a tight corner) is dropped rather than drawn in the
 *        next room.
 * @param {boolean} [opts.smooth]  Round interior corners (default true).
 * @param {number} [opts.stepCm]
 * @param {number} [opts.strideCm]
 * @returns {{prints: Array<{x:number,y:number,dirx:number,diry:number}>}}
 */
export function walkPath(opts) {
  const {
    points, poly = null, smooth = true,
    stepCm = WALK_DEFAULTS.STEP_CM,
    strideCm = WALK_DEFAULTS.STRIDE_CM,
  } = opts;
  const prints = [];
  if (!Array.isArray(points) || points.length < 2) return { prints };
  const pts = smooth ? smoothPolyline(points) : points.map(p => [p[0], p[1]]);

  // Segments with their start distance along the line; zero-length ones skipped.
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    segs.push({ ax, ay, ux: (bx - ax) / len, uy: (by - ay) / len, s0: total, len });
    total += len;
  }
  if (!segs.length) return { prints };

  // Fit the stride to the path so the LAST print lands on the last waypoint:
  // the author's endpoint (the bath, the radiator) is where the walk should
  // visibly arrive, and whole fixed strides could stop up to a stride short.
  // The fitted stride is the nearest whole division of the path, so it stays
  // within ~15% of stepCm for any path longer than a few strides.
  const intervals = Math.max(1, Math.round(total / stepCm));
  const step = total / intervals;
  let si = 0;
  for (let k = 0, s = 0; k <= intervals; k++, s = Math.min(total, k * step)) {
    while (si < segs.length - 1 && s > segs[si].s0 + segs[si].len) si++;
    const g = segs[si];
    const t = s - g.s0;
    const wx = g.ax + g.ux * t, wy = g.ay + g.uy * t;
    // Side by STRIDE index, not by prints laid, so a dropped print leaves the
    // left/right rhythm of the rest intact.
    const side = (k % 2 === 0) ? 1 : -1;
    const x = wx + (-g.uy) * side * (strideCm / 2);
    const y = wy + (g.ux) * side * (strideCm / 2);
    if (poly && !insidePoly(poly, x, y)) continue;
    prints.push({ x, y, dirx: g.ux, diry: g.uy });
  }
  return { prints };
}

/**
 * Where a room's trail goes, all rules applied. The one decision the scene
 * delegates here so it can be tested without a GPU:
 *
 *   1. an authored `footstepPath` (already resolved to absolute cm by the
 *      loader) wins outright -- the zone and the automatic walk are not even
 *      consulted;
 *   2. otherwise `auto()` supplies the automatic trail (zone or door walk);
 *   3. EITHER WAY, the door gap then removes any print within `gapCm` of a
 *      door opening.
 *
 * @param {object} opts
 * @param {{poly?:Array<[number,number]>, footstepPath?:{points:Array<[number,number]>, smooth?:boolean}|null}} opts.room
 * @param {Array<{ax:number,ay:number,bx:number,by:number}>} opts.openings  From doorOpenings().
 * @param {() => (Array<{x:number,y:number,dirx:number,diry:number}>|null)} opts.auto
 * @param {number} [opts.gapCm]
 * @returns {{prints: Array<{x:number,y:number,dirx:number,diry:number}>, source: 'path'|'auto'|'none'}}
 */
export function placeTrail(opts) {
  const { room, openings, auto, gapCm = DOOR_GAP_CM } = opts;
  let prints, source;
  if (room.footstepPath) {
    prints = walkPath({
      points: room.footstepPath.points,
      poly: room.poly || null,
      smooth: room.footstepPath.smooth !== false,
    }).prints;
    source = 'path';
  } else {
    prints = auto();
    source = prints ? 'auto' : 'none';
    if (!prints) prints = [];
  }
  return { prints: applyDoorGap(prints, openings, gapCm), source };
}
