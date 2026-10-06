#!/usr/bin/env node
/**
 * In-room room views and the flights into them (src/camera-focus.js
 * chooseInRoomView / planFlight), plus the scene wiring a parse cannot see.
 * No framework, no install -- `node scripts/test-room-view.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. The camera is always strictly inside the room polygon, clear of the
 *      walls, and the pose it returns really puts the eye there.
 *   2. The camera is never above (or within the gap of) the ceiling.
 *   3. An L-shaped room: the vantage sees the larger arm (or both) -- the
 *      room's own notch walls hide what is round the corner.
 *   4. The corner-shot preference: a corner beats a wall-midpoint vantage
 *      that is otherwise as good (here: nudged by a doorway beside it).
 *   5. The caller's ray test (a fake raycaster) steers the choice away from
 *      eyes it says are blocked, and only the best few eyes are ray-tested.
 *   6. A cupboard no camera can stand in falls back (pose null).
 *   7. A covering sidebar shifts the frame so the room sits in the visible part.
 *   8. Flights (planFlight's arc: now only with one end outside the house --
 *      room to room walks, scripts/test-doorway-walk.mjs): into/out of a room
 *      the eye stays above the walls except
 *      straight above either end; within a room it is a straight line;
 *      outside it is the old orbit lerp; the azimuth never jumps.
 *   9. Wiring: roomView prefers the in-room view (an authored view still
 *      wins); walls render solid from inside; flyTo plans its path; edit
 *      mode's "Reset to derived" keeps the derived lens; CI runs this file.
 */
import fs from 'node:fs';
import path from 'node:path';
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

const M = await imp('src/camera-focus.js');
const { insidePoly } = await imp('src/footstep-walk.js');
const { chooseInRoomView, planFlight, eyeOf, lerpPose, IN_ROOM_VIEW, distToPolyEdge, leavesRoom, floorGrid, lookBasis } = M;

const box = (x, z, w, d, h, y0 = 0) => ({ min: [x, y0, z], max: [x + w, y0 + h, z + d] });
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---- 1 + 2: inside, below the ceiling --------------------------------------
section('inside the room, below the ceiling');
const rooms = {
  rect: [[0, 0], [4, 0], [4, 3], [0, 3]],
  // clockwise winding, offset origin
  cw: [[10, 10], [10, 13.5], [14.2, 13.5], [14.2, 10]],
  L: [[0, 0], [6, 0], [6, 2], [2, 2], [2, 5], [0, 5]],
  U: [[0, 0], [5, 0], [5, 4], [3.6, 4], [3.6, 1.5], [1.4, 1.5], [1.4, 4], [0, 4]],
};
for (const [name, poly] of Object.entries(rooms)) {
  for (const ceiling of [2.5, 2.2, 1.9]) {
    const r = chooseInRoomView({ poly, ceiling, items: [], aspect: 1.6 });
    const e = r.eye, pe = r.pose ? eyeOf(r.pose) : null;
    check(`${name} @${ceiling}: an in-room view`, !r.fallback && !!r.pose, r);
    if (!r.pose) continue;
    check(`${name} @${ceiling}: eye strictly inside the polygon`, insidePoly(poly, e[0], e[2]));
    check(`${name} @${ceiling}: eye clear of every wall`, distToPolyEdge(poly, e[0], e[2]) >= IN_ROOM_VIEW.inset * 0.85 - 1e-9,
      distToPolyEdge(poly, e[0], e[2]));
    check(`${name} @${ceiling}: eye below the ceiling (gap kept)`, e[1] <= ceiling - IN_ROOM_VIEW.ceilingGap + 1e-9, e);
    check(`${name} @${ceiling}: the pose puts the eye there`, near(pe[0], e[0], 1e-6) && near(pe[1], e[1], 1e-6) && near(pe[2], e[2], 1e-6), { pe, e });
    check(`${name} @${ceiling}: looks down, not up`, r.pose.ph > 0 && r.pose.ph < Math.PI / 2);
  }
}
// Every candidate vantage -- not just the winner -- is inside and clear,
// including a reflex corner's and a 65 cm corridor, too narrow for a wall
// inset from both sides.
{
  const corridor = [[0, 0], [5, 0], [5, 0.65], [0, 0.65]];
  for (const [name, poly] of Object.entries(Object.assign({ corridor }, rooms))) {
    const vs = M.roomVantages(poly, IN_ROOM_VIEW.inset);
    // (A room too narrow for any gets its interior point, a third of the inset clear.)
    const bad = vs.filter(v => !insidePoly(poly, v.x, v.z) ||
      distToPolyEdge(poly, v.x, v.z) < (v.kind === 'centre' ? IN_ROOM_VIEW.inset / 3 : IN_ROOM_VIEW.inset * 0.85) - 1e-9);
    check(`${name}: every candidate vantage inside and clear of the walls`, bad.length === 0, bad);
  }
}
// Furniture never swallows the eye.
{
  const poly = rooms.rect;
  // Tall units in every corner, up to the ceiling.
  const items = [box(0, 0, 1, 1, 2.5), box(3, 0, 1, 1, 2.5), box(3, 2, 1, 1, 2.5), box(0, 2, 1, 1, 2.5)].map((b, i) => ({ id: 'u' + i, box: b }));
  const r = chooseInRoomView({ poly, ceiling: 2.5, items, aspect: 1.6 });
  const pad = IN_ROOM_VIEW.eyePad;
  const inside = items.some(it => r.eye[0] >= it.box.min[0] - pad && r.eye[0] <= it.box.max[0] + pad &&
    r.eye[2] >= it.box.min[2] - pad && r.eye[2] <= it.box.max[2] + pad);
  check('the eye never stands inside (or touching) a furniture box', !inside, r.eye);
}

