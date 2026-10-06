/**
 * doorway-walk.js -- room-to-room camera travel that stays INSIDE the house.
 *
 * The old flight between two in-room views rose over the wall tops, crossed
 * the roof and dropped back in. This walks instead: out through the door (or
 * an open-plan opening), along the hall, in through the next door, turning to
 * look where it is going and then to the view -- always below the ceiling and
 * never through a wall.
 *
 * Pure: no THREE, no DOM. The scene (src/home3d-scene.js) builds the graph
 * once from the compiled house and asks for a plan per flight. Tested in
 * scripts/test-doorway-walk.mjs.
 *
 * WORLD COORDINATES throughout: a polygon is [[x, z], ...] in metres (the
 * room's inner wall faces), heights are metres above the floor.
 *
 *   buildNavGraph   rooms + doors + walls -> portals (door openings and
 *                   open-plan joins) and the room adjacency
 *   planWalk        a camera path from one in-room pose to another: Dijkstra
 *                   over the portals, straight through each opening, corner
 *                   waypoints inside L-shaped rooms, a centripetal
 *                   Catmull-Rom spline through the lot, checked sample by
 *                   sample (inside a room or an opening, under the ceiling)
 *   outsideView     the view of a room no camera can stand in (a cupboard):
 *                   from the neighbouring room, through its door
 */
import { insidePoly } from './footstep-walk.js';
import { distToPolyEdge, shortestArc, eyeOf, clonePose, poseFromLook, interiorPoint } from './camera-focus.js';

export const WALK = Object.freeze({
  eyeY: 1.6,            // walking eye height (m) through an opening
  doorHeadroom: 0.3,    // ... and at least this far under the opening's head
  ceilingGap: 0.2,      // never closer than this to the ceiling
  minY: 0.4,
  approach: 0.5,        // straight run (m) before and after each opening
  clear: 0.25,          // in-room legs keep this far off the walls (where the ends allow)
  probe: 0.15,          // past the wall face, to find the room on each side of a door
  maxGap: 0.45,         // two room edges this close and facing are candidates for a join
  minOpen: 0.5,         // an unwalled stretch at least this long is an open-plan join
  wideMargin: 0.4,      // a wide opening is crossed at least this far in from its ends
  travelPitchDeg: 6,    // looking slightly down while walking
  turnOut: 1.0,         // m of travel over which the camera turns to the walking direction
  turnIn: 1.5,          // m of travel over which it turns to the final view
  lookChord: 1.6,       // m: the walking direction is the path's chord this long (turns start before a door)
  minMs: 800, maxMs: 4000,
  walkSpeed: 6.5,       // m/s of cruise a straight stretch is timed at
  maxYawRate: 200,      // deg/s: the head never turns faster than this (while the cap allows)
  sample: 0.02,         // m between validation samples
  obstacleMinY: 1.2,    // furniture taller than this is walked round
  obstaclePad: 0.15,
  outsideStandoff: 1.3, // how far back from a cupboard's door its view stands
  outsideAimY: 1.0,
  outsideFov: 70,       // vertical, degrees: the widest an outside view gets
  outsideMinFov: 45,    // ... and the narrowest
  outsideMargin: 0.3,   // m either side of the opening kept in frame
  clutterReach: 1.5,    // m: a door leaf nearer than this, in frame, crowds an outside view
  clutterPenalty: 0.5,
});

const hyp = Math.hypot;
const smooth = x => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** The room whose polygon holds (x, z), or null. */
export function roomAt(rooms, x, z) {
  for (const id of Object.keys(rooms)) if (insidePoly(rooms[id], x, z)) return id;
  return null;
}

/** Inward unit normal of edge a -> b of `poly`. */
function inward(poly, a, b) {
  const l = hyp(b[0] - a[0], b[1] - a[1]) || 1;
  let nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l;
  const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, e = Math.min(0.02, l / 4);
  if (!insidePoly(poly, mx + nx * e, mz + nz * e)) { nx = -nx; nz = -nz; }
  return [nx, nz];
}

/** Intervals [s, e] minus the sorted cuts. */
function subtract(iv, cuts) {
  let out = [iv];
  cuts.forEach(([c0, c1]) => {
    const next = [];
    out.forEach(([s, e]) => {
      if (c1 <= s || c0 >= e) { next.push([s, e]); return; }
      if (c0 > s) next.push([s, c0]);
      if (c1 < e) next.push([c1, e]);
    });
    out = next;
  });
  return out;
}

/**
 * The navigation graph.
 * @param o.rooms  { id: [[x, z]] }  room polygons (inner faces), world metres
 * @param o.doors  [{ id, c: [x, z], u: [ux, uz] (along the wall, unit), width, depth, top }]
 *                 a door opening: centre on the wall centreline, its width,
 *                 the wall's thickness (depth) and the opening's head height
 * @param o.walls  [{ a: [x, z], b: [x, z], thickness }]  wall centrelines
 * @param o.ceiling  ceiling height (m)
 * @returns { rooms, portals: [{ id, kind, rooms: [r0, r1], c, u, n, width, depth, top }], adj: { room: [portal index] } }
 *          n points from rooms[0] into rooms[1]
 */
