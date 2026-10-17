#!/usr/bin/env node
/**
 * Room-to-room camera walks through doorways (src/doorway-walk.js), the tour
 * order (src/room-nav.js tourOrder, geometry `navigation`) and their wiring.
 * No framework, no install -- `node scripts/test-doorway-walk.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. The graph: every door joins the rooms either side of it (a front door
 *      or a door into nothing modelled joins nothing); two rooms facing each
 *      other with no wall between are an open-plan join, shortened by any
 *      wall that does stand in the gap.
 *   2. Every walk, between every pair of in-room views, sampled densely:
 *      each eye is inside a room polygon or inside a door opening, never
 *      higher than 20 cm under the ceiling (or 10 cm under a door head), and
 *      no step crosses a wall centreline anywhere but through an opening.
 *      Checked by an independent checker here, not the module's own.
 *   3. An L-shaped room gets a corner waypoint instead of cutting its notch.
 *   4. Reverse: b -> a is a -> b backwards.
 *   5. The view turns smoothly, lands and starts exactly, looks along the
 *      walk through a doorway.
 *   5a. Timing: one constant cruise speed (a straight walk takes L / V plus
 *      the ramps, at exactly V between them; longer by exactly the extra
 *      length over V), slowed only where the head turns at the cap; a tour
 *      of a compact flat averages <= 1.2 s a hop, none over 1.5 s but the
 *      longest. Every walk arrives already facing its view (no
 *      move-then-rotate: <= 5 deg left 25 cm out, the turn at rest with the
 *      eye), never turns hard while stopped, and its angular velocity never
 *      steps from frame to frame.
 *   5b. Open-plan rooms sharing one vantage (sharedVantage, sightLeaves):
 *      one eye, inside and under the ceiling, framing both rooms at least
 *      75% as well as their own views; the flight between them a pure
 *      rotation at the cap; an authored view never moved.
 *   6. A cupboard is seen from the room it opens onto, below the ceiling.
 *   6b. A start or end parked against a wall (5-15 cm off it) still walks:
 *      hand-picked rect / L-room spots, and a property run over random
 *      near-wall starts and ends on the flat and the demo house; and one
 *      up to 3 cm inside or off a wall stub's face steps out and walks.
 *   6c. The path's own guards (fitPath) on waypoints built to stray: a
 *      hairpin the raw spline swings out through the walls, a plateau it
 *      bulges over the ceiling gap.
 *   6d. The head turns no faster than maxYawRate (500 deg/s) in real time
 *      (the walk slows where it would turn faster); a cupboard's own door is
 *      hidden while it is the view.
 *   7. Tall furniture is walked round; furniture that blocks every way does
 *      not send the camera over the roof.
 *   8. The tour order: authored order first, the rest appended; the loader,
 *      the validator's key; index.html follows it.
 *   9. Wiring: flyTo walks between in-house views, cancel / reduced motion as
 *      before, doors held open and let go -- on a cancel, setView / setOrbit
 *      or a hand move away too (heldDoorsToKeep), CI runs this file.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const section = s => console.log('\n' + s);

const W = await imp('src/doorway-walk.js');
const F = await imp('src/camera-focus.js');
const { insidePoly } = await imp('src/footstep-walk.js');
const { tourOrder, nextRoom, prevRoom } = await imp('src/room-nav.js');
const { HouseLoader } = await imp('src/house-loader.js');

const D2R = Math.PI / 180;

// ---- A fictional flat, world metres ----------------------------------------
// Kitchen and living room open-plan (no wall between them); a T-shaped hall;
// a cupboard off the hall's north arm; an L-shaped office whose notch is an
// ensuite reached only through the office. Walls are 10 cm thick.
const T = 0.1;
const flat = {
  ceiling: 2.5,
  rooms: {
    living: [[0, 3.1], [4, 3.1], [4, 7], [0, 7]],
    kitchen: [[0, 0], [4, 0], [4, 3.08], [0, 3.08]],
    hall: [[4.1, 2], [7, 2], [7, 0], [8, 0], [8, 2], [10, 2], [10, 3], [4.1, 3]],
    cupboard: [[6, 0.5], [6.9, 0.5], [6.9, 1.5], [6, 1.5]],
    office: [[5, 3.1], [7, 3.1], [7, 5], [10, 5], [10, 7], [5, 7]],
    ensuite: [[7.1, 3.1], [10, 3.1], [10, 4.9], [7.1, 4.9]],
  },
  walls: [
    { a: [4.05, -0.05], b: [4.05, 7.05], thickness: T },      // kitchen / living | hall
    { a: [4.05, 3.05], b: [10.05, 3.05], thickness: T },      // hall | office / ensuite
    { a: [6.95, 0.45], b: [6.95, 1.95], thickness: T },       // cupboard | hall arm
    { a: [7.05, 3.05], b: [7.05, 5.0], thickness: T },        // office | ensuite
    { a: [7.05, 4.95], b: [10.05, 4.95], thickness: T },      // ensuite | office
    { a: [-0.05, -0.05], b: [8.05, -0.05], thickness: T },    // north, exterior
  ],
  doors: [
    { id: 'kitchen_door', c: [4.05, 2.5], u: [0, 1], width: 0.8, depth: T, top: 2.03 },
    { id: 'cupboard_door', c: [6.95, 1.0], u: [0, 1], width: 0.7, depth: T, top: 2.03 },
    { id: 'office_door', c: [6.0, 3.05], u: [1, 0], width: 0.8, depth: T, top: 2.03 },
    { id: 'ensuite_door', c: [9.0, 4.95], u: [1, 0], width: 0.8, depth: T, top: 2.03 },
    { id: 'front_door', c: [7.5, -0.05], u: [1, 0], width: 0.9, depth: T, top: 2.03 },
  ],
};

// ---- An independent checker --------------------------------------------------
// Every sample inside a room, or inside a door / open-join opening; under the
// ceiling gap (the opening's head); and no step crosses a wall centreline
// except where an opening is.
function openingsOf(spec, graph) {
  const out = spec.doors.map(d => ({ c: d.c, u: d.u, w: d.width, depth: d.depth, top: d.top }));
  graph.portals.filter(p => p.kind === 'open').forEach(p => out.push({ c: p.c, u: p.u, w: p.width, depth: Math.max(p.depth, 0.02), top: spec.ceiling, open: true }));
  return out;
}
function inOpening(o, x, z, slack) {
  const dx = x - o.c[0], dz = z - o.c[1];
  const along = dx * o.u[0] + dz * o.u[1], across = dx * -o.u[1] + dz * o.u[0];
  return Math.abs(along) <= o.w / 2 && Math.abs(across) <= o.depth / 2 + (slack != null ? slack : 0.12);
}
function segX(p, q, a, b) {
  const rx = q[0] - p[0], rz = q[1] - p[1], sx = b[0] - a[0], sz = b[1] - a[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((a[0] - p[0]) * sz - (a[1] - p[1]) * sx) / den, u = ((a[0] - p[0]) * rz - (a[1] - p[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [p[0] + rx * t, p[1] + rz * t] : null;
}
function audit(spec, graph, eyes) {
  const ops = openingsOf(spec, graph), bad = [];
  let maxY = -Infinity;
  for (let i = 0; i < eyes.length; i++) {
    const e = eyes[i];
    maxY = Math.max(maxY, e[1]);
    const inRoom = Object.values(spec.rooms).some(poly => insidePoly(poly, e[0], e[2]));
    const op = ops.find(o => inOpening(o, e[0], e[2]));
    if (!inRoom && !op) bad.push({ i, why: 'outside every room and opening', e });
    else if (inRoom && e[1] > spec.ceiling - 0.2 + 1e-6) bad.push({ i, why: 'above the ceiling gap', e });
    else if (!inRoom && e[1] > op.top - 0.1 + 1e-6) bad.push({ i, why: 'above the door head', e });
    if (i) {
      const p = [eyes[i - 1][0], eyes[i - 1][2]], q = [e[0], e[2]];
      for (const w of spec.walls) {
        const x = segX(p, q, w.a, w.b);
        if (x && !ops.some(o => inOpening(o, x[0], x[1], 0.06))) bad.push({ i, why: 'crossed a wall', x });
      }
    }
    if (bad.length > 3) break;
  }
  return { bad, maxY };
}
// Dense samples of a plan: the eye at(t) over 2000 steps (every ~1 cm on a
// long walk). Audited separately from plan.path so no step joins the two.
function samples(plan) {
  const out = [];
  for (let i = 0; i <= 2000; i++) out.push(F.eyeOf(plan.at(i / 2000)));
  return out;
}
// Peak yaw rate (deg/s) of a plan as the scene runs it -- plan.at(plan.ease(t))
// over plan.ms -- measured over every 1/60 s window.
function maxYawRate(plan) {
  const n = Math.max(60, Math.round(plan.ms / 1000 * 60));
  let prev = W.lookOf(plan.at(0)).yaw, best = 0;
  for (let i = 1; i <= n; i++) {
    const y = W.lookOf(plan.at(plan.ease(i / n))).yaw;
    best = Math.max(best, Math.abs(F.shortestArc(prev, y)) / D2R / (plan.ms / 1000 / n));
    prev = y;
  }
  return best;
}
// The motion of a plan in real time, sampled at `hz`: per step the eye's
// speed (m/s), the head's angular velocity (deg/s, signed), and the path
// distance still to go (m).
function motion(plan, hz) {
  const T = plan.ms / 1000, n = Math.max(2, Math.round(T * (hz || 240))), dt = T / n;
  const P = []; for (let i = 0; i <= n; i++) P.push(plan.at(plan.ease(i / n)));
  const E = P.map(F.eyeOf), Y = P.map(p => W.lookOf(p).yaw);
  const steps = [];
  let trav = 0;
  for (let i = 1; i <= n; i++) {
    const l = Math.hypot(E[i][0] - E[i - 1][0], E[i][1] - E[i - 1][1], E[i][2] - E[i - 1][2]);
    trav += l;
    steps.push({ v: l / dt, w: F.shortestArc(Y[i - 1], Y[i]) / D2R / dt, trav, yaw: Y[i] });
  }
  steps.forEach(st => { st.left = trav - st.trav; });
  return { steps, dt, total: trav };
}
// What a walk's ARRIVAL looks like: how far (deg) the head still has to turn
// once the eye is 25 cm (of path) from the end -- a move-then-rotate leaves
// most of its turn for there -- and its turn rate over the final 1/120 s.
function arrival(plan, to) {
  const m = motion(plan, 480), fy = W.lookOf(to).yaw;
  const at25 = m.total > 0.3 ? m.steps.find(st => st.left <= 0.25) : null;
  const tail = m.steps.slice(-4);
  return {
    left25: at25 ? Math.abs(F.shortestArc(at25.yaw, fy)) / D2R : 0,
    endRate: Math.abs(tail.reduce((a, st) => a + st.w, 0) / tail.length),
    // the yaw a hair before landing, against the view
    err: Math.abs(F.shortestArc(W.lookOf(plan.at(plan.ease(1 - 1e-6))).yaw, fy)) / D2R,
  };
}
function orderedSamples(plan) { const out = []; for (let i = 0; i <= 2000; i++) out.push(F.eyeOf(plan.at(i / 2000))); return out; }

// ---- 1: the graph -----------------------------------------------------------
section('the graph');
const g = W.buildNavGraph(flat);
const pairs = Object.fromEntries(g.portals.map(p => [p.id, p.rooms.slice().sort().join('|')]));
check('a door joins the rooms either side of it', pairs.kitchen_door === 'hall|kitchen' && pairs.office_door === 'hall|office' &&
  pairs.ensuite_door === 'ensuite|office' && pairs.cupboard_door === 'cupboard|hall', pairs);
check('a front door (nothing modelled outside) joins nothing', !('front_door' in pairs), pairs);
const open = g.portals.filter(p => p.kind === 'open');
check('the open-plan kitchen / living room is one join', open.length === 1 && open[0].rooms.slice().sort().join('|') === 'kitchen|living', open.map(p => p.id));
check('... across its whole shared length (4 m)', open.length === 1 && Math.abs(open[0].width - 4) < 1e-6, open[0] && open[0].width);
check('... centred in the gap between the two rooms', open.length === 1 && Math.abs(open[0].c[1] - 3.09) < 1e-6 && Math.abs(open[0].c[0] - 2) < 1e-6, open[0] && open[0].c);
check('walled neighbours (kitchen | hall, office | ensuite) are not open joins', !g.portals.some(p => p.kind === 'open' && p.rooms.includes('hall')) &&
  !g.portals.some(p => p.kind === 'open' && p.rooms.includes('ensuite')));
{
  const half = W.buildNavGraph(Object.assign({}, flat, { walls: flat.walls.concat([{ a: [-0.05, 3.09], b: [1.5, 3.09], thickness: T }]) }));
  const o = half.portals.filter(p => p.kind === 'open');
  check('a wall standing in part of the gap shortens the join to the unwalled stretch', o.length === 1 && Math.abs(o[0].width - (4 - 1.55)) < 1e-6 && o[0].c[0] > 2,
    o.map(p => [p.width, p.c]));
  const full = W.buildNavGraph(Object.assign({}, flat, { walls: flat.walls.concat([{ a: [-0.05, 3.09], b: [4.05, 3.09], thickness: T }]) }));
  check('... and one across all of it removes the join', !full.portals.some(p => p.kind === 'open'));
}
{
  // The module's own guard (planWalk validates every spline sample with it).
  const why = (x, y, z) => W.whyNotFree(g, x, y, z);
  check('guard: in a room, under the ceiling gap -> free', why(2, 1.6, 1) === '' && why(2, 2.3, 1) === '');
  check('guard: in a room, within 20 cm of the ceiling -> "ceiling"', why(2, 2.31, 1) === 'ceiling');
  check('guard: inside a wall -> "wall"', why(4.05, 1.6, 1.0) === 'wall' && why(4.05, 1.6, 2.95) === 'wall');
  check('guard: in a door opening, under its head -> free; at the head -> "head"', why(4.05, 1.6, 2.5) === '' && why(4.05, 1.95, 2.5) === 'head');
  check('guard: in the open-plan gap -> free (no wall there)', why(2, 1.6, 3.09) === '');
  check('guard: outside the house -> "wall"; too low -> "floor"', why(-1, 1.6, 1) === 'wall' && why(2, 0.2, 1) === 'floor');
}
{
  // Only edges that FACE each other join: a 30 cm-deep room beside a big
  // one has its near edge facing (a join) and its far edge parallel, within
  // reach, but looking the same way (no second join).
  const thin = W.buildNavGraph({ ceiling: 2.5, walls: [], doors: [], rooms: { big: [[0, 0], [2, 0], [2, 3], [0, 3]], thin: [[0, 3.1], [2, 3.1], [2, 3.4], [0, 3.4]] } });
  const o = thin.portals.filter(p => p.kind === 'open');
  check('only facing edges join (one join, at the near edge)', o.length === 1 && Math.abs(o[0].c[1] - 3.05) < 1e-6, o.map(p => p.c));
}
check('adjacency lists every portal under both its rooms', g.portals.every((p, k) => g.adj[p.rooms[0]].includes(k) && g.adj[p.rooms[1]].includes(k)));

// The demo house, compiled by the real loader.
const demoGeo = JSON.parse(read('houses/demo/geometry.json'));
const demo = HouseLoader.compile(demoGeo, '');
const demoIn = W.navInputsFromHouse(demo);
const dg = W.buildNavGraph(demoIn);
const dpairs = Object.fromEntries(dg.portals.map(p => [p.id, p.rooms.slice().sort().join('|')]));
check('demo: every hall door joins the hall to its room', dpairs.lounge_door === 'hall|lounge' && dpairs.kitchen_door === 'hall|kitchen' &&
  dpairs.store_door === 'hall|store' && dpairs.bathroom_door === 'bathroom|hall' && dpairs.bedroom_door === 'bedroom|hall', dpairs);
check('demo: the study door opens onto an unmodelled corner, so joins nothing; no open-plan joins (every room is walled)',
  !('study_door' in dpairs) && !dg.portals.some(p => p.kind === 'open') && !('front_door' in dpairs), dpairs);

// ---- 2-5: every walk ------------------------------------------------------------
function inRoomPoses(spec, graph) {
  const out = {};
  for (const id of Object.keys(spec.rooms)) {
    const r = F.chooseInRoomView({ poly: spec.rooms[id], ceiling: spec.ceiling, items: [], aspect: 1.6 });
    if (r.pose) out[id] = r.pose;
    else { const o = W.outsideView(graph, id); if (o) out[id] = o.pose; }
  }
  return out;
}
function walkAll(name, spec, graph, minPortals) {
  const poses = inRoomPoses(spec, graph);
  const ids = Object.keys(poses);
  let planned = 0, worst = -Infinity, allBad = [], jumps = 0, plans = {}, fastest = { rate: 0 };
  const worstArr = { err: 0, left25: 0, endRate: 0 }, worstMove = { v: 0, stopTurn: 0, dw: 0 };
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const ea = F.eyeOf(poses[a]), eb = F.eyeOf(poses[b]);
    const ra = W.roomAt(graph.rooms, ea[0], ea[2]), rb = W.roomAt(graph.rooms, eb[0], eb[2]);
    const plan = W.planWalk(graph, poses[a], ra, poses[b], rb);
    if (!plan) continue;
    planned++;
    plans[a + '>' + b] = plan;
    const A1 = audit(spec, graph, samples(plan)), A2 = audit(spec, graph, plan.path);
    const bad = A1.bad.concat(A2.bad), maxY = Math.max(A1.maxY, A2.maxY);
    worst = Math.max(worst, maxY);
    if (bad.length) allBad.push({ a, b, bad: bad.slice(0, 2) });
    const ps = []; for (let i = 0; i <= 1000; i++) ps.push(plan.at(plan.ease(i / 1000)));
    for (let i = 1; i < ps.length; i++) {
      const la = W.lookOf(ps[i - 1]), lb = W.lookOf(ps[i]);
      if (Math.abs(F.shortestArc(la.yaw, lb.yaw)) > 4 * D2R) { jumps++; break; }
    }
    // The head's turn rate, in real time: 60 frames a second over plan.ms.
    const rate = maxYawRate(plan);
    if (rate > fastest.rate) fastest = { rate, hop: a + '>' + b, ms: plan.ms };
    // Arriving: already facing the view, the head slowing to rest with the eye.
    const arr = arrival(plan, poses[b]);
    if (arr.err > worstArr.err) worstArr.err = arr.err;
    if (arr.left25 > worstArr.left25) { worstArr.left25 = arr.left25; worstArr.hop25 = a + '>' + b; }
    if (arr.endRate > worstArr.endRate) worstArr.endRate = arr.endRate;
    // In real time at 120 frames a second: never faster than the cruise speed,
    // never turning hard while (nearly) stopped, and the angular velocity
    // never stepping from one frame to the next.
    const m = motion(plan, 120);
    let prevW = null;
    m.steps.forEach(st => {
      if (st.v / plan.stats.speed > worstMove.v) worstMove.v = st.v / plan.stats.speed;
      if (st.v < 0.5 && Math.abs(st.w) > 60) worstMove.stopTurn++;
      if (prevW != null && Math.abs(st.w - prevW) > worstMove.dw) { worstMove.dw = Math.abs(st.w - prevW); worstMove.dwHop = a + '>' + b; }
      prevW = st.w;
    });
  }
  const cap = W.WALK.maxYawRate;
  check(`${name}: the head never turns faster than maxYawRate (${cap} deg/s; fastest ${fastest.rate.toFixed(0)} deg/s, ${fastest.hop})`, fastest.rate <= cap * 1.03, fastest);
  check(`${name}: every walk arrives facing its view (worst ${worstArr.err.toFixed(3)} deg off a hair before landing)`, worstArr.err < 0.5, worstArr);
  check(`${name}: no move-then-rotate -- 25 cm from the end at most 5 deg of turn is left (worst ${worstArr.left25.toFixed(1)}, ${worstArr.hop25})`, worstArr.left25 <= 5, worstArr);
  check(`${name}: ... and the turn comes to rest with the eye (final 1/120 s under 20 deg/s; worst ${worstArr.endRate.toFixed(1)})`, worstArr.endRate < 20, worstArr);
  check(`${name}: no stop-then-turn -- never under 0.5 m/s while turning over 60 deg/s (${worstMove.stopTurn} frames)`, worstMove.stopTurn === 0, worstMove);
  check(`${name}: the angular velocity never steps (largest change frame to frame at 120 Hz ${worstMove.dw.toFixed(0)} deg/s <= 200)`, worstMove.dw <= 200, worstMove);
  check(`${name}: never faster than the cruise speed (at most ${worstMove.v.toFixed(3)}x it)`, worstMove.v <= 1.02, worstMove);
  check(`${name}: walks planned between ${planned} pairs of views (at least ${minPortals})`, planned >= minPortals, planned);
  check(`${name}: every sample inside a room or an opening, under the ceiling, never through a wall`, allBad.length === 0, allBad.slice(0, 3));
  check(`${name}: highest eye ${worst.toFixed(3)} m <= ceiling - 0.2 (${(spec.ceiling - 0.2).toFixed(2)})`, worst <= spec.ceiling - 0.2 + 1e-9, worst);
  check(`${name}: the view never jumps (< 4 deg per 1/1000 of a walk)`, jumps === 0, jumps);
  return { poses, plans };
}
section('walks: the flat');
const flatRun = walkAll('flat', flat, g, 25);
section('walks: the demo house');
const demoSpec = { ceiling: demoIn.ceiling, rooms: demoIn.rooms, walls: demoIn.walls, doors: demoIn.doors };
const demoRun = walkAll('demo', demoSpec, dg, 20);
{
  const p = demoRun.poses;
  const e = F.eyeOf(p.study);
  const plan = W.planWalk(dg, p.study, W.roomAt(dg.rooms, e[0], e[2]), p.bedroom, 'bedroom');
  check('demo: a room no door reaches has no walk (the scene flies over the walls instead)', plan === null);
}

section('the walk itself');
{
  const P = flatRun.plans;
  const lk = P['living>kitchen'];
  check('living -> kitchen crosses the open-plan join, through no door', lk && lk.portals.length === 1 && lk.portals[0].startsWith('open:') && lk.rooms.join('>') === 'living>kitchen', lk && lk.portals);
  const li = P['living>ensuite'];
  check('living -> ensuite: kitchen, hall, office, ensuite, in that order', li && li.rooms.join('>') === 'living>kitchen>hall>office>ensuite', li && li.rooms);
  check('... through the opening, then each door, in order', li && li.portals.slice(1).join(',') === 'kitchen_door,office_door,ensuite_door', li && li.portals);
  // 3: the L-shaped office -- hall door to ensuite door goes round the notch.
  const oe = P['hall>ensuite'];
  check('L-shaped room: a corner waypoint round the notch', oe && oe.kinds.includes('corner'), oe && oe.kinds);
  check('... and that corner is inside the office, clear of its walls', oe && oe.waypoints.filter((w, i) => oe.kinds[i] === 'corner').every(w =>
    insidePoly(flat.rooms.office, w[0], w[2]) && F.distToPolyEdge(flat.rooms.office, w[0], w[2]) >= 0.2));
  {
    // Inside one L-shaped room, arm to arm.
    const a = F.poseFromLook([5.5, 2.1, 3.6], Math.PI / 2, 0.3, 2, 70), b = F.poseFromLook([9.6, 2.1, 6.5], Math.PI, 0.3, 2, 70);
    const pl = W.planWalk(g, a, 'office', b, 'office');
    check('within an L-shaped room: round the corner, never through the notch', pl && pl.kinds.includes('corner') && audit(flat, g, samples(pl)).bad.length === 0,
      pl && pl.kinds);
  }
  {
    // Grazing the notch's corner: a straight line from arm to arm that stays
    // (just) inside the room passes 4 cm from the corner. The walk keeps its
    // distance instead.
    const a = F.poseFromLook([6.4, 2.0, 4.4], 0.8, 0.3, 2, 70), b = F.poseFromLook([7.5, 2.0, 5.6], 0.8, 0.3, 2, 70);
    const pl = W.planWalk(g, a, 'office', b, 'office');
    const near = pl ? Math.min(...samples(pl).map(e => Math.hypot(e[0] - 7, e[2] - 5))) : 0;
    check(`a walk keeps clear of a corner it could graze (closest ${near.toFixed(2)} m)`, near >= 0.2, near);
  }
  // Waypoints through each door: at walking eye height, square to it.
  const dw = li && li.waypoints.filter((w, i) => li.kinds[i] === 'door');
  check('each door is crossed at eye height (1.6 m)', dw && dw.length === 4 && dw.every(w => Math.abs(w[1] - W.WALK.eyeY) < 1e-9), dw);
  const pre = li && li.waypoints.filter((w, i) => li.kinds[i] === 'pre'), post = li && li.waypoints.filter((w, i) => li.kinds[i] === 'post');
  check('... with a straight run before and after, square to the wall', li && li.portals.every((id, k) => {
    const p = g.portals.find(q => q.id === id);
    const a = [post[k][0] - pre[k][0], post[k][2] - pre[k][2]];
    return Math.abs(a[0] * p.u[0] + a[1] * p.u[1]) < 1e-6;
  }));
  // 4: reverse.
  const rev = P['ensuite>living'];
  const same = li && rev && li.waypoints.length === rev.waypoints.length &&
    li.waypoints.every((w, i) => { const r = rev.waypoints[rev.waypoints.length - 1 - i]; return Math.hypot(w[0] - r[0], w[1] - r[1], w[2] - r[2]) < 0.01; });
  check('reverse: ensuite -> living is living -> ensuite backwards', same && rev.portals.slice().reverse().join() === li.portals.join(),
    rev && rev.portals);
  check('... the same length', li && rev && Math.abs(li.length - rev.length) < 0.01, [li && li.length, rev && rev.length]);
  let symmetric = 0, total = 0;
  for (const k of Object.keys(P)) {
    const [a, b] = k.split('>'), r = P[b + '>' + a];
    if (!r) continue;
    total++;
    if (r.portals.slice().reverse().join() === P[k].portals.join() && Math.abs(r.length - P[k].length) < 0.02) symmetric++;
  }
  check(`... and every pair (${symmetric}/${total}) walks the same doors back`, total > 0 && symmetric === total);
  // 5: the view.
  const a = flatRun.poses.living, b = flatRun.poses.ensuite;
  const s = li.at(0), e = li.at(1);
  check('starts exactly on the start view', Math.abs(s.th - a.th) < 1e-9 && Math.abs(s.r - a.r) < 1e-9 && s.tgt.every((v, i) => Math.abs(v - a.tgt[i]) < 1e-9));
  check('lands exactly on the view', Math.abs(e.th - b.th) < 1e-9 && Math.abs(e.ph - b.ph) < 1e-9 && e.tgt.every((v, i) => Math.abs(v - b.tgt[i]) < 1e-9) && e.fov === b.fov);
  {
    // Mid-door: looking along the walk.
    const eyes = orderedSamples(li);
    const p = g.portals.find(q => q.id === 'kitchen_door');
    let worst = 0, n = 0;
    for (let i = 1; i < 2000; i++) {
      const ee = F.eyeOf(li.at(i / 2000));
      if (!inOpening({ c: p.c, u: p.u, w: p.width, depth: p.depth }, ee[0], ee[2], 0)) continue;
      const lk2 = W.lookOf(li.at(i / 2000)), nx = eyes[i + 1][0] - eyes[i - 1][0], nz = eyes[i + 1][2] - eyes[i - 1][2];
      worst = Math.max(worst, Math.abs(F.shortestArc(lk2.yaw, Math.atan2(nz, nx))));
      n++;
    }
    check(`through a doorway the camera looks where it is going (within 15 deg; worst ${(worst / D2R).toFixed(1)})`, n > 0 && worst < 15 * D2R, { n, worst: worst / D2R });
  }
  // 5b: timing (2026-10-17: "on average the transition should take
  // like a second, no more than like 1.5 seconds"; "the camera speed should
  // be constant, so longer distances will take slightly longer").
  const V = W.WALK.walkSpeed, ramp = V / W.WALK.accel;   // the two ramps together cost V/accel of time
  const lens = Object.values(P).map(p => [p.length, p.ms]).sort((x, y) => x[0] - y[0]);
  check(`duration: every walk ${W.WALK.minMs}-${W.WALK.maxMs} ms`, lens.every(([, ms]) => ms >= W.WALK.minMs && ms <= W.WALK.maxMs), lens.slice(0, 2).concat(lens.slice(-2)));
  check('... longer walks take longer (shortest < longest)', lens[0][1] < lens[lens.length - 1][1], [lens[0], lens[lens.length - 1]]);
  {
    // A straight walk is timed by its length alone: L / V plus the ramps,
    // cruising at exactly V -- and a longer one takes longer by exactly the
    // extra length over V (one constant speed).
    const walk = (x0, x1) => W.planWalk(g, F.poseFromLook([x0, 1.6, 2.5], 0, 0.1, 2, 70), 'hall', F.poseFromLook([x1, 1.6, 2.5], 0, 0.1, 2, 70), 'hall');
    const st = walk(4.6, 9.5), sh = walk(4.6, 7.0);
    const want = (st.length / V + ramp) * 1000;
    check(`a straight ${st.length.toFixed(1)} m walk takes L/V + the ramps (${st.ms} ms, want ${want.toFixed(0)})`, Math.abs(st.ms - want) < 15, [st.ms, want]);
    const mid = motion(st, 240).steps.filter(x => x.trav > 0.6 && x.left > 0.6);
    const vs = mid.map(x => x.v);
    check(`... at one constant speed between the ramps (${Math.min(...vs).toFixed(3)}-${Math.max(...vs).toFixed(3)} m/s, cruise ${V})`,
      vs.length > 50 && Math.min(...vs) > V * 0.995 && Math.max(...vs) < V * 1.005, [Math.min(...vs), Math.max(...vs)]);
    check(`... so 2.5 m further takes (2.5 / V) s longer (${st.ms - sh.ms} ms)`, Math.abs((st.ms - sh.ms) - (st.length - sh.length) / V * 1000) < 15, [st.ms, sh.ms]);
    check('... and the turn-rate cap does not slow it (it barely turns)', maxYawRate(st) < 30 && st.stats.cruiseShare > 0.6, [maxYawRate(st), st.stats.cruiseShare]);
    const turny = P['ensuite>living'];
    check(`a walk that turns through four doors still turns <= ${W.WALK.maxYawRate} deg/s (${turny.ms} ms, peak ${maxYawRate(turny).toFixed(0)})`,
      maxYawRate(turny) <= W.WALK.maxYawRate * 1.03, [turny.ms, maxYawRate(turny)]);
    // The speed only drops below the cruise where the head would otherwise
    // out-turn the cap: at every slower frame (outside the ramps) the head
    // is turning close to the cap.
    let slowNoTurn = 0;
    Object.values(P).forEach(pl => {
      const m = motion(pl, 240);
      m.steps.forEach(x => { if (x.trav > 0.6 && x.left > 0.6 && x.v < pl.stats.speed * 0.9 && Math.abs(x.w) < W.WALK.maxYawRate * 0.5) slowNoTurn++; });
    });
    check(`... it is slowed only where it turns (${slowNoTurn} slow frames turning under half the cap)`, slowNoTurn === 0, slowNoTurn);
  }
}
{
  // A tour of a compact flat, each room's view in the corner beside its door
  // (as a real house's often is), forwards and back round: about a second a
  // hop -- none over 1.5 s but the longest.
  const compact = { ceiling: 2.5,
    rooms: { living: [[0, 0], [4, 0], [4, 3.5], [0, 3.5]], kitchen: [[0, 3.6], [4, 3.6], [4, 6], [0, 6]], hall: [[4.1, 0], [5.3, 0], [5.3, 6], [4.1, 6]],
      bed: [[5.4, 0], [8.5, 0], [8.5, 3], [5.4, 3]], bath: [[5.4, 3.1], [7.5, 3.1], [7.5, 4.5], [5.4, 4.5]], office: [[5.4, 4.6], [8.5, 4.6], [8.5, 6], [5.4, 6]] },
    walls: [{ a: [4.05, -0.05], b: [4.05, 6.05], thickness: T }, { a: [5.35, -0.05], b: [5.35, 6.05], thickness: T },
      { a: [5.35, 3.05], b: [8.55, 3.05], thickness: T }, { a: [5.35, 4.55], b: [8.55, 4.55], thickness: T }, { a: [7.55, 3.05], b: [7.55, 4.55], thickness: T }],
    doors: [{ id: 'living_door', c: [4.05, 1.5], u: [0, 1], width: 0.8, depth: T, top: 2.03 }, { id: 'bed_door', c: [5.35, 1.5], u: [0, 1], width: 0.8, depth: T, top: 2.03 },
      { id: 'bath_door', c: [5.35, 3.8], u: [0, 1], width: 0.8, depth: T, top: 2.03 }, { id: 'office_door', c: [5.35, 5.3], u: [0, 1], width: 0.8, depth: T, top: 2.03 }] };
  const cg = W.buildNavGraph(compact);
  const doorOf = { living: [4.05, 1.5], kitchen: [2, 3.55], hall: [4.7, 3], bed: [5.35, 1.5], bath: [5.35, 3.8], office: [5.35, 5.3] };
  const views = {};
  for (const id of Object.keys(compact.rooms)) {
    const poly = compact.rooms[id], d = doorOf[id], c = F.polygonCentroid(poly);
    const v = F.roomVantages(poly, 0.4).sort((x, y) => Math.hypot(x.x - d[0], x.z - d[1]) - Math.hypot(y.x - d[0], y.z - d[1]))[0];
    views[id] = F.poseFromLook([v.x, 2.0, v.z], Math.atan2(c[1] - v.z, c[0] - v.x), 24 * D2R, 2, 70);
  }
  const tour = ['living', 'kitchen', 'hall', 'bed', 'bath', 'office'];
  for (const dir of [1, -1]) {
    const hops = [];
    let bad = 0;
    for (let i = 0; i < tour.length; i++) {
      const a = tour[(i * dir + 12) % 6], b = tour[((i + 1) * dir + 12) % 6];
      const pl = W.planWalk(cg, views[a], a, views[b], b);
      hops.push([a + '>' + b, pl ? pl.ms : null, pl ? +pl.length.toFixed(2) : null]);
      if (pl) bad += audit(compact, cg, samples(pl)).bad.length;
    }
    const ms = hops.map(h => h[1]).filter(x => x > 0).sort((x, y) => x - y), avg = ms.reduce((x, y) => x + y, 0) / ms.length;
    const name = dir > 0 ? 'forwards' : 'backwards';
    check(`compact tour ${name}: every hop walks, inside, under the ceiling, through no wall (${ms.map(x => (x / 1000).toFixed(2)).join(' / ')} s)`,
      ms.length === 6 && bad === 0, { hops, bad });
    check(`... averaging ${(avg / 1000).toFixed(2)} s <= 1.2 s`, avg <= 1200, hops);
    check(`... none over 1.5 s but the longest (next longest ${(ms[ms.length - 2] / 1000).toFixed(2)} s; longest ${(ms[ms.length - 1] / 1000).toFixed(2)} s)`, ms[ms.length - 2] <= 1500 && ms[ms.length - 1] <= 2000, hops);
  }
}

// ---- 5a: open-plan rooms sharing one vantage ---------------------------------------
// 2026-10-17: kitchen to living room "should just rotate: it should
// just have an angle where the camera stays in one place for both".
section('open-plan rooms sharing one vantage');
{
  const pair = ['living', 'kitchen'];
  const ownOf = id => { const r = F.chooseInRoomView({ poly: flat.rooms[id], ceiling: flat.ceiling, items: [], aspect: 1.6 }); return { pose: r.pose, eye: r.eye, score: r.score, coverage: r.coverage, ranked: r.ranked }; };
  const viewFrom = (room, eye) => F.chooseInRoomView({ poly: flat.rooms[room], ceiling: flat.ceiling, items: [], aspect: 1.6, eyes: [eye],
    sight: (e, p, t) => W.sightLeaves(g, pair, e, p, t) });
  const own = { living: ownOf('living'), kitchen: ownOf('kitchen') };
  const sv = W.sharedVantage({ graph: g, rooms: pair, own, viewFrom });
  const eL = sv && F.eyeOf(sv.poses.living), eK = sv && F.eyeOf(sv.poses.kitchen);
  check('the flat\'s living room and kitchen share one vantage', !!sv && Math.hypot(eL[0] - eK[0], eL[1] - eK[1], eL[2] - eK[2]) < 1e-9, sv && [eL, eK]);
  check('... inside the house, under the ceiling gap (whyNotFree), in one of the two rooms and within 1 m of the other',
    sv && W.whyNotFree(g, eL[0], eL[1], eL[2]) === '' && eL[1] <= flat.ceiling - 0.2 &&
    pair.some(r => insidePoly(flat.rooms[r], eL[0], eL[2])) && pair.every(r => insidePoly(flat.rooms[r], eL[0], eL[2]) || F.distToPolyEdge(flat.rooms[r], eL[0], eL[2]) <= 1), eL);
  // Independently: each view looks INTO its own room -- the room's centre is
  // in the frame's horizontal field -- with no wall between.
  const inFrame = (pose, pt) => {
    const lk = W.lookOf(pose), e = F.eyeOf(pose);
    return Math.abs(F.shortestArc(lk.yaw, Math.atan2(pt[1] - e[2], pt[0] - e[0]))) < Math.atan(Math.tan(pose.fov * D2R / 2) * 1.6);
  };
  check('... each view faces its own room (its centre in the frame, no wall crossed to it)', sv && pair.every(r => {
    const c = F.polygonCentroid(flat.rooms[r]), e = F.eyeOf(sv.poses[r]);
    return inFrame(sv.poses[r], c) && !flat.walls.some(w => segX([e[0], e[2]], c, w.a, w.b));
  }));
  check('... each framed at least 75% as well as by its own view (coverage and score)', sv && pair.every(r => {
    const v = viewFrom(r, eL);
    return v.coverage >= 0.75 * own[r].coverage && v.score >= 0.75 * own[r].score;
  }) && sv.ratio >= 0.75, sv && sv.ratio);
  check('sightLeaves: through the open-plan join the sight line stays in; into the hall (through a wall) it leaves',
    !W.sightLeaves(g, pair, [2, 1.6, 1], [2, 0.05, 6]) && W.sightLeaves(g, pair, [2, 1.6, 1], [6, 0.05, 2.5]) &&
    W.sightLeaves(g, ['kitchen'], [2, 1.6, 1], [2, 0.05, 6]));
  // The flight between them: a turn on the spot.
  const a = sv.poses.living, b = sv.poses.kitchen;
  const turn = W.planGlide(a, b), back = W.planGlide(b, a);
  const m = motion(turn, 480);
  const moved = Math.max(...m.steps.map(st => st.v));
  const dYaw = Math.abs(F.shortestArc(W.lookOf(a).yaw, W.lookOf(b).yaw)) / D2R;
  const wantMs = Math.max(W.WALK.turnMinMs, 1.875 * dYaw / W.WALK.maxYawRate * 1000);
  check(`living room <-> kitchen is a pure rotation (${dYaw.toFixed(0)} deg in ${turn.ms} ms; the eye never moves)`, turn.turnInPlace && turn.length < 1e-6 && moved < 1e-6, moved);
  check(`... timed by the angle at the turn-rate cap (${turn.ms} ms, want ${wantMs.toFixed(0)}), the same back`, Math.abs(turn.ms - wantMs) <= 1 && back.ms === turn.ms, [turn.ms, back.ms, wantMs]);
  const rate = maxYawRate(turn);
  let dw = 0;
  const m2 = motion(turn, 120);
  m2.steps.forEach((st, i) => { if (i) dw = Math.max(dw, Math.abs(st.w - m2.steps[i - 1].w)); });
  check(`... never faster than ${W.WALK.maxYawRate} deg/s (${rate.toFixed(0)}), its angular velocity never stepping (${dw.toFixed(0)} deg/s a frame)`, rate <= W.WALK.maxYawRate * 1.03 && dw <= 200, [rate, dw]);
  const end = turn.at(1), arr = arrival(turn, b);
  check('... landing exactly on the kitchen view, its turn at rest', Math.abs(end.th - b.th) < 1e-9 && end.tgt.every((v, i) => Math.abs(v - b.tgt[i]) < 1e-9) && arr.endRate < 20, arr);
  // Authored views are never moved.
  const authored = (r, pose) => Object.assign({}, own, { [r]: { pose, eye: F.eyeOf(pose), authored: true, score: 1, coverage: 1 } });
  check('two authored views share nothing', W.sharedVantage({ graph: g, rooms: pair, viewFrom,
    own: { living: Object.assign({}, own.living, { authored: true }), kitchen: Object.assign({}, own.kitchen, { authored: true }) } }) === null);
  // A kitchen view authored in its corner beside the join (as the real
  // house's is): the living room turns to face its own room from there, and
  // the kitchen's view does not move.
  const kAuth = F.poseFromLook([3.6, 2.2, 2.7], Math.atan2(1.5 - 2.7, 2 - 3.6), 24 * D2R, 2.5, 70);
  const sa = W.sharedVantage({ graph: g, rooms: pair, own: authored('kitchen', kAuth), viewFrom });
  check('an authored kitchen view beside the join: the living room shares its eye, the kitchen view unchanged',
    sa && sa.anchor === 'kitchen' && JSON.stringify(sa.poses.kitchen) === JSON.stringify(kAuth) &&
    Math.hypot(...F.eyeOf(sa.poses.living).map((v, i) => v - F.eyeOf(kAuth)[i])) < 1e-9 && inFrame(sa.poses.living, F.polygonCentroid(flat.rooms.living)), sa && sa.anchor);
  // An authored view standing across its room from the join: too far to
  // share (reach) -- each room keeps its own view and the walk between them.
  const kFar = F.poseFromLook([0.4, 2.2, 0.4], Math.atan2(1.5 - 0.4, 2 - 0.4), 24 * D2R, 2.5, 70);
  check('... one standing across its room (3 m from the living room) shares nothing', W.sharedVantage({ graph: g, rooms: pair, own: authored('kitchen', kFar), viewFrom }) === null);
  check('... nor any when the bar is (impossibly) high', W.sharedVantage({ graph: g, rooms: pair, own, viewFrom, ratio: 1.5 }) === null);
  {
    // BOTH rooms must be framed well from the shared spot: a runner-up eye
    // beside the join that frames the living room fine but its own kitchen
    // poorly is not shared (and is, once the kitchen is framed well too).
    const near = [3.6, 2.2, 2.7], dummy = F.poseFromLook(near, 0, 0.4, 2, 70);
    const stubOwn = { living: { pose: dummy, eye: [0.4, 2.2, 6.6], score: 1, coverage: 1, ranked: [] },
      kitchen: { pose: dummy, eye: [0.4, 2.2, 0.4], score: 1, coverage: 1, ranked: [{ eye: near }] } };
    const stub = kq => (room) => ({ pose: dummy, coverage: room === 'kitchen' ? kq : 0.95, score: room === 'kitchen' ? kq : 0.95 });
    check('... the shared spot must frame BOTH rooms: its own room poorly (0.5) -> not shared; well (0.8) -> shared',
      W.sharedVantage({ graph: g, rooms: pair, own: stubOwn, viewFrom: stub(0.5) }) === null &&
      !!W.sharedVantage({ graph: g, rooms: pair, own: stubOwn, viewFrom: stub(0.8) }));
  }
}

// ---- 5b: a camera parked against a wall ------------------------------------------
// An orbited or zoomed-out in-room camera is clamped 12 cm off the walls. A
// walk from (or to) there must still walk -- never fall back to the roof
// while a door route exists. Before the fix, ~99% of these fell back.
section('starting and ending against a wall');
let seed = 20261006;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function nearWallEye(poly, lo, hi, graph) {
  for (;;) {
    const i = Math.floor(rnd() * poly.length), a = poly[i], b = poly[(i + 1) % poly.length];
    const t = 0.05 + rnd() * 0.9, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
    const m = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (!insidePoly(poly, m[0] + nx * 0.02, m[1] + nz * 0.02)) { nx = -nx; nz = -nz; }
    const d = lo + rnd() * (hi - lo), p = [m[0] + nx * d, m[1] + nz * d];
    // (Not inside a wall stub standing in the room: a camera in a wall is no start.)
    if (insidePoly(poly, p[0], p[1]) && F.distToPolyEdge(poly, p[0], p[1]) >= lo - 1e-9 && !(graph && W.inSolid(graph, p[0], p[1]))) return [p[0], 1.2 + rnd() * 1.0, p[1]];
  }
}
function nearWallRun(name, spec, graph, n) {
  const ids = Object.keys(spec.rooms);
  let tried = 0, fell = 0, bad = [];
  for (let k = 0; k < n; k++) {
    const a = ids[Math.floor(rnd() * ids.length)], b = ids[Math.floor(rnd() * ids.length)];
    const ea = nearWallEye(spec.rooms[a], 0.05, 0.15, graph), eb = nearWallEye(spec.rooms[b], 0.05, 0.15, graph);
    if (!W.portalRoute(graph, a, [ea[0], ea[2]], b, [eb[0], eb[2]])) continue;   // no door route: the arc is right
    tried++;
    const A = F.poseFromLook(ea, rnd() * 6.28, 0.1 + rnd() * 0.5, 1 + rnd() * 3, 70), B = F.poseFromLook(eb, rnd() * 6.28, 0.1 + rnd() * 0.5, 1 + rnd() * 3, 70);
    const pl = W.planWalk(graph, A, a, B, b);
    if (!pl) { fell++; if (fell < 3) bad.push({ a, b, ea, eb }); continue; }
    const r = audit(spec, graph, samples(pl));
    if (r.bad.length) bad.push({ a, b, why: r.bad[0] });
  }
  check(`${name}: ${tried} walks from and to 5-15 cm off a wall, none falls back to the roof`, tried > n / 3 && fell === 0, { tried, fell, bad: bad.slice(0, 2) });
  check(`${name}: ... and every one stays inside, under the ceiling, through no wall`, bad.length === 0, bad.slice(0, 2));
}
{
  // Rectangular and L rooms, each end against a wall, at hand-picked spots.
  const P = (x, y, z) => F.poseFromLook([x, y, z], 1.0, 0.3, 2, 70);
  const cases = [
    ['kitchen corner (6 cm off both walls) -> living', P(0.06, 2.0, 0.06), 'kitchen', P(3.9, 2.0, 6.9), 'living'],
    ['kitchen, running along its north wall -> hall', P(3.0, 2.2, 0.08), 'kitchen', P(9.88, 1.4, 2.9), 'hall'],
    ['L office, against the notch wall -> ensuite', P(6.9, 2.0, 3.6), 'office', P(7.2, 2.0, 3.15), 'ensuite'],
    ['L office, 12 cm off the south wall -> hall', P(9.0, 1.8, 6.88), 'office', P(4.2, 2.1, 2.1), 'hall'],
  ];
  for (const [name, a, ra, b, rb] of cases) {
    const pl = W.planWalk(g, a, ra, b, rb);
    const r = pl ? audit(flat, g, samples(pl)) : null;
    check(`${name}: walks, inside the house`, pl && r.bad.length === 0, pl ? r.bad.slice(0, 2) : 'fell back');
  }
  const cp = W.clearPoint(flat.rooms.kitchen, [0.06, 0.06], 0.25);
  check('clearPoint: a corner start steps clear of both walls, a few cm further than needed', cp && F.distToPolyEdge(flat.rooms.kitchen, cp[0], cp[1]) >= 0.25 && Math.hypot(cp[0] - 0.06, cp[1] - 0.06) < 0.4, cp);
  check('clearPoint: an already-clear point needs no step', W.clearPoint(flat.rooms.kitchen, [2, 1.5], 0.25) === null);
}
nearWallRun('flat (property)', flat, g, 400);
nearWallRun('demo (property)', demoSpec, dg, 400);

{
  // The demo bedroom has a 40 cm wall stub standing inside its polygon.
  check('demo: a wall stub standing inside a room is a solid', dg.solids.length === 1 && W.whyNotFree(dg, 4.1, 1.6, 0.9) === 'wall', dg.solids.map(x => x.box));
  // Wedged in the 10 cm slot between it and the east wall: slides out, walks.
  const A = F.poseFromLook([4.35, 1.8, 0.9], 0, 0.3, 2, 70), B = demoRun.poses.hall;
  const eb = F.eyeOf(B);
  const pl = W.planWalk(dg, A, 'bedroom', B, W.roomAt(dg.rooms, eb[0], eb[2]));
  {
    // Its way out, step by step: round the stub's corner, never across it.
    const pads = dg.solids.map(x => ({ min: [x.box.min[0] - 0.15, 0, x.box.min[2] - 0.15], max: [x.box.max[0] + 0.15, 3, x.box.max[2] + 0.15] }));
    const p0 = [4.3126, 1.0546], st = W.clearSteps(dg.rooms.bedroom, p0, 0.25, pads, 0.15);
    let cut = false;
    if (st) [p0].concat(st).forEach((a, i, arr) => { if (!i) return; const b = arr[i - 1]; for (let k = 0; k <= 100; k++) if (W.inSolid(dg, b[0] + (a[0] - b[0]) * k / 100, b[1] + (a[1] - b[1]) * k / 100)) cut = true; });
    check('stepping out of the slot goes round the corner of the stub, not across it', st && st.length >= 1 && !cut, st);
  }
  check('a camera wedged beside the stub slides out along the slot and walks, never through the stub', pl && audit(demoSpec, dg, samples(pl)).bad.length === 0 &&
    samples(pl).every(e => !W.inSolid(dg, e[0], e[2])), pl && pl.kinds);
}
{
  // Pressed INTO a stub, or touching it (review 7ade30ab): a camera up to
  // 3 cm inside a stub's face, or up to 3 cm off it, still walks -- out
  // through the nearest face first, and never inside a stub anywhere but
  // the few cm next to the end it started (or ends) in.
  const box = { min: [1, 0, 1], max: [1.4, 3, 1.1] }, room = [[0, 0], [3, 0], [3, 3], [0, 3]];
  const st = W.clearSteps(room, [1.38, 1.05], 0.25, [box], 0);
  check('clearSteps: a start 2 cm inside a box steps out through its nearest face first', st && st.length >= 1 &&
    Math.abs(st[0][0] - 1.43) < 1e-9 && Math.abs(st[0][1] - 1.05) < 1e-9, st);
  // fitPath lets the eye leave the stub it starts in, but not walk on through it.
  check('fitPath: a path starting 2 cm inside the stub and stepping straight out is allowed',
    !!W.fitPath(dg, [[3.92, 1.5, 0.9], [3.85, 1.5, 0.9], [3.6, 1.5, 0.9]]));
  check('fitPath: ... one that walks on THROUGH the stub it starts in (past 15 cm) is not',
    W.fitPath(dg, [[3.92, 1.5, 0.9], [4.25, 1.5, 0.9], [4.25, 1.5, 1.4]]) === null);
  const s0 = dg.solids[0].box;
  let tried = 0, fell = 0, strayed = 0;
  const ids = Object.keys(dg.rooms), bad = [];
  for (let k = 0; k < 160; k++) {
    const side = Math.floor(rnd() * 4), d = -0.03 + rnd() * 0.06;
    const fx = s0.min[0] + rnd() * (s0.max[0] - s0.min[0]), fz = s0.min[2] + rnd() * (s0.max[2] - s0.min[2]);
    const p = side === 0 ? [s0.min[0] - d, fz] : side === 1 ? [s0.max[0] + d, fz] : side === 2 ? [fx, s0.min[2] - d] : [fx, s0.max[2] + d];
    const ra = W.roomAt(dg.rooms, p[0], p[1]);
    const rb = ids[Math.floor(rnd() * ids.length)];
    if (!ra || ra === rb) continue;
    const eb = F.eyeOf(demoRun.poses[rb] || {});
    if (!demoRun.poses[rb] || !W.portalRoute(dg, ra, p, rb, [eb[0], eb[2]])) continue;
    tried++;
    const A = F.poseFromLook([p[0], 1.2 + rnd(), p[1]], rnd() * 6.28, 0.2, 2, 70), back = rnd() < 0.5;
    const pl = back ? W.planWalk(dg, demoRun.poses[rb], rb, A, ra) : W.planWalk(dg, A, ra, demoRun.poses[rb], rb);
    if (!pl) { fell++; if (bad.length < 2) bad.push({ p, ra, rb, back }); continue; }
    if (samples(pl).some(e => W.inSolid(dg, e[0], e[2]) && Math.hypot(e[0] - p[0], e[2] - p[1]) > 0.16)) strayed++;
  }
  check(`demo: ${tried} walks from or to within 3 cm of the stub's faces (inside or out), none falls back to the roof`, tried > 40 && fell === 0, { tried, fell, bad });
  check('... and none goes inside the stub beyond the few cm it starts or ends in', strayed === 0, strayed);
}

// ---- 5c: the path's own guards, on waypoints built to stray ---------------------
section('the path guards');
{
  const box = W.buildNavGraph({ ceiling: 2.5, walls: [], doors: [], rooms: { r: [[0, 0], [4, 0], [4, 3], [0, 3]] } });
  // A hairpin 6 cm off a corner: the raw spline swings out through both walls.
  const hair = [[0.3, 1.6, 2.7], [0.06, 1.6, 0.06], [3.7, 1.6, 0.3]];
  const raw = W.catmullRom(hair, 0.01);
  check('(control) the raw spline round a tight corner leaves the room', raw.some(p => W.whyNotFree(box, p[0], p[1], p[2]) === 'wall'));
  const fit = W.fitPath(box, hair);
  check('fitPath pulls it back: every sample inside the room', fit && fit.every(p => !W.whyNotFree(box, p[0], p[1], p[2])), fit && fit.find(p => W.whyNotFree(box, p[0], p[1], p[2])));
  // A plateau right at the ceiling gap: the raw spline bulges over it.
  const plat = [[0.5, 1.0, 1.5], [1.5, 2.3, 1.5], [2.5, 2.3, 1.5], [3.5, 1.0, 1.5]];
  const rawY = Math.max(...W.catmullRom(plat, 0.01).map(p => p[1]));
  check('(control) the raw spline over a plateau at ceiling - 0.2 rises above it', rawY > 2.3 + 0.01, rawY);
  const fy = W.fitPath(box, plat);
  const fitY = fy ? Math.max(...fy.map(p => p[1])) : Infinity;
  check(`fitPath keeps it under: highest ${fitY.toFixed(3)} <= 2.3`, fitY <= 2.3 + 1e-9, fitY);
  // ... by clamping the bulge, not by giving up on the curve for the polyline.
  const yAt1 = fy ? fy.reduce((m, p) => Math.abs(p[0] - 1.0) < Math.abs(m[0] - 1.0) ? p : m)[1] : null;
  check('... and keeps the curve (clamped, not dropped to the straight polyline)', yAt1 != null && Math.abs(yAt1 - 1.65) > 0.02, yAt1);
  check('fitPath: waypoints that cannot be walked (through a wall) -> null', W.fitPath(box, [[1, 1.6, 1], [5, 1.6, 1]]) === null);
}

// ---- 6: cupboards -------------------------------------------------------------
section('a cupboard, seen from outside');
{
  const o = W.outsideView(g, 'cupboard');
  const e = o && F.eyeOf(o.pose);
  check('the cupboard is seen from the hall', o && o.standIn === 'hall' && insidePoly(flat.rooms.hall, e[0], e[2]), o && { standIn: o.standIn, e });
  check('... at eye height, under the ceiling', e && Math.abs(e[1] - 1.6) < 1e-9 && e[1] <= flat.ceiling - 0.2);
  check('... through its door: the sight line to its middle passes the opening', o && (() => {
    const ip = F.interiorPoint(flat.rooms.cupboard), d = flat.doors.find(x => x.id === 'cupboard_door');
    for (let i = 0; i <= 200; i++) {
      const x = e[0] + (ip[0] - e[0]) * i / 200, z = e[2] + (ip[1] - e[2]) * i / 200;
      if (!insidePoly(flat.rooms.hall, x, z) && !insidePoly(flat.rooms.cupboard, x, z) && !inOpening({ c: d.c, u: d.u, w: d.width, depth: d.depth }, x, z)) return false;
    }
    return true;
  })());
  check('... looking at it (its middle is ahead, a little below)', o && (() => {
    const lk = W.lookOf(o.pose), ip = F.interiorPoint(flat.rooms.cupboard);
    return Math.abs(F.shortestArc(lk.yaw, Math.atan2(ip[1] - e[2], ip[0] - e[0]))) < 1e-6 && lk.pitch > 0 && lk.pitch < 30 * D2R;
  })());
  {
    // Its door stopped at 28 degrees, hinged at the north jamb, opening into
    // the hall: the leaf stands across a straight-on view.
    const leaf = [[6.95, 0.65], [6.95 + 0.7 * Math.sin(28 * D2R), 0.65 + 0.7 * Math.cos(28 * D2R)]];
    const lv = W.outsideView(g, 'cupboard', { leaves: [leaf] });
    const le = lv && F.eyeOf(lv.pose);
    const segHits = (p, q, a, b) => !!segX(p, q, a, b);
    const ip = F.interiorPoint(flat.rooms.cupboard);
    check('(control) straight on, the 28-degree leaf is in the way', segHits([e[0], e[2]], ip, leaf[0], leaf[1]));
    check('a door leaf in the way: it stands aside, south of the leaf, and sees most of the cupboard past it',
      lv && le[2] > e[2] + 0.1 && lv.seen >= 0.5 && !segHits([le[0], le[2]], [lv.pose.tgt[0], lv.pose.tgt[2]], leaf[0], leaf[1]), lv && { le, seen: lv.seen });
    check('... still in the hall, under the ceiling', lv && insidePoly(flat.rooms.hall, le[0], le[2]) && le[1] <= flat.ceiling - 0.2);
  }
  {
    // The door being looked through is hidden while it is the view: its own
    // leaf (tagged with its id) is not in the way; another door's still is.
    const leaf = [[6.95, 0.65], [6.95 + 0.7 * Math.sin(28 * D2R), 0.65 + 0.7 * Math.cos(28 * D2R)]];
    const own = W.outsideView(g, 'cupboard', { leaves: [leaf.concat(['cupboard_door'])] });
    const other = W.outsideView(g, 'cupboard', { leaves: [leaf.concat(['some_other_door'])] });
    const oe = own && F.eyeOf(own.pose), xe = other && F.eyeOf(other.pose);
    check('its own (hidden) leaf does not move the view: straight on again', own && Math.abs(oe[2] - e[2]) < 1e-9 && Math.abs(oe[0] - e[0]) < 1e-9, oe);
    check('... another door\'s leaf in the same place still does', other && Math.abs(xe[2] - e[2]) > 0.1, xe);
  }
  {
    // Another door's leaf ajar close in front of a straight-on view (a hall
    // front door beside the cupboard) blocks no sight line but crowds the
    // frame: the view moves so less of that leaf is in it, close up.
    const L = [[7.05, 0.2], [7.3, 0.72], 'front_door'];
    const crowd = v => {
      const ee = F.eyeOf(v.pose), yaw = W.lookOf(v.pose).yaw, half = Math.atan(Math.tan(35 * D2R) * 1.6);
      let n = 0;
      for (let k = 0; k <= 8; k++) {
        const x = L[0][0] + (L[1][0] - L[0][0]) * k / 8, z = L[0][1] + (L[1][1] - L[0][1]) * k / 8;
        if (Math.hypot(x - ee[0], z - ee[2]) < 1.5 && Math.abs(F.shortestArc(yaw, Math.atan2(z - ee[2], x - ee[0]))) <= half) n++;
      }
      return n;
    };
    const plain = W.outsideView(g, 'cupboard'), aware = W.outsideView(g, 'cupboard', { leaves: [L] });
    check('a neighbouring door ajar in front of the view: the view moves so it crowds the frame less, and still sees the cupboard',
      crowd(aware) < crowd(plain) && aware.seen >= 0.8, { plain: crowd(plain), aware: crowd(aware), seen: aware.seen });
  }
  {
    // The lens is zoomed onto the opening: the opening and 30 cm either side
    // span the frame's width (within 45-70 degrees vertical).
    const v = W.outsideView(g, 'cupboard', { aspect: 1.6 }), ve = F.eyeOf(v.pose), d = flat.doors.find(x => x.id === 'cupboard_door');
    const want = 2 * Math.atan((d.width / 2 + 0.3) / Math.hypot(d.c[0] - ve[0], d.c[1] - ve[2]) / 1.6) / D2R;
    check(`the outside view zooms onto the opening (${v.pose.fov.toFixed(1)} deg, not the 70 deg room lens)`,
      Math.abs(v.pose.fov - Math.max(45, Math.min(70, want))) < 1e-6 && v.pose.fov < 70, [v.pose.fov, want]);
  }
  check('the cupboard really is too small to stand in (the in-room chooser falls back)',
    F.chooseInRoomView({ poly: flat.rooms.cupboard, ceiling: 2.5, items: [], aspect: 1.6 }).fallback === true);
  const ds = W.outsideView(dg, 'store');
  const de = ds && F.eyeOf(ds.pose);
  check('demo: the store cupboard is seen from the hall, below the ceiling', ds && ds.standIn === 'hall' && insidePoly(dg.rooms.hall, de[0], de[2]) && de[1] <= dg.ceiling - 0.2,
    ds && { standIn: ds.standIn, de });
  check('a room with no opening onto another has no outside view', W.outsideView(dg, 'study') === null);
  // Hall -> cupboard view and between two outside views: walks, in the hall.
  const hp = flatRun.plans['hall>cupboard'];
  check('walking to the cupboard view stays in the hall', hp && hp.rooms.join() === 'hall' && audit(flat, g, samples(hp)).bad.length === 0, hp && hp.rooms);
}

// ---- 7: furniture ---------------------------------------------------------------
section('tall furniture');
{
  // A 2 m cabinet across the middle of the hall's east-west run.
  const a = F.poseFromLook([4.6, 2.0, 2.3], 0, 0.3, 2, 70), b = F.poseFromLook([9.5, 2.0, 2.3], Math.PI, 0.3, 2, 70);
  const cab = { min: [6.3, 0, 2.0], max: [6.7, 2.0, 2.5] };
  const pl = W.planWalk(g, a, 'hall', b, 'hall', { obstacles: [cab] });
  const hits = pl ? samples(pl).filter(e => e[0] > cab.min[0] && e[0] < cab.max[0] && e[2] > cab.min[2] && e[2] < cab.max[2] && e[1] < cab.max[1]) : null;
  check('a tall cabinet in the way is walked round', pl && hits.length === 0 && audit(flat, g, samples(pl)).bad.length === 0, { kinds: pl && pl.kinds, hits: hits && hits.length });
  const pl0 = W.planWalk(g, a, 'hall', b, 'hall');
  const hits0 = samples(pl0).filter(e => e[0] > cab.min[0] && e[0] < cab.max[0] && e[2] > cab.min[2] && e[2] < cab.max[2]);
  check('(control) without it the straight line goes through the cabinet', hits0.length > 0);
  const low = { min: [6.3, 0, 2.0], max: [6.7, 0.9, 2.5] };
  const pl2 = W.planWalk(g, a, 'hall', b, 'hall', { obstacles: [low] });
  check('a low table is walked over, not round', pl2 && !pl2.kinds.includes('corner'));
  const wall = { min: [6.3, 0, 1.9], max: [6.7, 2.4, 3.1] };
  const pl3 = W.planWalk(g, a, 'hall', b, 'hall', { obstacles: [wall] });
  check('furniture blocking the whole hall: still a walk (through it), never null -> over the roof', pl3 && audit(flat, g, samples(pl3)).bad.length === 0);
}

// ---- 8: tour order ------------------------------------------------------------
section('tour order');
{
  const ids = ['living', 'kitchen', 'hall', 'store', 'bedroom'];
  check('no order: the house order', tourOrder(ids).join() === ids.join() && tourOrder(ids, []).join() === ids.join());
  check('an order: its rooms first, in its order', tourOrder(ids, ['hall', 'living', 'bedroom']).slice(0, 3).join() === 'hall,living,bedroom');
  check('... rooms it leaves out appended, in the house order', tourOrder(ids, ['hall', 'living', 'bedroom']).join() === 'hall,living,bedroom,kitchen,store');
  check('... unknown ids and repeats dropped', tourOrder(ids, ['ghost', 'store', 'store', 'kitchen']).join() === 'store,kitchen,living,hall,bedroom');
  const t = tourOrder(ids, ['bedroom', 'store', 'hall', 'kitchen', 'living']);
  check('prev / next walk the tour, wrapping', nextRoom(t, 'bedroom') === 'store' && nextRoom(t, 'living') === 'bedroom' && prevRoom(t, 'bedroom') === 'living');
  check('... back is forward reversed', t.every(id => prevRoom(t, nextRoom(t, id)) === id));
  // The loader.
  const g2 = JSON.parse(JSON.stringify(demoGeo));
  g2.schemaVersion = '1.6';
  g2.navigation = { order: ['bedroom', 'ghost', 'hall', 'bedroom', 'lounge'] };
  const warns = [];
  const origWarn = console.warn; console.warn = m => warns.push(String(m));
  let c2;
  try { c2 = HouseLoader.compile(g2, ''); } finally { console.warn = origWarn; }
  check('loader: navigation.order compiled, unknown and repeated ids skipped', c2.navigation.order.join() === 'bedroom,hall,lounge', c2.navigation);
  check('... each with a warning', warns.some(w => w.includes('"ghost"')) && warns.some(w => w.includes('twice')), warns);
  check('loader: no navigation -> an empty order (the arrows follow the rooms)', Array.isArray(demo.navigation.order) && demo.navigation.order.length === 0);
  const full = tourOrder(c2.roomOrder, c2.navigation.order);
  check('... and the tour appends the rest', full.slice(0, 3).join() === 'bedroom,hall,lounge' && full.length === c2.roomOrder.length);
  // The schema and validator.
  const schema = JSON.parse(read('houses/schema.json'));
  const nav = schema.$defs.geometryProfile.properties.navigation;
  check('schema: navigation.order is a unique list of room ids', nav && nav.properties.order.items.$ref === '#/$defs/roomId' && nav.properties.order.uniqueItems === true &&
    nav.additionalProperties === false);
  const py = ['python3', 'python'].find(c => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; } });
  if (py) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nav-'));
    fs.cpSync(path.join(root, 'houses/demo'), dir, { recursive: true });
    const run = geo => {
      fs.writeFileSync(path.join(dir, 'geometry.json'), JSON.stringify(geo));
      try { return { code: 0, out: execFileSync(py, [path.join(root, 'scripts/validate-house.py'), dir], { encoding: 'utf8', stdio: 'pipe' }) }; }
      catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
    };
    const ok = JSON.parse(JSON.stringify(demoGeo)); ok.schemaVersion = '1.6'; ok.navigation = { order: ['hall', 'lounge'] };
    const r1 = run(ok);
    check('validator: a good order passes', r1.code === 0, r1.out.slice(-400));
    const badId = JSON.parse(JSON.stringify(ok)); badId.navigation.order.push('ghost');
    const r2 = run(badId);
    check('validator: an id that is not a room is an error', r2.code !== 0 && r2.out.includes('navigation/order/2'), r2.out.slice(-400));
    const oldV = JSON.parse(JSON.stringify(ok)); oldV.schemaVersion = '1.5';
    const r3 = run(oldV);
    check('validator: navigation under 1.6 warns to bump', r3.out.includes('`navigation` needs schemaVersion 1.6'), r3.out.slice(-400));
    fs.rmSync(dir, { recursive: true, force: true });
  } else console.log('  skip validator checks (no python)');
  const html = read('index.html');
  check('index.html: prev / next follow the tour (the profile order, else roomIds)',
    html.includes('const tourIds = tourOrder(home.roomIds, house.navigation && house.navigation.order);') &&
    /const id = dir === 'next' \? nextRoom\(tourIds, selectedRoom\) : prevRoom\(tourIds, selectedRoom\);/.test(html) &&
    html.includes('const p = prevRoom(tourIds, selectedRoom), n = nextRoom(tourIds, selectedRoom);'));
}

// ---- 9: wiring ----------------------------------------------------------------
section('doors a walk holds, once no flight runs');
{
  const portals = [{ id: 'cup', c: [0, 0] }, { id: 'hall', c: [5, 0] }, { id: 'bed', c: [9, 0] }];
  const k = o => W.heldDoorsToKeep(Object.assign({ portals }, o));
  const at = k({ viewDoor: 'cup', atView: true, held: ['cup'], eye: [1.5, 0] });
  check('at the cupboard outside view: its door stays the view, held', at.viewDoor === 'cup' && [...at.keep].join() === 'cup', at);
  const left = k({ viewDoor: 'cup', atView: false, held: ['cup'], eye: [1.5, 0] });
  check('the eye has left that view (orbit, zoom, setView, a cancel): the leaf is shown again and the door let go',
    left.viewDoor === null && left.keep.size === 0, left);
  const close = k({ viewDoor: 'cup', atView: false, held: ['cup', 'hall'], eye: [0.6, 0.3] });
  check('... but a door the eye is still within 1 m of stays open, the cupboard door included (never shut through the camera)',
    close.viewDoor === null && [...close.keep].sort().join() === 'cup', close);
  const walk = k({ viewDoor: null, atView: false, held: ['hall', 'bed'], eye: [5.9, 0.2] });
  check('a stopped walk: only the doors within 1 m stay held', [...walk.keep].join() === 'hall', walk);
  const clear = k({ viewDoor: null, atView: false, held: ['hall', 'bed'], eye: [5, 1.01] });
  check('... and once the eye is over 1 m clear, every one goes', clear.keep.size === 0, clear);
}

section('wiring');
{
  const scene = read('src/home3d-scene.js');
  const fly = scene.slice(scene.indexOf('    function flyTo(pose, opts) {'), scene.indexOf('    function cancelFlight() {'));
  check('flyTo: a walk between two in-house views, its own duration', fly.includes("if (ra && rb) {") &&
    fly.includes('const plan = planWalk(navGraph(), from, ra, to, rb, { obstacles: walkObstacles() });') &&
    fly.includes('(route.plan ? route.plan.ms :'));
  check('flyTo: the arc only when the walk is impossible or an end is outside', /if \(plan\) return \{ mode: 'walk', plan \};\s*\}\s*return \{ mode: 'arc' \};/.test(fly));
  check('reduced motion (or ms 0) still jumps, and lets the doors go', fly.includes('if (!(ms > 0) || reducedMotion()) { applyPose(pose); releaseWalkDoors(); wake(250); return Promise.resolve(\'landed\'); }'));
  const route = scene.slice(scene.indexOf('    function flightRoute(from, to) {'), scene.indexOf('    function walkReport('));
  check('one room, a straight line: timed and turned like a walk (planGlide) -- a turn on the spot for a shared eye',
    /\{\s*const plan = planGlide\(from, to\);\s*lastWalk = walkReport\(ra, rb, plan\);\s*return \{ mode: 'eye', plan \};/.test(route));
  const rv = scene.slice(scene.indexOf('    function roomView(id, opts) {'), scene.indexOf('    function sharedRoomView(id, opts) {'));
  check('a room view: authored first, then a vantage shared with an open-plan neighbour, then its own in-room view',
    rv.indexOf('const v = ROOMS[id].view;') < rv.indexOf('const shared = sharedRoomView(id, opts);') &&
    /const shared = sharedRoomView\(id, opts\);\s*if \(shared\) return shared;\s*return inRoomView\(id, opts\) \|\| outsideRoomView\(id\) \|\| above\(\);/.test(rv));
  const sr = scene.slice(scene.indexOf('    function sharedRoomView(id, opts) {'), scene.indexOf('    // ---- In-room room views'));
  check('sharedRoomView: open-plan partners only, through sharedVantage, the partner framed from that one eye with sight through the join',
    sr.includes('for (const other of openPartners(id)) {') && sr.includes('sv = sharedVantage({ graph: navGraph(), rooms: [id, other],') &&
    sr.includes('computeInRoomView(room, ins, { eyes: [eye], with: room === id ? other : id })') &&
    scene.includes("p.kind === 'open' && p.rooms.includes(id)") &&
    scene.includes('const sight = extra && extra.with ? (e, p, tail) => sightLeaves(navGraph(), [id, extra.with], e, p, tail) : undefined;') &&
    scene.includes('eyes: extra && extra.eyes, sight });'));
  check('... cached with the room views, keyed by both rooms\' own eyes (an edited authored view is picked up)',
    sr.includes("const key = 'shared|' + [id, other].sort().join('|') + '|' + eyeKey(ownA.eye) + '|' + eyeKey(ownB.eye)") && sr.includes('roomViewCache.set(key, sv);'));
  check('standing at a shared vantage counts as standing in the focused room: the click-away, and a zoom held in the room (either room\'s floor)',
    /function standingRoom\(eye\) \{\s*const r = eyeInRoom\(eye\), fr = pickFocusRoom \? pickFocusRoom\(\) : null;\s*return r && fr && r !== fr && sharedWith\.get\(fr\) === r \? fr : r;/.test(scene) &&
    scene.includes('return fr && standingRoom([cam.position.x, cam.position.y, cam.position.z]) === fr ? fr : null;') &&
    scene.includes('if (inRoomTapIsClickAway({ cameraRoom: standingRoom([cam.position.x, cam.position.y, cam.position.z]), focusedRoom: fr,') &&
    scene.includes('const ids = [room].concat(sharedWith.get(room) && roomShape(sharedWith.get(room)) ? [sharedWith.get(room)] : []);'));
  check('the tick uses the walk\'s own speed profile',scene.includes('applyPose(flight.plan.at((flight.plan.ease || easeInOut)(Math.max(0, t))));'));
  check('a cupboard\'s own door is hidden while it is the view, shown when another flight starts',
    /walkViewDoor = outsideDoorFor\(to\);\s*setViewDoor\(walkViewDoor\);/.test(scene) &&
    /if \(show && show\.pivot\) show\.pivot\.visible = true;/.test(scene) && /doorById\[hiddenViewDoor\]\.pivot\.visible = false;/.test(scene));
  check('cancel / land lets the held doors go (and settles the rest at once); a superseding flight hands them over',
    /flight = null;\s*if \(status !== 'superseded'\) \{ releaseWalkDoors\(status === 'cancelled'\); settleWalkDoors\(\); \}/.test(scene));
  // Reviews 5a0c350c / ec775cca: with no flight running, a cancelled walk,
  // setView / setOrbit or a hand orbit / zoom away lets the cupboard's leaf
  // and the held doors go. Every drawn frame settles them (setView, setOrbit
  // and the hand gestures all draw one), through the tested heldDoorsToKeep.
  const settle = scene.slice(scene.indexOf('    function settleWalkDoors() {'), scene.indexOf('    // The door of the room whose outside view this pose is'));
  check('settleWalkDoors: idle while a flight runs, decides through heldDoorsToKeep, at the eye where it is',
    settle.includes('if (flight || (!walkViewDoor && !walkDoorHold.size)) return;') &&
    settle.includes('atView: !!walkViewDoor && outsideDoorFor(getPose()) === walkViewDoor,') &&
    settle.includes('held: [...walkDoorHold.keys()], eye: [cam.position.x, cam.position.z], portals: navGraph().portals });'));
  check('... shows the leaf when the view is left, and swings back what is let go (to the latest sensor state)',
    settle.includes('if (s.viewDoor !== walkViewDoor) { walkViewDoor = s.viewDoor; setViewDoor(walkViewDoor); }') &&
    settle.includes('if (s.keep.size !== walkDoorHold.size) holdDoorsOpen(s.keep);') &&
    /walkDoorHold\.forEach\(\(pct, id\) => \{ if \(!ids\.has\(id\)\) \{ walkDoorHold\.delete\(id\); swingDoor\(id, pct\); \} \}\);/.test(scene));
  check('... on every drawn frame', /const flightMoving = tickCameraFlight\(frameNow\);\s*settleWalkDoors\(\);/.test(scene));
  check('... except, when cancelled, a door the camera stands within 1 m of', /if \(cancelled\) \{[\s\S]{0,300}Math\.hypot\(c\.x - p\.c\[0\], c\.z - p\.c\[1\]\) < 1\) keep\.add\(id\);/.test(scene));
  check('the ceiling only clears for the flight over the walls, not a walk', /const ceilTarget = arcFlight \|\| cam\.position\.y > WH \? 0 : 1\.0;/.test(scene) &&
    scene.includes('const arcFlight = !!(flight && flight.arc);'));
  check('walls stay solid for the whole walk, doorways included', scene.includes('const camInside = !!(flight && flight.walk) || !!eyeInRoom('));
  check('a cupboard: the outside view before the view from above', scene.includes('return inRoomView(id, opts) || outsideRoomView(id) || above();'));
  check('a sensor / slider on a held door waits until it is let go', scene.includes('if (walkDoorHold.has(doorId)) { walkDoorHold.set(doorId, target); return; }') &&
    scene.includes('if (dr.id && walkDoorHold.has(dr.id)) { walkDoorHold.set(dr.id,'));
  const ci = read('.github/workflows/ci.yml');
  check('CI runs this file', ci.includes('node scripts/test-doorway-walk.mjs'));
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