// ---- 3: L-shaped rooms -----------------------------------------------------
section('L-shaped room');
{
  // Large arm along x (6 x 2), small arm down z (2 x 3).
  const L = rooms.L;
  const largeArm = [[0, 0], [6, 0], [6, 2], [0, 2]];
  const grid = floorGrid(largeArm, 40, 0.15).map(p => [p[0], 0.05, p[1]]);
  const seenFrom = eye => grid.filter(p => !leavesRoom(L, eye, p)).length / grid.length;
  // Furniture in both arms.
  const both = chooseInRoomView({ poly: L, ceiling: 2.5, aspect: 1.6,
    items: [{ id: 'a', box: box(4.5, 0.5, 1, 1, 1) }, { id: 'b', box: box(0.5, 4, 1, 0.8, 1) }] });
  check('both arms furnished: the vantage sees the whole large arm', seenFrom(both.eye) > 0.95, { eye: both.eye, f: seenFrom(both.eye) });
  const smallSeen = (() => {
    const g = floorGrid([[0, 2], [2, 2], [2, 5], [0, 5]], 20, 0.15).map(p => [p[0], 0.05, p[1]]);
    return g.filter(p => !leavesRoom(L, both.eye, p)).length / g.length;
  })();
  check('both arms furnished: ... and the small arm too (the joint corner)', smallSeen > 0.95, { eye: both.eye, smallSeen });
  // Furniture only at the far end of the large arm: never a vantage in the small arm's far end.
  const one = chooseInRoomView({ poly: L, ceiling: 2.5, aspect: 1.6,
    items: [{ id: 'a', box: box(4.5, 0.3, 1.2, 1.2, 1.2) }, { id: 'c', box: box(3, 0.2, 1, 0.6, 0.9) }] });
  check('large arm furnished: the eye is not in the small arm beyond the notch', one.eye[2] < 2.2, one.eye);
  check('large arm furnished: the large arm is in view', seenFrom(one.eye) > 0.95, seenFrom(one.eye));
}