export function buildNavGraph(o) {
  const rooms = o.rooms || {}, opt = Object.assign({}, WALK, o.options || {});
  const ceiling = o.ceiling > 0 ? o.ceiling : 2.5;
  const portals = [];
  // Doors: the room on each side, found by probing just past each wall face.
  (o.doors || []).forEach(d => {
    const ul = hyp(d.u[0], d.u[1]) || 1, u = [d.u[0] / ul, d.u[1] / ul], n = [-u[1], u[0]];
    const side = s => {
      for (const k of [1, 2.5, 5]) {
        const t = (d.depth || 0) / 2 + opt.probe * k;
        const r = roomAt(rooms, d.c[0] + n[0] * t * s, d.c[1] + n[1] * t * s);
        if (r) return r;
      }
      return null;
    };
    const r0 = side(-1), r1 = side(1);
    if (!r0 || !r1 || r0 === r1) return;   // a front door, or a door into nothing modelled
    // How far each room's polygon actually starts from the wall's centreline:
    // a traced plan rarely puts a room face exactly on the wall face.
    const reach = (room, s) => {
      for (let t = 0; t <= (d.depth || 0) / 2 + opt.probe * 5; t += 0.005) {
        if (insidePoly(rooms[room], d.c[0] + n[0] * t * s, d.c[1] + n[1] * t * s)) return t;
      }
      return (d.depth || 0) / 2;
    };
    portals.push({ id: d.id, kind: 'door', rooms: [r0, r1], c: d.c.slice(), u, n, width: d.width, depth: d.depth || 0,
      reach: [reach(r0, -1), reach(r1, 1)], top: Math.min(d.top > 0 ? d.top : ceiling, ceiling) });
  });
  // Open-plan joins: two room edges facing each other across a narrow gap,
  // overlapping along their length, with no wall standing in the gap.
  const ids = Object.keys(rooms);
  const walls = (o.walls || []).map(w => ({ a: w.a, b: w.b, t: w.thickness || 0 }));
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const P = rooms[ids[i]], Q = rooms[ids[j]];
    for (let pi = 0; pi < P.length; pi++) {
      const a = P[pi], b = P[(pi + 1) % P.length];
      const L = hyp(b[0] - a[0], b[1] - a[1]);
      if (L < opt.minOpen) continue;
      const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], ni = inward(P, a, b);
      for (let qi = 0; qi < Q.length; qi++) {
        const c = Q[qi], e = Q[(qi + 1) % Q.length];
        const M = hyp(e[0] - c[0], e[1] - c[1]);
        if (M < opt.minOpen) continue;
        const v = [(e[0] - c[0]) / M, (e[1] - c[1]) / M];
        if (Math.abs(u[0] * v[1] - u[1] * v[0]) > 0.01) continue;   // not parallel
        const nj = inward(Q, c, e);
        if (ni[0] * nj[0] + ni[1] * nj[1] > -0.99) continue;        // not facing
        const gap = -((c[0] - a[0]) * ni[0] + (c[1] - a[1]) * ni[1]);
        if (gap < -0.01 || gap > opt.maxGap) continue;
        const s0 = (c[0] - a[0]) * u[0] + (c[1] - a[1]) * u[1], s1 = (e[0] - a[0]) * u[0] + (e[1] - a[1]) * u[1];
        const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(L, Math.max(s0, s1));
        if (hi - lo < opt.minOpen) continue;
        const g = Math.max(0, gap);
        const cuts = [];
        walls.forEach(w => {
          const wl = hyp(w.b[0] - w.a[0], w.b[1] - w.a[1]);
          if (!(wl > 0)) return;
          if (Math.abs(u[0] * (w.b[1] - w.a[1]) / wl - u[1] * (w.b[0] - w.a[0]) / wl) > 0.02) return;
          const off = -((w.a[0] - a[0]) * ni[0] + (w.a[1] - a[1]) * ni[1]);   // outward of P
          if (off - w.t / 2 > g + 0.01 || off + w.t / 2 < -0.01) return;       // not in the gap
          const t0 = (w.a[0] - a[0]) * u[0] + (w.a[1] - a[1]) * u[1], t1 = (w.b[0] - a[0]) * u[0] + (w.b[1] - a[1]) * u[1];
          cuts.push([Math.min(t0, t1) - w.t / 2, Math.max(t0, t1) + w.t / 2]);
        });
        subtract([lo, hi], cuts).filter(([s, e2]) => e2 - s >= opt.minOpen).forEach(([s, e2]) => {
          const m = (s + e2) / 2;
          const cx = a[0] + u[0] * m - ni[0] * g / 2, cz = a[1] + u[1] * m - ni[1] * g / 2;
          portals.push({ id: 'open:' + ids[i] + '|' + ids[j], kind: 'open', rooms: [ids[i], ids[j]], c: [cx, cz], u,
            n: [-ni[0], -ni[1]], width: e2 - s, depth: g, reach: [g / 2, g / 2], top: ceiling });
        });
      }
    }
  }
  const adj = {};
  ids.forEach(id => { adj[id] = []; });
  portals.forEach((p, k) => { adj[p.rooms[0]].push(k); adj[p.rooms[1]].push(k); });
  // Wall stubs standing INSIDE a room's polygon (a chimney breast, a pier, a
  // half-height return): the polygon says floor, the wall says solid. Each
  // is a solid the walk must go round, never through.
  const solids = [];
  walls.forEach(w => {
    const L = hyp(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (!(L > 0)) return;
    const inside = [0.1, 0.3, 0.5, 0.7, 0.9].some(f => {
      const x = w.a[0] + (w.b[0] - w.a[0]) * f, z = w.a[1] + (w.b[1] - w.a[1]) * f;
      const r = roomAt(rooms, x, z);
      return r && distToPolyEdge(rooms[r], x, z) > 0.02;
    });
    if (!inside) return;
    // Its own length (a stub is not corner-extended: nothing meets its ends
    // inside the room), its full thickness across.
    const u = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L], h = w.t / 2;
    const xs = [w.a[0], w.b[0]], zs = [w.a[1], w.b[1]];
    solids.push({ a: w.a, u, len: L, t: w.t,
      box: { min: [Math.min(...xs) - Math.abs(u[1]) * h, 0, Math.min(...zs) - Math.abs(u[0]) * h], max: [Math.max(...xs) + Math.abs(u[1]) * h, ceiling, Math.max(...zs) + Math.abs(u[0]) * h] } });
  });
  return { rooms, portals, adj, ceiling, solids };
}

/** Is (x, z) inside one of the graph's solid wall stubs? */
export function inSolid(graph, x, z) {
  return (graph.solids || []).some(s => {
    const dx = x - s.a[0], dz = z - s.a[1], along = dx * s.u[0] + dz * s.u[1], across = -dx * s.u[1] + dz * s.u[0];
    return along >= -0.01 && along <= s.len + 0.01 && Math.abs(across) <= s.t / 2;
  });
}

/** Is (x, z) inside the opening of portal p (its width, through the wall)? */
export function inPortal(p, x, z, slack) {
  const s = slack != null ? slack : 0.03;
  const dx = x - p.c[0], dz = z - p.c[1], a = dx * p.n[0] + dz * p.n[1];
  const reach = p.reach || [p.depth / 2, p.depth / 2];
  return Math.abs(dx * p.u[0] + dz * p.u[1]) <= p.width / 2 - 0.02 && a >= -reach[0] - s && a <= reach[1] + s;
}