// ---- 4: corner preference --------------------------------------------------
section('corner-shot preference');
{
  const poly = [[0, 0], [4, 0], [4, 4], [0, 4]];
  // A lens so wide every vantage sees everything: only the preferences
  // decide. A doorway right behind the south wall's midpoint vantage nudges
  // it (doorBonus), by less than a corner earns (cornerBonus).
  const opts = { fov: 150, minHFov: 150, maxFov: 150, depthBonus: 0, cornersSeenBonus: 0, pitchPenalty: 0 };
  const doors = [[2, 0]];
  const withCorner = chooseInRoomView({ poly, ceiling: 2.5, items: [], aspect: 1.6, doors, options: opts });
  const noCorner = chooseInRoomView({ poly, ceiling: 2.5, items: [], aspect: 1.6, doors, options: Object.assign({}, opts, { cornerBonus: 0 }) });
  check('equal coverage: a corner wins over a wall-midpoint by the doorway', withCorner.kind === 'corner', withCorner);
  check('(control) without the corner bonus that midpoint wins', noCorner.kind === 'edge' && near(noCorner.eye[0], 2, 1e-6), noCorner);
  // And in plain rectangles of several shapes, at desktop and portrait aspects.
  for (const [w, d] of [[3, 3], [4, 3], [6, 3], [2.6, 2]]) for (const aspect of [1.8, 0.6]) {
    const r = chooseInRoomView({ poly: [[0, 0], [w, 0], [w, d], [0, d]], ceiling: 2.5, items: [], aspect });
    check(`${w}x${d} @${aspect}: a corner shot`, r.kind === 'corner', r.kind);
  }
}

// ---- 5: the caller's ray test ----------------------------------------------
section('fake raycaster');
{
  const poly = [[0, 0], [5, 0], [5, 4], [0, 4]];
  const items = [{ id: 't', box: box(2, 1.5, 1, 1, 0.75) }];
  const free = chooseInRoomView({ poly, ceiling: 2.5, items, aspect: 1.6, occluded: () => false });
  let calls = 0;
  // A fake raycaster: from any eye west of x = 2.5 everything is blocked
  // (as if a chimney breast stood there).
  const res = chooseInRoomView({ poly, ceiling: 2.5, items, aspect: 1.6, occluded: (eye) => { calls++; return eye[0] < 2.5; } });
  check('(control) unblocked, a west vantage is a candidate winner or not -- the test still has teeth', free.eye != null);
  check('blocked eyes are avoided: the eye stands east of the obstruction', res.eye[0] > 2.5, res.eye);
  check('the ray test really ran', calls > 0 && res.rays === calls, { calls, rays: res.rays });
  const eyes = res.tried;
  const samplesPerEye = calls / Math.min(eyes, IN_ROOM_VIEW.refine);
  check('only the best few eyes are ray-tested', calls <= IN_ROOM_VIEW.refine * 400 && samplesPerEye > 0, { calls, eyes });
  // All-blocked: coverage collapses and the chooser says so.
  const blind = chooseInRoomView({ poly, ceiling: 2.5, items, aspect: 1.6, occluded: () => true, options: { refine: 100 } });
  check('everything blocked: falls back', blind.fallback && blind.pose === null, blind);
}

// ---- 6: a cupboard falls back ----------------------------------------------
section('fallback');
{
  const r = chooseInRoomView({ poly: [[0, 0], [0.92, 0], [0.92, 0.7], [0, 0.7]], ceiling: 2.5, items: [], aspect: 1.6 });
  check('a 92 x 70 cm cupboard: no in-room view', r.fallback === true && r.pose === null, r);
  const ok = chooseInRoomView({ poly: [[0, 0], [2.1, 0], [2.1, 1.45], [0, 1.45]], ceiling: 2.5, items: [], aspect: 1.6 });
  check('a 2.1 x 1.45 m en suite: still in-room', ok.fallback === false && !!ok.pose, ok);
}

// ---- 7: a covering sidebar -------------------------------------------------
section('sidebar inset');
{
  const poly = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const items = [{ id: 't', box: box(1.5, 1, 1, 1, 0.75) }];
  const inset = { right: 480, width: 1600, height: 900 };
  const r = chooseInRoomView({ poly, ceiling: 2.5, items, aspect: 1600 / 900, inset });
  // Project the room's interior point: it must sit LEFT of the camera's
  // centre line (in the uncovered part), and inside the uncovered window.
  const e = r.eye, p = r.pose;
  const f = [p.tgt[0] - e[0], p.tgt[1] - e[1], p.tgt[2] - e[2]];
  const B = lookBasis(Math.atan2(f[2], f[0]), Math.asin(-f[1] / Math.hypot(...f)));
  const c = [2, 0.4, 1.5], q = [c[0] - e[0], c[1] - e[1], c[2] - e[2]];
  const z = q[0] * B.f[0] + q[1] * B.f[1] + q[2] * B.f[2];
  const ndcX = (q[0] * B.r[0] + q[2] * B.r[2]) / z / (Math.tan(p.fov * Math.PI / 360) * 1600 / 900);
  check('the room centre is in the uncovered window', ndcX < 1 - 2 * 480 / 1600, ndcX);
  check('... shifted left of the canvas centre', ndcX < 0.05, ndcX);
  // Furniture all round the room: whatever the chooser counts as in frame
  // must be in the UNCOVERED part -- nothing it scored sits under the panel.
  const ring = [box(0.2, 0.2, 0.8, 0.5, 0.9), box(3, 0.2, 0.8, 0.5, 0.9), box(3, 2.3, 0.8, 0.5, 0.9), box(0.2, 2.3, 0.8, 0.5, 0.9), box(1.6, 1.2, 0.8, 0.6, 0.75)]
    .map((b, i) => ({ id: 'k' + i, box: b }));
  const tv = Math.tan(70 * Math.PI / 360);
  const rr = chooseInRoomView({ poly, ceiling: 2.5, items: ring, aspect: 1600 / 900, inset, options: { fov: 70, minHFov: 10 } });
  const ee = rr.eye, pp = rr.pose, ff = [pp.tgt[0] - ee[0], pp.tgt[1] - ee[1], pp.tgt[2] - ee[2]];
  const BB = lookBasis(Math.atan2(ff[2], ff[0]), Math.asin(-ff[1] / Math.hypot(...ff)));
  const xs = ring.map(it => {
    const b = it.box, cc = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const qq = [cc[0] - ee[0], cc[1] - ee[1], cc[2] - ee[2]];
    const zz = qq[0] * BB.f[0] + qq[1] * BB.f[1] + qq[2] * BB.f[2];
    return zz > 0 ? (qq[0] * BB.r[0] + qq[2] * BB.r[2]) / zz / (tv * 1600 / 900) : -9;
  });
  check('nothing it frames sits under the sidebar', xs.every(x => x < 1 - 2 * 480 / 1600 + 0.02), xs);
  check('... and it does frame most of the ring', xs.filter(x => x > -1 && x < 0.4).length >= 3, xs);
}

// ---- 8: flights ------------------------------------------------------------
section('flights');
{
  const clearY = 3;
  const outside = { th: 0.7, ph: 1.0, r: 13, tgt: [5, 0, 4], fov: 50 };
  const inA = M.poseFromLook([1, 2.2, 1], 0.6, 0.4, 2, 70);
  const inA2 = M.poseFromLook([2.5, 2.0, 1.2], 2.2, 0.35, 2, 70);
  const inB = M.poseFromLook([8, 2.2, 6], -2.4, 0.4, 2, 70);
  const sample = (pl, n = 400) => { const out = []; for (let i = 0; i <= n; i++) out.push(pl.at(M.easeInOut(i / n))); return out; };
  const maxStep = poses => { let m = 0; for (let i = 1; i < poses.length; i++) m = Math.max(m, Math.abs(M.shortestArc(poses[i - 1].th, poses[i].th))); return m; };
  for (const [name, a, b] of [['outside -> room', outside, inA], ['room -> outside', inA, outside], ['room -> other room', inA, inB]]) {
    const pl = planFlight(a, b, { mode: 'arc', clearY });
    const ea = eyeOf(a), eb = eyeOf(b);
    const poses = sample(pl);
    const bad = poses.map(eyeOf).filter(e => e[1] < clearY - 1e-6 &&
      !(near(e[0], ea[0], 1e-6) && near(e[2], ea[2], 1e-6)) && !(near(e[0], eb[0], 1e-6) && near(e[2], eb[2], 1e-6)));
    check(`${name}: below the walls only straight above an end`, bad.length === 0, bad.slice(0, 3));
    const last = poses[poses.length - 1], first = poses[0];
    check(`${name}: lands exactly`, near(last.r, b.r) && near(last.tgt[0], b.tgt[0]) && near(last.tgt[2], b.tgt[2]) && near(last.fov, b.fov));
    check(`${name}: starts exactly`, near(first.r, a.r) && near(first.tgt[1], a.tgt[1]));
    check(`${name}: the azimuth never jumps (< 3 deg per 1/400)`, maxStep(poses) < 3 * Math.PI / 180, maxStep(poses) * 180 / Math.PI);
  }
  // Within one room: a straight line.
  const st = planFlight(inA, inA2, { mode: 'eye' });
  const ea = eyeOf(inA), eb = eyeOf(inA2);
  const mid = eyeOf(st.at(0.5));
  check('within a room: the eye moves in a straight line', near(mid[0], (ea[0] + eb[0]) / 2, 1e-6) && near(mid[1], (ea[1] + eb[1]) / 2, 1e-6), { mid, ea, eb });
  // Outside: unchanged.
  const o2 = { th: 2.0, ph: 0.6, r: 9, tgt: [3, 0, 3], fov: 50 };
  const orb = planFlight(outside, o2, { mode: 'orbit' }).at(0.3), ref = lerpPose(outside, o2, 0.3);
  check('outside: the orbit lerp, as before', near(orb.th, ref.th) && near(orb.r, ref.r) && near(orb.tgt[0], ref.tgt[0]));
}