/**
 * Is a camera at world (x, y, z) somewhere it may be? Inside a room polygon
 * and under its ceiling gap, or inside a portal's opening and under its head.
 * Returns '' when it may, else why not ('wall', 'ceiling', 'head', 'floor').
 */
export function whyNotFree(graph, x, y, z, opts) {
  const opt = Object.assign({}, WALK, opts || {});
  if (y < opt.minY - 1e-9) return 'floor';
  if (inSolid(graph, x, z)) return 'wall';
  if (roomAt(graph.rooms, x, z)) return y <= graph.ceiling - opt.ceilingGap + 1e-9 ? '' : 'ceiling';
  for (const p of graph.portals) if (inPortal(p, x, z)) return y <= p.top - 0.1 + 1e-9 ? '' : 'head';
  return 'wall';
}

/**
 * buildNavGraph's inputs from a compiled house (src/house-loader.js): room
 * polygons, door openings and wall centrelines, plan cm -> world metres.
 */
export function navInputsFromHouse(house) {
  const T = house.transform, tx = T.tx, tz = T.tz, S = T.S;
  const ceiling = house.ceilingHeight || house.wallHeight || 2.5;
  const rooms = {};
  Object.keys(house.rooms || {}).forEach(id => {
    const rm = house.rooms[id];
    const poly = rm.poly || [[rm.x1, rm.y1], [rm.x2, rm.y1], [rm.x2, rm.y2], [rm.x1, rm.y2]];
    rooms[id] = poly.map(p => [tx(p[0]), tz(p[1])]);
  });
  const byId = house.wallsById || {};
  const wt = w => ((w && w.thickness != null ? w.thickness : house.wallThickness) || 10) * S;
  const doors = (house.doors || []).map(d => {
    const c = d.wall === 'x' ? [d.c, d.at] : [d.at, d.c];
    return { id: d.id, c: [tx(c[0]), tz(c[1])], u: d.wall === 'x' ? [1, 0] : [0, 1], width: (d.w || 0) * S,
      depth: wt(byId[d.wallId]), top: d.h > 0 ? d.h : ceiling };
  });
  const walls = (house.walls || []).map(w => ({ a: [tx(w.x1), tz(w.y1)], b: [tx(w.x2), tz(w.y2)], thickness: wt(w) }));
  return { rooms, doors, walls, ceiling };
}

// ---- In-room routing ------------------------------------------------------

function inBox2(b, x, z, pad) {
  return x >= b.min[0] - pad && x <= b.max[0] + pad && z >= b.min[2] - pad && z <= b.max[2] + pad;
}

/** Can the eye walk the straight line p -> q inside `poly`, clear of the walls and of `obs`? */
function legOK(poly, p, q, obs, clear) {
  const L = hyp(q[0] - p[0], q[1] - p[1]);
  const dp = distToPolyEdge(poly, p[0], p[1]), dq = distToPolyEdge(poly, q[0], q[1]);
  const n = Math.max(2, Math.ceil(L / 0.05));
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = p[0] + (q[0] - p[0]) * t, z = p[1] + (q[1] - p[1]) * t;
    if (!insidePoly(poly, x, z)) return false;
    // Clearance, relaxed near an end that is itself close to a wall.
    const need = Math.min(clear, dp + t * L, dq + (1 - t) * L) - 1e-6;
    if (distToPolyEdge(poly, x, z) < need) return false;
    for (const b of obs) if (inBox2(b, x, z, 0)) return false;
  }
  return true;
}

/**
 * The way out to a point inside `poly` at least `clear` off every wall and
 * outside every (padded) obstacle, as near to `p` as possible: a list of
 * points to walk from `p` (the last is the clear point), [] when `p` already
 * is one, null when none is found within 1.5 m.
 *
 * A camera parked against a wall (an orbited or zoomed-out view is clamped
 * 12 cm off it) steps out first, so the walk's clearance never rules out a
 * start or an end. Usually one straight stride away from the wall; a camera
 * wedged in a slot (between a wall and a chimney breast) slides along it
 * first. A breadth-first search on a 5 cm grid round `p`: cells inside the
 * room and out of every obstacle proper (`pad` shrinks a padded box back to
 * the thing itself), simplified to its turns.
 */
export function clearSteps(poly, p, clear, obstacles, pad) {
  const c = clear != null ? clear : WALK.clear;
  const obs = obstacles || [];
  const ok = q => insidePoly(poly, q[0], q[1]) && distToPolyEdge(poly, q[0], q[1]) >= c - 1e-6 && !obs.some(b => inBox2(b, q[0], q[1], 0));
  if (!insidePoly(poly, p[0], p[1])) return null;
  if (ok(p)) return [];
  // (1 cm clear of the thing itself, so a stride never grazes its corner.)
  const solid = q => obs.some(b => inBox2(b, q[0], q[1], -(pad || 0) + 0.01));
  const free = q => insidePoly(poly, q[0], q[1]) && !solid(q);
  const h = 0.05, R = 30, W2 = 2 * R + 1;
  const at = (i, j) => [p[0] + (i - R) * h, p[1] + (j - R) * h];
  const prev = new Int32Array(W2 * W2).fill(-2);
  const start = R * W2 + R;
  prev[start] = -1;
  const queue = [start];
  let goal = -1;
  for (let qi = 0; qi < queue.length && goal < 0; qi++) {
    const k = queue[qi], i = Math.floor(k / W2), j = k % W2;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= W2 || nj >= W2) continue;
      const nk = ni * W2 + nj;
      if (prev[nk] !== -2) continue;
      const q = at(ni, nj);
      if (!free(q)) continue;
      // A diagonal step never cuts a corner: both cells beside it are free too.
      if (di && dj && (!free(at(i + di, j)) || !free(at(i, j + dj)))) continue;
      prev[nk] = k;
      if (ok(q)) { goal = nk; break; }
      queue.push(nk);
    }
  }
  if (goal < 0) return null;
  const cells = [];
  for (let k = goal; k !== start; k = prev[k]) cells.unshift(k);
  // Keep only where the direction changes, and the end.
  const out = [];
  let lastDir = null, prevK = start;
  cells.forEach((k, n) => {
    const d = k - prevK;
    if (lastDir !== null && d !== lastDir) out.push(at(Math.floor(prevK / W2), prevK % W2));
    lastDir = d; prevK = k;
    if (n === cells.length - 1) out.push(at(Math.floor(k / W2), k % W2));
  });
  // A few cm further into the clear, along the last stride.
  const e = out[out.length - 1], f = out.length > 1 ? out[out.length - 2] : p;
  const l = hyp(e[0] - f[0], e[1] - f[1]);
  if (l > 1e-9) { const q = [e[0] + (e[0] - f[0]) / l * 0.05, e[1] + (e[1] - f[1]) / l * 0.05]; if (ok(q)) out[out.length - 1] = q; }
  return out;
}

/** The clear point clearSteps leads to, or null (already clear, or none). */
export function clearPoint(poly, p, clear, obstacles, pad) {
  const st = clearSteps(poly, p, clear, obstacles, pad);
  return st && st.length ? st[st.length - 1] : null;
}

/**
 * The corner waypoints for walking p -> q inside one room ([] when the
 * straight line will do), or null when there is no way. A visibility graph
 * over the reflex corners (inset off both walls) and the corners of the
 * tall furniture in the way.
 */
export function roomRoute(poly, p, q, obstacles, opts) {
  const opt = Object.assign({}, WALK, opts || {});
  const obs = (obstacles || []).filter(b => !inBox2(b, p[0], p[1], 0) && !inBox2(b, q[0], q[1], 0));
  if (legOK(poly, p, q, obs, opt.clear)) return [];
  const nodes = [];
  const n = poly.length;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  const ccw = area > 0;
  for (let i = 0; i < n; i++) {
    const h = poly[(i - 1 + n) % n], c = poly[i], k = poly[(i + 1) % n];
    const cross = (c[0] - h[0]) * (k[1] - c[1]) - (c[1] - h[1]) * (k[0] - c[0]);
    const convex = ccw ? cross > 0 : cross < 0;
    if (convex) continue;
    const n1 = inward(poly, h, c), n2 = inward(poly, c, k), d = opt.clear + 0.1;
    nodes.push([c[0] + (n1[0] + n2[0]) * d, c[1] + (n1[1] + n2[1]) * d]);
  }
  obs.forEach(b => {
    const e = 0.05;   // just outside the (already padded) box
    [[b.min[0] - e, b.min[2] - e], [b.max[0] + e, b.min[2] - e], [b.max[0] + e, b.max[2] + e], [b.min[0] - e, b.max[2] + e]].forEach(v => nodes.push(v));
  });
  const ok = nodes.filter(v => insidePoly(poly, v[0], v[1]) && distToPolyEdge(poly, v[0], v[1]) >= opt.clear * 0.8 &&
    !obs.some(b => inBox2(b, v[0], v[1], 0)));
  const all = [p, q].concat(ok);
  const N = all.length, dist = new Array(N).fill(Infinity), prev = new Array(N).fill(-1), done = new Array(N).fill(false);
  dist[0] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < N; v++) {
      if (done[v] || v === u) continue;
      const w = hyp(all[v][0] - all[u][0], all[v][1] - all[u][1]);
      if (dist[u] + w >= dist[v]) continue;
      if (!legOK(poly, all[u], all[v], obs, opt.clear)) continue;
      dist[v] = dist[u] + w; prev[v] = u;
    }
  }
  if (!(dist[1] < Infinity)) return null;
  const out = [];
  for (let v = prev[1]; v > 0; v = prev[v]) out.unshift(all[v].slice());
  return out;
}

// ---- The room sequence ----------------------------------------------------

/**
 * The portals to cross from room `a` (starting at plan point pa) to room `b`
 * (ending at pb): Dijkstra over portal centres. Returns [{ portal, into }]
 * or null when `b` cannot be reached. [] when a === b.
 */
export function portalRoute(graph, a, pa, b, pb) {
  if (a === b) return [];
  const P = graph.portals;
  if (!graph.adj[a] || !graph.adj[b]) return null;
  // State: (portal k, side s) = crossed portal k into rooms[s].
  const key = (k, s) => k * 2 + s;
  const dist = new Map(), prev = new Map(), done = new Set();
  graph.adj[a].forEach(k => {
    const s = P[k].rooms[0] === a ? 1 : 0;
    dist.set(key(k, s), hyp(P[k].c[0] - pa[0], P[k].c[1] - pa[1]));
  });
  let best = null, bestD = Infinity;
  for (;;) {
    let u = -1, ud = Infinity;
    dist.forEach((d, kk) => { if (!done.has(kk) && d < ud) { ud = d; u = kk; } });
    if (u < 0 || ud >= bestD) break;
    done.add(u);
    const k = u >> 1, s = u & 1, room = P[k].rooms[s];
    if (room === b) {
      const d = ud + hyp(pb[0] - P[k].c[0], pb[1] - P[k].c[1]);
      if (d < bestD) { bestD = d; best = u; }
      continue;
    }
    graph.adj[room].forEach(k2 => {
      if (k2 === k) return;
      const s2 = P[k2].rooms[0] === room ? 1 : 0, v = key(k2, s2);
      const d = ud + hyp(P[k2].c[0] - P[k].c[0], P[k2].c[1] - P[k].c[1]);
      if (!done.has(v) && d < (dist.has(v) ? dist.get(v) : Infinity)) { dist.set(v, d); prev.set(v, u); }
    });
  }
  if (best == null) return null;
  const out = [];
  for (let v = best; v != null; v = prev.get(v)) out.unshift({ portal: v >> 1, into: P[v >> 1].rooms[v & 1], from: P[v >> 1].rooms[1 - (v & 1)] });
  return out;
}

// ---- The spline -----------------------------------------------------------