// ---- 10: what counts -- big things over many small ones; the tilt -----------
section('weights, tilt, foreground');
{
  const { itemWeight } = M;
  const bed = box(0, 0, 1.6, 2.1, 1.1), planter = box(0, 1.5, 0.1, 0.25, 0.4, 1.4);
  check('a bed outweighs a wall planter twenty times over', itemWeight(bed) > 20 * itemWeight(planter), [itemWeight(bed), itemWeight(planter)]);
  check('... a full-height curtain counts like a wardrobe, not a sign', itemWeight(box(0, 0, 2, 0.18, 2.5)) > 4);
  // A 4 x 4.5 m bedroom: the bed, wardrobe and curtains along the south
  // half, six small wall planters and a sign on the north wall. The view
  // must face the big things, wherever it stands.
  const poly = [[0, 0], [4, 0], [4, 4.5], [0, 4.5]];
  const items = [
    { id: 'bed', box: box(1.2, 2.6, 1.6, 1.9, 1.1) },
    { id: 'wardrobe', box: box(0, 3.9, 1.2, 0.6, 2.3) },
    { id: 'curtain', kind: 'curtain', box: box(2.6, 4.3, 1.3, 0.2, 2.5) },
  ];
  for (let i = 0; i < 6; i++) items.push({ id: 'planter' + i, box: box(0.4 + i * 0.55, 0, 0.25, 0.1, 0.35, 1.5) });
  items.push({ id: 'sign', box: box(1.5, 0, 1, 0.03, 0.4, 1.6) });
  const r = chooseInRoomView({ poly, ceiling: 2.5, items, aspect: 1.6 });
  const e = r.eye, p = r.pose;
  const f = [p.tgt[0] - e[0], p.tgt[1] - e[1], p.tgt[2] - e[2]];
  const B = lookBasis(Math.atan2(f[2], f[0]), Math.asin(-f[1] / Math.hypot(...f)));
  const tv = Math.tan(p.fov * Math.PI / 360), th = tv * 1.6;
  const inFrame = b => {
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const q = [c[0] - e[0], c[1] - e[1], c[2] - e[2]];
    const z = q[0] * B.f[0] + q[1] * B.f[1] + q[2] * B.f[2];
    return z > 0 && Math.abs((q[0] * B.r[0] + q[2] * B.r[2]) / z) <= th && Math.abs((q[0] * B.u[0] + q[1] * B.u[1] + q[2] * B.u[2]) / z) <= tv;
  };
  check('the bed, wardrobe and curtains are all in frame', ['bed', 'wardrobe', 'curtain'].every(id => inFrame(items.find(i => i.id === id).box)),
    { eye: e, ranked: r.ranked && r.ranked.slice(0, 3) });
  // The tilt: never steeper than maxPitch in a normal room, so the ceiling
  // and its lights stay in the top of the frame; a small room may tilt more.
  for (const [w, d] of [[3.4, 2.9], [4.5, 3.4], [6, 4]]) {
    const rr = chooseInRoomView({ poly: [[0, 0], [w, 0], [w, d], [0, d]], ceiling: 2.5, aspect: 1.6,
      items: [{ id: 't', box: box(w / 2 - 0.5, d / 2 - 0.5, 1, 1, 0.75) }] });
    const pitch = 90 - rr.pose.ph * 180 / Math.PI;
    check(`${w}x${d}: tilt <= ${IN_ROOM_VIEW.maxPitch} deg`, pitch <= IN_ROOM_VIEW.maxPitch + 1e-6, pitch);
  }
  check('maxPitch is below the steepest tilt tried (the cap really caps)', IN_ROOM_VIEW.maxPitch < Math.max(...IN_ROOM_VIEW.pitchesDeg));
  // Foreground clipping: a dining table in the middle of a 3.4 x 2.9 m
  // kitchen, a run of units and a sofa. Without the penalty the best view
  // cuts the table with the bottom of the frame; with it, it does not.
  const kpoly = [[0, 0], [3.4, 0], [3.4, 2.9], [0, 2.9]];
  const kitems = [
    { id: 'table', box: box(1.2, 0.95, 1, 1, 0.75) }, { id: 'runA', box: box(0, 0, 2.8, 0.6, 0.9) },
    { id: 'sofa', box: box(2.4, 2.0, 0.9, 0.9, 0.8) },
  ];
  // Table samples visible past the other boxes but under the frame's bottom edge.
  const clippedVisible = res => {
    const ee = res.eye, pp = res.pose, ff = [pp.tgt[0] - ee[0], pp.tgt[1] - ee[1], pp.tgt[2] - ee[2]];
    const BB = lookBasis(Math.atan2(ff[2], ff[0]), Math.asin(-ff[1] / Math.hypot(...ff)));
    const t2 = Math.tan(pp.fov * Math.PI / 360);
    return M.boxSamples(kitems[0].box).filter(c => {
      if (kitems.some((o, i) => i > 0 && M.segmentHitsBox(ee, c, o.box))) return false;
      const q = [c[0] - ee[0], c[1] - ee[1], c[2] - ee[2]];
      const z = q[0] * BB.f[0] + q[1] * BB.f[1] + q[2] * BB.f[2];
      return (q[0] * BB.u[0] + q[1] * BB.u[1] + q[2] * BB.u[2]) / z / t2 < -IN_ROOM_VIEW.frustumMargin;
    }).length;
  };
  const withP = chooseInRoomView({ poly: kpoly, ceiling: 2.5, items: kitems, aspect: 1.6 });
  const noP = chooseInRoomView({ poly: kpoly, ceiling: 2.5, items: kitems, aspect: 1.6, options: { clipPenalty: 0 } });
  check('(control) without the clip penalty the table is cut by the bottom of the frame', clippedVisible(noP) > 0, clippedVisible(noP));
  check('foreground: with it, the table is whole', clippedVisible(withP) === 0, { eye: withP.eye, n: clippedVisible(withP) });
}