/** Centripetal Catmull-Rom through 3D points, sampled about every `step` m. */
export function catmullRom(pts, step) {
  const P = [];
  pts.forEach(p => { if (!P.length || hyp(p[0] - P[P.length - 1][0], p[1] - P[P.length - 1][1], p[2] - P[P.length - 1][2]) > 1e-4) P.push(p); });
  if (P.length < 2) return P.map(p => p.slice());
  const n = P.length;
  const ext = [P[0].map((v, i) => 2 * v - P[1][i])].concat(P, [P[n - 1].map((v, i) => 2 * v - P[n - 2][i])]);
  const out = [P[0].slice()];
  const knot = (a, b) => Math.max(1e-6, Math.sqrt(hyp(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    const len = hyp(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
    const m = Math.max(4, Math.ceil(len / (step || 0.02)));
    for (let s = 1; s <= m; s++) {
      const t = t1 + (t2 - t1) * s / m;
      const L = (pa, pb, ta, tb) => pa.map((v, k) => (tb - t) / (tb - ta) * v + (t - ta) / (tb - ta) * pb[k]);
      const A1 = L(p0, p1, t0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
      const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
      out.push(L(B1, B2, t1, t2));
    }
  }
  return out;
}

// ---- Orientation helpers ----------------------------------------------------

/** (yaw, pitch-down) of a pose's view direction, the lookBasis convention. */
export function lookOf(pose) {
  const st = Math.sin(pose.ph);
  const f = [-st * Math.cos(pose.th), -Math.cos(pose.ph), -st * Math.sin(pose.th)];
  return { yaw: Math.atan2(f[2], f[0]), pitch: Math.asin(Math.max(-1, Math.min(1, -f[1]))) };
}

// ---- The plan ---------------------------------------------------------------

/**
 * The camera's path through `way` ([x, y, z] waypoints): a centripetal
 * Catmull-Rom spline, heights clamped to [minY, ceiling - ceilingGap], every
 * sample checked with whyNotFree (and `blocked`, if given). A spline that
 * strays -- out through a wall beside a tight bend, or over the clamp -- is
 * refitted through densified waypoints (pulling it onto the polyline), and
 * as a last resort the polyline itself is used. Null when even that is not
 * free. Exported so the guards can be tested on waypoints built to stray.
 */
export function fitPath(graph, way, opts, blocked) {
  const opt = Object.assign({}, WALK, opts || {});
  const yMax = graph.ceiling - opt.ceilingGap;
  const clampY = p => [p[0], Math.max(opt.minY, Math.min(yMax, p[1])), p[2]];
  const valid = path => {
    for (const p of path) {
      if (whyNotFree(graph, p[0], p[1], p[2], opt)) return false;
      if (blocked && blocked(p)) return false;
    }
    return true;
  };
  let pts = way, path = null;
  for (let k = 0; k < 4 && !path; k++) {
    const c = catmullRom(pts, opt.sample).map(clampY);
    if (valid(c)) path = c;
    else {
      const d = [pts[0]];
      for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; d.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], b); }
      pts = d;
    }
  }
  if (path) return path;
  const lin = [clampY(way[0])];
  for (let i = 1; i < way.length; i++) {
    const a = way[i - 1], b = way[i], m = Math.max(1, Math.ceil(hyp(b[0] - a[0], b[2] - a[2]) / opt.sample));
    for (let q = 1; q <= m; q++) lin.push(clampY([a[0] + (b[0] - a[0]) * q / m, a[1] + (b[1] - a[1]) * q / m, a[2] + (b[2] - a[2]) * q / m]));
  }
  return valid(lin) ? lin : null;
}

/**
 * Plan a walk from pose `from` (eye in room fromRoom) to pose `to` (eye in
 * room toRoom).
 * @param graph   buildNavGraph()
 * @param o.obstacles  [{ min, max }] world boxes of tall furniture (optional)
 * @returns null when no in-house walk exists (no route, or none that stays
 *          clear), else { at(t) -> pose, path (dense [x, y, z]), waypoints,
 *          portals: [ids], rooms: [ids walked through], length, ms, maxY }
 */
export function planWalk(graph, from, fromRoom, to, toRoom, o) {
  const opt = Object.assign({}, WALK, (o && o.options) || {});
  // Wall stubs inside a room are always walked round; furniture when it can be.
  const solids = (graph.solids || []).map(sd => sd.box);
  const furniture = (o && o.obstacles) || [];
  const res = planWith(graph, from, fromRoom, to, toRoom, furniture.concat(solids), opt);
  if (res || !furniture.length) return res;
  // Furniture made it impossible: walking through a wardrobe beats the roof.
  return planWith(graph, from, fromRoom, to, toRoom, solids, opt);
}

function planWith(graph, from, fromRoom, to, toRoom, obstacles, opt) {
  const A = eyeOf(from), B = eyeOf(to);
  const pa = [A[0], A[2]], pb = [B[0], B[2]];
  if (!graph.rooms[fromRoom] || !graph.rooms[toRoom]) return null;
  const route = portalRoute(graph, fromRoom, pa, toRoom, pb);
  if (!route) return null;
  const obsIn = room => obstacles.filter(b => {
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    return b.max[1] > opt.obstacleMinY && insidePoly(graph.rooms[room], cx, cz);
  }).map(b => ({ min: [b.min[0] - opt.obstaclePad, b.min[1], b.min[2] - opt.obstaclePad], max: [b.max[0] + opt.obstaclePad, b.max[1], b.max[2] + opt.obstaclePad] }));

  // Where each portal is crossed: a door at its centre; a wide opening on the
  // line between its neighbours, kept off its ends (refined in a second pass).
  const crossAt = route.map(r => graph.portals[r.portal].c.slice());
  let plan2d = null;
  for (let pass = 0; pass < 2; pass++) {
    plan2d = build2d(crossAt);
    if (!plan2d) return null;
    let moved = false;
    route.forEach((r, i) => {
      const p = graph.portals[r.portal];
      if (p.width < 2 * opt.wideMargin + 0.4) return;
      const prev = plan2d.before[i], next = plan2d.after[i];
      // Where prev -> next meets the portal's line, clamped into the opening.
      const d = [next[0] - prev[0], next[1] - prev[1]];
      const den = d[0] * p.n[0] + d[1] * p.n[1];
      let s;
      if (Math.abs(den) < 1e-6) s = (prev[0] - p.c[0]) * p.u[0] + (prev[1] - p.c[1]) * p.u[1];
      else {
        const t = ((p.c[0] - prev[0]) * p.n[0] + (p.c[1] - prev[1]) * p.n[1]) / den;
        s = (prev[0] + d[0] * t - p.c[0]) * p.u[0] + (prev[1] + d[1] * t - p.c[1]) * p.u[1];
      }
      const lim = p.width / 2 - opt.wideMargin;
      s = Math.max(-lim, Math.min(lim, s));
      const c = [p.c[0] + p.u[0] * s, p.c[1] + p.u[1] * s];
      if (hyp(c[0] - crossAt[i][0], c[1] - crossAt[i][1]) > 0.02) { crossAt[i] = c; moved = true; }
    });
    if (!moved) break;
  }
  if (!plan2d) return null;

  function build2d(cross) {
    const pts = [{ p: pa, kind: 'start' }];
    const before = [], after = [];
    let cur = pa, room = fromRoom;
    // A start against a wall: step clear of it first.
    const sa = clearSteps(graph.rooms[fromRoom], pa, opt.clear, obsIn(fromRoom), opt.obstaclePad) || [];
    sa.forEach(q => pts.push({ p: q, kind: 'stepStart' }));
    if (sa.length) cur = sa[sa.length - 1];
    for (let i = 0; i < route.length; i++) {
      const p = graph.portals[route[i].portal];
      const s = route[i].into === p.rooms[1] ? 1 : -1, n = [p.n[0] * s, p.n[1] * s];
      const c = cross[i];
      // The straight runs either side, shortened where a room is too shallow.
      const reach = p.reach || [p.depth / 2, p.depth / 2];
      const run = (poly, dir) => {
        // How far this side's room face is from the centreline.
        const face = (dir < 0) === (s > 0) ? reach[0] : reach[1];
        for (let a = opt.approach; a >= 0.1; a -= 0.05) {
          const q = [c[0] + n[0] * dir * (face + a), c[1] + n[1] * dir * (face + a)];
          if (insidePoly(poly, q[0], q[1]) && distToPolyEdge(poly, q[0], q[1]) >= Math.min(0.1, a * 0.5)) return q;
        }
        return null;
      };
      const pre = run(graph.rooms[room], -1), post = run(graph.rooms[route[i].into], 1);
      if (!pre || !post) return null;
      const leg = roomRoute(graph.rooms[room], cur, pre, obsIn(room), opt);
      if (!leg) return null;
      leg.forEach(q => pts.push({ p: q, kind: 'corner', room }));
      before.push(pts[pts.length - 1].p);
      pts.push({ p: pre, kind: 'pre', portal: p.id }, { p: c, kind: 'door', portal: p.id }, { p: post, kind: 'post', portal: p.id });
      cur = post; room = route[i].into;
      after.push(null);
    }
    // An end against a wall: arrive at a clear point, then step to it.
    const sb = (clearSteps(graph.rooms[room], pb, opt.clear, obsIn(room), opt.obstaclePad) || []).slice().reverse();
    const leg = roomRoute(graph.rooms[room], cur, sb.length ? sb[0] : pb, obsIn(room), opt);
    if (!leg) return null;
    leg.forEach(q => pts.push({ p: q, kind: 'corner', room }));
    sb.forEach(q => pts.push({ p: q, kind: 'stepEnd' }));
    pts.push({ p: pb, kind: 'end' });
    // The point after each crossing's straight run (for the wide-opening line).
    let k = 0;
    pts.forEach((w, i) => { if (w.kind === 'post') { after[k++] = pts[i + 1].p; } });
    return { pts, before, after };
  }

  // Heights: the ends keep their own; everything between walks at eye height,
  // under the lowest opening's head and the ceiling.
  const tops = route.map(r => graph.portals[r.portal].top);
  const walkY = Math.max(opt.minY, Math.min(opt.eyeY, ...tops.map(t => t - opt.doorHeadroom), graph.ceiling - opt.ceilingGap));
  const W = plan2d.pts;
  const L2 = [0];
  for (let i = 1; i < W.length; i++) L2.push(L2[i - 1] + hyp(W[i].p[0] - W[i - 1].p[0], W[i].p[1] - W[i - 1].p[1]));
  const tot2 = L2[L2.length - 1] || 1;
  const way = W.map((w, i) => {
    let y;
    if (w.kind === 'start' || w.kind === 'stepStart') y = A[1];
    else if (w.kind === 'end' || w.kind === 'stepEnd') y = B[1];
    else if (route.length) y = walkY;
    else y = A[1] + (B[1] - A[1]) * L2[i] / tot2;   // same room, round a corner
    return [w.p[0], y, w.p[1]];
  });

  // The spline, checked (fitPath); furniture in the way: only the tall
  // pieces we walk round.
  const blocked = p => {
    for (const r of Object.keys(graph.rooms)) {
      if (!insidePoly(graph.rooms[r], p[0], p[2])) continue;
      for (const b of obsIn(r)) if (inBox2({ min: [b.min[0] + opt.obstaclePad, 0, b.min[2] + opt.obstaclePad], max: [b.max[0] - opt.obstaclePad, 0, b.max[2] - opt.obstaclePad] }, p[0], p[2], 0) &&
        p[1] >= b.min[1] && p[1] <= b.max[1] && !inBox2(b, A[0], A[2], 0) && !inBox2(b, B[0], B[2], 0)) return true;
    }
    return false;
  };
  const path = fitPath(graph, way, opt, blocked);
  if (!path) return null;
  // Land exactly on the ends (the clamp may have nudged an end that sat high).
  path[0] = A.slice(); path[path.length - 1] = B.slice();

  // Arc length along the path.
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + hyp(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
  const total = cum[cum.length - 1];

  // The walking direction at each sample, unwrapped: the chord of the path
  // `lookChord` long centred on it (clamped at the ends) -- a smoothed tangent,
  // so a tight bend before a door turns the head over a stride, not a frame.
  const posAt = d => {
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo], f = seg > 0 ? (d - cum[lo]) / seg : 0;
    const p = path[lo], q = path[hi];
    return [p[0] + (q[0] - p[0]) * f, p[2] + (q[2] - p[2]) * f];
  };
  const half = Math.min(opt.lookChord / 2, total / 2);
  const head = new Array(path.length);
  let last = null;
  for (let i = 0; i < path.length; i++) {
    let d0 = cum[i] - half, d1 = cum[i] + half;
    if (d0 < 0) { d1 -= d0; d0 = 0; }
    if (d1 > total) { d0 = Math.max(0, d0 - (d1 - total)); d1 = total; }
    const p = posAt(d0), q = posAt(d1);
    let y = hyp(q[0] - p[0], q[1] - p[1]) > 1e-6 ? Math.atan2(q[1] - p[1], q[0] - p[0]) : (last != null ? last : 0);
    if (last != null) y = last + shortestArc(last, y);
    head[i] = y; last = y;
  }
  const s = lookOf(from), e = lookOf(to);
  // The start and end directions, unwrapped next to the walk's own.
  const S = head[0] + shortestArc(head[0], s.yaw), E = head[head.length - 1] + shortestArc(head[head.length - 1], e.yaw);
  const tp = opt.travelPitchDeg * Math.PI / 180;
  const k = Math.max(0, Math.min(1, (total - 0.8) / 1.2));   // a short hop just turns
  const dTurn = shortestArc(s.yaw, e.yaw);
  const ra = Math.max(1e-6, from.r), rb = Math.max(1e-6, to.r);
  const fa = from.fov != null ? from.fov : 50, fb = to.fov != null ? to.fov : 50;
  const tOut = Math.min(opt.turnOut, total * 0.4), tIn = Math.min(opt.turnIn, total * 0.45);

  function sampleAt(d) {
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo], f = seg > 0 ? (d - cum[lo]) / seg : 0;
    const p = path[lo], q = path[hi];
    return { eye: [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f], head: head[lo] + (head[hi] - head[lo]) * f };
  }
  function look(d, H) {
    const a = smooth(tOut > 0 ? d / tOut : 1), b = smooth(tIn > 0 ? (d - (total - tIn)) / tIn : 1);
    // Turn from the start view to the walking direction, then to the view.
    const m1 = S + (H - S) * a, ty = m1 + (E - m1) * b;
    const p1 = s.pitch + (tp - s.pitch) * a, tpch = p1 + (e.pitch - p1) * b;
    const u = smooth(total > 0 ? d / total : 1);
    const dy = s.yaw + dTurn * u, dp = s.pitch + (e.pitch - s.pitch) * u;
    if (k >= 1) return { yaw: ty, pitch: tpch };
    if (k <= 0) return { yaw: dy, pitch: dp };
    // Blend as unit vectors: no wrap to get wrong.
    const x = Math.cos(ty) * k + Math.cos(dy) * (1 - k), z = Math.sin(ty) * k + Math.sin(dy) * (1 - k);
    return { yaw: Math.atan2(z, x), pitch: tpch * k + dp * (1 - k) };
  }
  // TIMING. Each stretch of the walk costs the longer of walking it (at
  // walkSpeed) and turning the head through it (at maxYawRate), so the camera
  // slows down where it turns hard -- before and through a doorway -- instead
  // of whipping round at walking pace. Progress along the walk is by that
  // cost; the duration is the total cost, stretched by the speed profile's
  // 1.33x peak (walkEase) so the peak turn rate stays under the cap.
  const N = Math.max(200, Math.ceil(total / 0.02)), step = total / N;
  const costCum = new Float64Array(N + 1), dys = new Float64Array(N + 1);
  const yawRad = opt.maxYawRate * Math.PI / 180;
  const peak = 1 / (1 - 0.25);   // walkEase's peak rate, x the average
  let turn = 0, prevY = look(0, sampleAt(0).head).yaw;
  for (let i = 1; i <= N; i++) {
    const y = look(i * step, sampleAt(i * step).head).yaw;
    dys[i] = Math.abs(shortestArc(prevY, y));
    turn += dys[i]; prevY = y;
  }
  // When the whole walk would run past maxMs, the straight stretches go
  // faster (up to 3x) before the turns do: the turning keeps its budget.
  let C = 0;
  for (let k = 0, v = opt.walkSpeed; k < 6; k++, v *= 1.25) {
    for (let i = 1; i <= N; i++) costCum[i] = costCum[i - 1] + Math.max(step / v, dys[i] / yawRad);
    C = costCum[N] || 1;
    if ((peak * C + 0.25) * 1000 <= opt.maxMs || v >= opt.walkSpeed * 3) break;
  }
  const dAt = q => {
    const c = q * C;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (costCum[m] <= c) lo = m; else hi = m; }
    const seg = costCum[hi] - costCum[lo], f = seg > 0 ? (c - costCum[lo]) / seg : 0;
    return (lo + f) * step;
  };
  const at = t => {
    const q = Math.max(0, Math.min(1, t));
    if (q >= 1) return clonePose(to);
    if (q <= 0) return clonePose(from);
    const d = dAt(q), sm = sampleAt(d), lk = look(d, sm.head);
    const r = Math.exp(Math.log(ra) + (Math.log(rb) - Math.log(ra)) * q);
    return poseFromLook(sm.eye, lk.yaw, lk.pitch, r, fa + (fb - fa) * q);
  };
  const ms = Math.round(Math.max(opt.minMs, Math.min(opt.maxMs, (peak * C + 0.25) * 1000)));
  const roomsWalked = [fromRoom].concat(route.map(r => r.into));
  return {
    mode: 'walk', at, ease: walkEase, path, waypoints: way, kinds: W.map(w => w.kind),
    portals: route.map(r => graph.portals[r.portal].id), rooms: roomsWalked,
    length: total, ms, turn, maxY: Math.max(...path.map(p => p[1])), walkY,
  };
}