// ---- 11: click-away from inside a room -------------------------------------
section('click-away from inside');
{
  const { inRoomTapIsClickAway: away, escapeDeselects: esc } = M;
  check('in the focused room, a tap on its own walls/ceiling/floor goes home', away({ cameraRoom: 'k', focusedRoom: 'k', pickedRoom: 'k', hitFurniture: false }));
  check('... a tap on its furniture does not', !away({ cameraRoom: 'k', focusedRoom: 'k', pickedRoom: 'k', hitFurniture: true }));
  check('... a tap through a doorway selects the neighbour', !away({ cameraRoom: 'k', focusedRoom: 'k', pickedRoom: 'hall', hitFurniture: false }));
  check('from outside the house nothing changes', !away({ cameraRoom: null, focusedRoom: 'k', pickedRoom: 'k', hitFurniture: false }));
  check('inside a room that is not the focused one (a device view), a tap selects it as before',
    !away({ cameraRoom: 'k', focusedRoom: null, pickedRoom: 'k', hitFurniture: false }));
  check('Escape with a room selected and nothing open deselects', esc({ key: 'Escape', selectedRoom: 'k', target: { tagName: 'BODY' } }));
  check('... not when a card is open (Escape closes the card first)', !esc({ key: 'Escape', selectedRoom: 'k', cardOpen: true }));
  check('... not from a dialog, edit mode, or a text field', !esc({ key: 'Escape', selectedRoom: 'k', dialogOpen: true }) &&
    !esc({ key: 'Escape', selectedRoom: 'k', editActive: true }) && !esc({ key: 'Escape', selectedRoom: 'k', target: { tagName: 'INPUT' } }));
  check('... and nothing to deselect, or another key, does nothing', !esc({ key: 'Escape', selectedRoom: null }) && !esc({ key: 'Enter', selectedRoom: 'k' }));
}

// ---- 12: follow-ups from the PR #143 review (item 71d7f4e4) -----------------
section('furniture hides furniture; the in-room clamp; the same-room line');
{
  // A tall wardrobe stands between the west of the room and the prize; only
  // the east corners see the prize. With the floor nearly weightless, the
  // prize decides -- so the chosen eye must really see it. (Without the
  // furniture-on-furniture test, a west corner "sees" it through the wardrobe.)
  const poly = [[0, 0], [6, 0], [6, 3], [0, 3]];
  const wardrobe = box(3.8, 0, 0.4, 2.6, 2.3), prize = box(4.8, 0.6, 0.9, 0.9, 0.8);
  const r = chooseInRoomView({ poly, ceiling: 2.5, items: [{ id: 'wardrobe', box: wardrobe }, { id: 'prize', box: prize }], aspect: 1.6, options: { floorWeight: 0.05 } });
  const pc = [(prize.min[0] + prize.max[0]) / 2, 0.4, (prize.min[2] + prize.max[2]) / 2];
  check('a tall item hiding another from a corner: the chosen eye has a clear line to the hidden one', r.eye && !M.segmentHitsBox(r.eye, pc, wardrobe), r.eye);

  // clampRadiusInside: a zoom-out / orbit stops at the region's edge.
  const inside = e => e[0] > 0 && e[0] < 4 && e[2] > 0 && e[2] < 3 && e[1] < 2.4;
  const tgt = [2, 0.8, 1.5], th = 0, ph = Math.PI * 0.4;   // looking toward -x: the eye backs toward +x
  const r0 = M.clampRadiusInside(tgt, th, ph, 1, inside);
  check('clamp: an eye already inside is untouched', r0 === 1);
  const r1 = M.clampRadiusInside(tgt, th, ph, 6, inside);
  const e1 = M.backVector(th, ph).map((b, i) => tgt[i] + b * r1);
  check('clamp: a zoom-out past the wall stops just inside it', inside(e1) && r1 > 1.5 && e1[0] > 3.9, { r1, e1 });
  const r2 = M.clampRadiusInside([9, 0.8, 1.5], th, ph, 6, inside);
  check('clamp: a target outside the region is left alone (nothing to keep)', r2 === 6);

  // The same-room straight line: exact edge test. A U room whose notch tip
  // pokes between two sample points along the line.
  const U = [[0, 0], [10, 0], [10, 4], [5.45, 4], [5.45, 1.0], [5.35, 1.0], [5.35, 4], [0, 4]];
  const a = [1, 1.5, 2], b = [9, 1.5, 2];
  let sampled = true;
  for (let i = 1; i < 10; i++) { const x = a[0] + (b[0] - a[0]) * i / 10; sampled = sampled && insidePoly(U, x, 2); }
  check('(fixture) 9 samples miss the thin notch', sampled === true);
  check('the exact test sees the line leave the room through the notch', leavesRoom(U, a, b, 0) === true);
  check('...and a line that stays inside is not flagged', leavesRoom(U, [1, 1.5, 0.5], [9, 1.5, 0.5], 0) === false);
}