/**
 * The walk's speed profile: speed up over the first quarter, cruise, slow
 * down over the last quarter. Peak speed 1.33x the average (an ease-in-out
 * cubic peaks at 3x, which on a 13 m walk through four doors is a blur).
 */
export function walkEase(t, accel) {
  const a = accel != null ? accel : 0.25, x = Math.max(0, Math.min(1, t)), v = 1 / (1 - a);
  if (x < a) return v * x * x / (2 * a);
  if (x > 1 - a) return 1 - v * (1 - x) * (1 - x) / (2 * a);
  return v * (a / 2 + x - a);
}

// ---- Rooms seen from outside ----------------------------------------------

/** Does segment p -> q (x/z) cross segment a -> b? */
function crosses(p, q, a, b) {
  const rx = q[0] - p[0], rz = q[1] - p[1], sx = b[0] - a[0], sz = b[1] - a[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return false;
  const t = ((a[0] - p[0]) * sz - (a[1] - p[1]) * sx) / den, u = ((a[0] - p[0]) * rz - (a[1] - p[1]) * rx) / den;
  return t > 0 && t < 1 && u >= 0 && u <= 1;
}

/**
 * The view of a room no camera can stand in (a cupboard): from the room it
 * opens onto, at walking eye height, looking in through its door.
 *
 * Where to stand: a grid of spots in front of each opening (standing back up
 * to `outsideStandoff`, and to either side), kept 25 cm off that room's walls.
 * Each is scored by how much of the cupboard's floor it sees: a sight line
 * counts when it stays in the two rooms and the opening and passes no door
 * leaf (`opts.leaves`: [[hinge], [tip], doorId] segments, x/z -- the leaf as
 * it stands when held open). The leaf of the door being looked through is
 * left out: the scene hides it while it is the view (a cupboard door that
 * opens only 28 degrees otherwise fills the frame). The other leaves also
 * count against a spot when they stand close in front of the lens, where
 * they would crowd the frame (`clutterReach`, `clutterPenalty`). Ties go to the spot most
 * square to the door and furthest back. It aims at the middle of what it sees.
 * Null when the room has no opening onto another.
 * @returns { pose, portal, standIn, seen } or null
 */
export function outsideView(graph, roomId, opts) {
  const opt = Object.assign({}, WALK, opts || {});
  const poly = graph.rooms[roomId];
  if (!poly) return null;
  const leaves = (opts && opts.leaves) || [];
  // The lens: zoomed in so the opening (plus a margin) spans the frame's
  // width from where the camera stands -- the shot is the cupboard, not the
  // hallway round it -- between outsideMinFov and outsideFov (vertical).
  const aspect = opt.aspect > 0 ? opt.aspect : 1.6;
  const lensFor = (e, p) => {
    const dist = Math.max(0.3, hyp(p.c[0] - e[0], p.c[1] - e[1]));
    const v = 2 * Math.atan((p.width / 2 + opt.outsideMargin) / dist / aspect) * 180 / Math.PI;
    return Math.max(opt.outsideMinFov, Math.min(opt.outsideFov, v));
  };
  const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const targets = [];
  for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) {
    const x = minX + (maxX - minX) * (a + 0.5) / 5, z = minZ + (maxZ - minZ) * (b + 0.5) / 5;
    if (insidePoly(poly, x, z)) targets.push([x, z]);
  }
  if (!targets.length) { const ip = interiorPoint(poly); targets.push(ip); }
  let best = null;
  (graph.adj[roomId] || []).map(k => graph.portals[k]).forEach(p => {
    const into = p.rooms[0] === roomId ? 1 : 0, other = p.rooms[into];
    const sg = into === 1 ? 1 : -1, n = [p.n[0] * sg, p.n[1] * sg];   // out of the cupboard
    const op = graph.rooms[other];
    const free = (x, z) => insidePoly(op, x, z) || insidePoly(poly, x, z) || inPortal(p, x, z, 0.06);
    const sees = (e, t) => {
      if (leaves.some(l => l[2] !== p.id && crosses(e, t, l[0], l[1]))) return false;
      const L = hyp(t[0] - e[0], t[1] - e[1]), m = Math.max(2, Math.ceil(L / 0.03));
      for (let i = 1; i < m; i++) if (!free(e[0] + (t[0] - e[0]) * i / m, e[1] + (t[1] - e[1]) * i / m)) return false;
      return true;
    };
    for (let d = opt.outsideStandoff; d >= 0.5 - 1e-9; d -= 0.1) for (const side of [0, -0.15, 0.15, -0.3, 0.3, -0.45, 0.45, -0.6, 0.6]) {
      const off = side * Math.max(0.6, p.width);
      const e = [p.c[0] + n[0] * (p.depth / 2 + d) + p.u[0] * off, p.c[1] + n[1] * (p.depth / 2 + d) + p.u[1] * off];
      if (!insidePoly(op, e[0], e[1]) || distToPolyEdge(op, e[0], e[1]) < 0.25) continue;
      const seen = targets.filter(t => sees(e, t));
      if (!seen.length) continue;
      // Clutter: another door's leaf close in front of the lens (in the
      // horizontal field of view, within clutterReach) fills the frame
      // without blocking a single sight line -- a hallway front door
      // standing ajar beside a cupboard. Each costs up to clutterPenalty.
      const cx = seen.reduce((m, t) => m + t[0], 0) / seen.length, cz = seen.reduce((m, t) => m + t[1], 0) / seen.length;
      const yaw = Math.atan2(cz - e[1], cx - e[0]);
      const fov = lensFor(e, p), halfH = Math.atan(Math.tan(fov * Math.PI / 360) * aspect);
      let clutter = 0;
      leaves.forEach(l => {
        if (l[2] === p.id) return;
        let worst = 0;
        for (let k = 0; k <= 8; k++) {
          const x = l[0][0] + (l[1][0] - l[0][0]) * k / 8, z = l[0][1] + (l[1][1] - l[0][1]) * k / 8;
          const dist = hyp(x - e[0], z - e[1]);
          if (dist >= opt.clutterReach || Math.abs(shortestArc(yaw, Math.atan2(z - e[1], x - e[0]))) > halfH) continue;
          worst = Math.max(worst, 1 - dist / opt.clutterReach);
        }
        clutter += opt.clutterPenalty * worst;
      });
      const score = seen.length / targets.length - clutter - 0.04 * Math.abs(side) - 0.02 * (opt.outsideStandoff - d);
      if (!best || score > best.score + 1e-9) best = { score, e, seen, p, other, fov };
    }
  });
  if (!best) return null;
  const e = best.e, y = Math.min(opt.eyeY, graph.ceiling - opt.ceilingGap);
  const c = best.seen.reduce((m, t) => [m[0] + t[0] / best.seen.length, m[1] + t[1] / best.seen.length], [0, 0]);
  const aim = [c[0], Math.min(opt.outsideAimY, y), c[1]];
  const dx = aim[0] - e[0], dz = aim[2] - e[1], h = hyp(dx, dz);
  const yaw = Math.atan2(dz, dx), pitch = Math.atan2(y - aim[1], h);
  const r = hyp(h, y - aim[1]);
  return { pose: poseFromLook([e[0], y, e[1]], yaw, pitch, r, best.fov), portal: best.p.id, standIn: best.other,
    seen: best.seen.length / targets.length };
}