// ---- 9: wiring -------------------------------------------------------------
section('wiring');
{
  const scene = read('src/home3d-scene.js');
  const rv = scene.slice(scene.indexOf('    function roomView(id, opts) {'), scene.indexOf('    // ---- In-room room views'));
  check('roomView: an authored view returns before anything is derived', rv.indexOf('const v = ROOMS[id].view;') < rv.indexOf('return inRoomView(id, opts) || outsideRoomView(id) || above();') &&
    /if \(v\) \{[\s\S]*?return \{ th: v\.th/.test(rv));
  // A cupboard is now seen from the room it opens onto (test-doorway-walk.mjs);
  // the view from above only for a room with no opening onto another.
  check('roomView: in-room first, then from outside its door, the view from above only as the last fallback', rv.includes('return inRoomView(id, opts) || outsideRoomView(id) || above();'));
  check('the room-view cache is dropped when the furniture is rebuilt, shown/hidden, or the aspect changes (latest aspect only)',
    /if \(roomViewCacheFurn !== furnitureResult \|\| roomViewCacheVis !== furnitureVisible \|\| roomViewCacheAspect !== aspectKey\) \{\s*roomViewCache\.clear\(\);/.test(scene));
  check('a zoom-out or an orbit in the focused room keeps the eye in it',
    /function zoomBy\(factor\) \{\s*const held = factor > 1 \? heldRoom\(\) : null;[\s\S]{0,800}keepEyeInRoom\(held\);\s*\}/.test(scene) &&
    /const held = heldRoom\(\);\s*orb\.th \+=[^\n]*\n[^\n]*orb\.ph = [^\n]*\n\s*keepEyeInRoom\(held\);/.test(scene) &&
    /orb\.r = clampRadiusInside\(\[orb\.tgt\.x, orb\.tgt\.y, orb\.tgt\.z\], orb\.th, orb\.ph, orb\.r, inside\);/.test(scene));
  check('a same-room flight is a straight line only when it crosses no room edge (exact, not sampled)',
    /if \(ra && ra === rb && !leavesRoom\(roomShape\(ra\)\.map\(p => \[tx\(p\[0\]\), tz\(p\[1\]\)\]\), a, b, 0\)\) return \{ mode: 'eye' \};/.test(scene));
  check('walls render solid while the camera is inside a room', scene.includes('const targetOpacity = camInside ? b : wallFadeTarget(dot, b);'));
  check('the ceiling clears during a flight over the walls', /const ceilTarget = arcFlight \|\| cam\.position\.y > WH \? 0 : 1\.0;/.test(scene));
  // Room to room is now a walk through the doorways (test-doorway-walk.mjs);
  // the arc remains for a flight with one end outside the house.
  check('flyTo plans its path (walk / arc / eye / orbit)', scene.includes("const plan = route.plan || planFlight(from, to, { mode, clearY: WH + 0.5 });") &&
    scene.includes('applyPose(flight.plan.at((flight.plan.ease || easeInOut)(Math.max(0, t))));'));
  check('device occlusion agrees: nothing fades from inside a room', scene.includes('const fades = w => !inside && wallFadeTarget('));
  const em = read('src/edit-mode.js');
  check('Reset to derived keeps the derived view\'s own lens', em.includes('if (pose && pose.fov == null) pose.fov = DEFAULT_FOV;') &&
    !em.includes('      if (pose) pose.fov = DEFAULT_FOV;'));
  {
    const i = scene.indexOf('if (inRoomTapIsClickAway({ cameraRoom: eyeInRoom([cam.position.x, cam.position.y, cam.position.z]), focusedRoom: fr,');
    const j = scene.indexOf('if (picked.roomId && onRoomClick) onRoomClick(picked.roomId);');
    check('a tap from inside the focused room is the click-away, decided (and returned) before the room click',
      i > 0 && j > i && j - i < 300 && /\}\)\) return;/.test(scene.slice(i, j)));
  }
  check("a room's curtains count as its items", /CURTAINS\.forEach\(cu => \{\s*const e = curtainById\[cu\.id\];\s*if \(cu\.room !== id/.test(scene));
  const html = read('index.html');
  check('Escape deselects through escapeDeselects, in the capture phase', /if \(!escapeDeselects\(\{[\s\S]*?\}\)\) return;\s*selectedRoom = null; renderPanel\(\); focusRoom\('explicit'\);\s*\}, true\);/.test(html));
  const ci = read('.github/workflows/ci.yml');
  check('CI runs this file', ci.includes('node scripts/test-room-view.mjs'));
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
