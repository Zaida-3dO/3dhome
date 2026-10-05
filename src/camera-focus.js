/**
 * camera-focus.js -- the camera follows what is selected.
 *
 * Tap a room and the camera slides to a fixed showcase view of that room;
 * tap a device and it slides in on the device, then the device's card opens.
 * Click away (nothing selected) and it slides back to wherever it was before
 * the first selection -- the "home" pose, captured at that moment.
 *
 * This module is the PURE half: the view maths, the selection reducer, a
 * small controller that batches selection changes, and a generation gate.
 * It has no DOM, no renderer and no THREE import. The scene owns the flight
 * itself (src/home3d-scene.js flyTo); index.html and src/tap-popovers.js
 * feed the controller. Unit-tested in scripts/test-camera-focus.mjs.
 *
 * POSES are orbit terms, the same ones the scene runs on:
 *   { th, ph, r, tgt: [x, y, z], fov }
 *   th  azimuth (radians; the camera sits at th around the target)
 *   ph  polar angle from straight up (radians)
 *   r   distance from the target (metres)
 *   tgt the look-at point (world metres)
 *   fov vertical field of view (degrees)
 *
 * SELECTION is { room, device }: `room` a room id, `device` a tap target
 * ({ kind, id, ... }) or null. A device beats a room, and a room beats home.
 *
 * MODES. Every selection change arrives as either:
 *   'explicit'  the user clicked away / chose something: a background tap,
 *               a sidebar X / Back / Controls, Escape, tapping away from a
 *               card, a room or device tap. The camera flies.
 *   'gesture'   the selection changed because the user is driving the
 *               camera: a drag after a room tap closed the unpinned sidebar,
 *               a wheel or a camera move closed a card. The camera NEVER
 *               flies on a gesture, and if nothing is left selected the home
 *               pose is forgotten -- the user put the camera where it is.
 */

import { insidePoly } from './footstep-walk.js';

const TAU = Math.PI * 2;

/** Ease-in-out cubic on [0, 1]. */
export function easeInOut(t) {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** The signed shortest turn from angle a to angle b, in (-PI, PI]. */
export function shortestArc(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d <= -Math.PI) d += TAU;
  return d;
}

/**
 * The pose a fraction t of the way from a to b (t is NOT eased here).
 * Azimuth takes the shortest arc; distance is interpolated in log space so a
 * long zoom does not rush its last metre.
 */
export function lerpPose(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  const L = (x, y) => x + (y - x) * k;
  const ra = Math.max(1e-6, a.r), rb = Math.max(1e-6, b.r);
  return {
    th: a.th + shortestArc(a.th, b.th) * k,
    ph: L(a.ph, b.ph),
    r: Math.exp(L(Math.log(ra), Math.log(rb))),
    tgt: [L(a.tgt[0], b.tgt[0]), L(a.tgt[1], b.tgt[1]), L(a.tgt[2], b.tgt[2])],
    fov: L(a.fov != null ? a.fov : 50, b.fov != null ? b.fov : 50),
  };
}

/** Area-weighted centroid of a polygon ([[x, y], ...]); the vertex mean if degenerate. */
export function polygonCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * A point INSIDE the polygon to aim at: the centroid when it is inside (any
 * convex room), else the midpoint of the widest interior run of a horizontal
 * or vertical line through the polygon, the one nearest the centroid. An
 * L-shaped room's centroid can sit in the notch, outside the room; aiming
 * there would frame a corner of the neighbour.
 */
export function interiorPoint(poly) {
  const c = polygonCentroid(poly);
  if (insidePoly(poly, c[0], c[1])) return c;
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const cands = [];
  // Interior runs of the line {axis = v}: crossings sorted, paired.
  const runs = (axis, v) => {
    const hits = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[j], b = poly[i];
      const av = axis === 'y' ? a[1] : a[0], bv = axis === 'y' ? b[1] : b[0];
      if ((av <= v && bv > v) || (bv <= v && av > v)) {
        const t = (v - av) / (bv - av);
        hits.push(axis === 'y' ? a[0] + (b[0] - a[0]) * t : a[1] + (b[1] - a[1]) * t);
      }
    }
    hits.sort((p, q) => p - q);
    for (let k = 0; k + 1 < hits.length; k += 2) {
      const mid = (hits[k] + hits[k + 1]) / 2, len = hits[k + 1] - hits[k];
      cands.push({ p: axis === 'y' ? [mid, v] : [v, mid], len });
    }
  };
  [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875].forEach(f => {
    runs('y', minY + (maxY - minY) * f);
    runs('x', minX + (maxX - minX) * f);
  });
  runs('y', c[1]); runs('x', c[0]);
  const ok = cands.filter(k => k.len > 0 && insidePoly(poly, k.p[0], k.p[1]));
  if (!ok.length) return c;
  // Prefer a long run (a real part of the room, not a sliver), then nearness.
  const longest = Math.max(...ok.map(k => k.len));
  const good = ok.filter(k => k.len >= longest * 0.5);
  good.sort((a, b) => Math.hypot(a.p[0] - c[0], a.p[1] - c[1]) - Math.hypot(b.p[0] - c[0], b.p[1] - c[1]));
  return good[0].p;
}

/** Unit vector from the target toward the camera for (th, ph). */
export function backVector(th, ph) {
  return [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
}

/** The camera's right and up vectors for (th, ph) (world up is +Y). */
export function cameraBasis(th, ph) {
  const b = backVector(th, ph);
  const f = [-b[0], -b[1], -b[2]];
  // right = forward x up(0,1,0) = (-f.z, 0, f.x), normalised.
  let rx = -f[2], rz = f[0];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  const right = [rx, 0, rz];
  // up = right x forward
  const up = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
  return { back: b, right, up };
}

/**
 * The smallest orbit distance at which every point (world [x, y, z]) is on
 * screen, looking at `tgt` from (th, ph), with a vertical FOV of `fovDeg`
 * and the given aspect (width / height). `margin` > 1 leaves a border.
 * For a point q (relative to the target) the camera-space depth is
 * r - q.back, so it fits horizontally when |q.right| <= (r - q.back) tanH / margin.
 */
export function fitDistance(points, tgt, th, ph, fovDeg, aspect, margin) {
  const m = margin || 1;
  const tanV = Math.tan((fovDeg * Math.PI / 180) / 2);
  const tanH = tanV * (aspect > 0 ? aspect : 1);
  const { back, right, up } = cameraBasis(th, ph);
  let r = 0;
  points.forEach(p => {
    const q = [p[0] - tgt[0], p[1] - tgt[1], p[2] - tgt[2]];
    const qb = q[0] * back[0] + q[1] * back[1] + q[2] * back[2];
    const qr = q[0] * right[0] + q[1] * right[1] + q[2] * right[2];
    const qu = q[0] * up[0] + q[1] * up[1] + q[2] * up[2];
    r = Math.max(r, qb + Math.abs(qr) * m / tanH, qb + Math.abs(qu) * m / tanV);
  });
  return r;
}

/** Room view tuning. */
export const ROOM_VIEW = Object.freeze({ margin: 1.12, minR: 3, fov: 50 });
/** Device view tuning (plan section 2). */
export const ITEM_VIEW = Object.freeze({ minR: 1.2, diagFactor: 2.2, ph: Math.PI * 0.38, fov: 50 });

/**
 * The showcase view of a room, derived from its floor polygon.
 *
 * The ANGLE is fixed -- the house's own home azimuth and polar (`th`, `ph`),
 * NOT wherever the camera happens to point -- so each room has one view that
 * is the same every time it is tapped. The target is a point inside the
 * polygon at floor level; the distance is the smallest that keeps the whole
 * polygon on screen (fitDistance), at least `minR`.
 *
 * @param o.poly     the room polygon, plan cm
 * @param o.toWorld  (x, y) plan cm -> [X, Z] world metres
 * @param o.th, o.ph the fixed showcase angle
 * @param o.fov      vertical FOV, degrees
 * @param o.aspect   the visible canvas width / height
 * @param o.inset    { right: px, width: px, height: px } -- a panel covering
 *                   the right of the canvas; the room is framed in what is
 *                   left and the target shifted so it sits in the middle of it
 * @param o.maxR     upper clamp (the house's own framing distance)
 */
export function deriveRoomView(o) {
  const fov = o.fov || ROOM_VIEW.fov;
  const ip = interiorPoint(o.poly);
  const w = o.toWorld(ip[0], ip[1]);
  let tgt = [w[0], 0, w[1]];
  const pts = o.poly.map(p => { const q = o.toWorld(p[0], p[1]); return [q[0], 0, q[1]]; });
  const inset = o.inset && o.inset.right > 0 && o.inset.width > o.inset.right ? o.inset : null;
  const aspect = inset ? (inset.width - inset.right) / inset.height : (o.aspect || 1);
  let r = Math.max(o.minR != null ? o.minR : ROOM_VIEW.minR, fitDistance(pts, tgt, o.th, o.ph, fov, aspect, o.margin || ROOM_VIEW.margin));
  if (o.maxR > 0) r = Math.min(r, o.maxR);
  if (inset) {
    // Content shifts left by half the covered width: move the target (and so
    // the camera) right by that many pixels' worth of world at the target.
    const worldPerPx = 2 * r * Math.tan((fov * Math.PI / 180) / 2) / inset.height;
    const { right } = cameraBasis(o.th, o.ph);
    const s = (inset.right / 2) * worldPerPx;
    tgt = [tgt[0] + right[0] * s, tgt[1], tgt[2] + right[2] * s];
  }
  return { th: o.th, ph: o.ph, r, tgt, fov };
}

/**
 * The close-up view of a device.
 * @param o.box    { min: [x,y,z], max: [x,y,z] } world metres, or null
 * @param o.point  [x, y, z] the fallback target (the tapped point / fixture)
 * @param o.front  [fx, fz] the horizontal direction the item faces, or null
 * @param o.th     the azimuth to use when there is no front (the current one)
 * @param o.ph     polar (default ITEM_VIEW.ph)
 */
export function deriveItemView(o) {
  const box = o.box;
  let tgt, diag = 0;
  if (box) {
    tgt = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    diag = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  } else {
    tgt = [o.point[0], o.point[1], o.point[2]];
  }
  const r = Math.max(o.minR != null ? o.minR : ITEM_VIEW.minR, diag * ITEM_VIEW.diagFactor);
  const th = o.front && (o.front[0] || o.front[1]) ? Math.atan2(o.front[1], o.front[0]) : o.th;
  return { th, ph: o.ph != null ? o.ph : ITEM_VIEW.ph, r, tgt, fov: o.fov || ITEM_VIEW.fov };
}

/** The plan-space front of an item rotated `deg` clockwise (docs/house-profile.md): (-sin r, cos r). */
export function frontFromRotation(deg) {
  const r = (deg || 0) * Math.PI / 180;
  return [-Math.sin(r), Math.cos(r)];
}

/**
 * A profile `view` (geometry schemaVersion 1.4, $defs/focusView) compiled to
 * a pose: plan-cm target and cm targetHeight to world metres. `target` is
 * optional; a view without one keeps a null tgt for the caller to fill with
 * the derived target. Returns null for anything malformed.
 */
export function compileFocusView(view, tx, tz) {
  if (!view || typeof view !== 'object') return null;
  const num = v => typeof v === 'number' && isFinite(v);
  if (!num(view.azimuth) || !num(view.polar) || !num(view.distance) || view.distance <= 0) return null;
  const h = num(view.targetHeight) ? view.targetHeight / 100 : 0;
  const t = Array.isArray(view.target) && view.target.length === 2 && num(view.target[0]) && num(view.target[1])
    ? [tx(view.target[0]), h, tz(view.target[1])] : null;
  return { th: view.azimuth, ph: view.polar, r: view.distance, tgt: t, targetHeight: h, fov: num(view.fov) ? view.fov : 50 };
}

/** A stable key for a device target. */
export function deviceKey(d) {
  return d ? String(d.kind) + ':' + String(d.id) : '';
}

/** The key of what the camera should frame for a selection: device beats room beats home. */
export function focusKey(sel) {
  const s = sel || {};
  if (s.device) return 'd:' + deviceKey(s.device);
  if (s.room) return 'r:' + s.room;
  return '';
}

export const FOCUS_INITIAL = Object.freeze({ room: null, device: null, home: null });

/**
 * The selection reducer.
 *
 * @param state        { room, device, home } -- home the captured pose or null
 * @param next         { room, device } -- the selection now
 * @param mode         'explicit' | 'gesture'
 * @param pose         the camera's current pose (captured as home on the way
 *                     out of "nothing selected")
 * @param resolveView  (sel) => pose | null -- the view for a selection
 * @returns { state, fly } -- fly is the pose to fly to, or null
 */
export function focusReduce(state, next, mode, pose, resolveView) {
  const s = state || FOCUS_INITIAL;
  const n = { room: (next && next.room) || null, device: (next && next.device) || null };
  const prevKey = focusKey(s), nextKey = focusKey(n);
  if (prevKey === nextKey) return { state: { room: n.room, device: n.device, home: s.home }, fly: null };
  if (mode === 'gesture') {
    // The user is driving the camera: never fly. Nothing left selected ->
    // forget home; something still selected keeps it (a manual orbit while
    // focused never changes home).
    return { state: { room: n.room, device: n.device, home: nextKey ? s.home : null }, fly: null };
  }
  if (!nextKey) {
    return { state: { room: null, device: null, home: null }, fly: s.home ? clonePose(s.home) : null };
  }
  const home = s.home || (pose ? clonePose(pose) : null);
  const view = resolveView ? resolveView(n) : null;
  return { state: { room: n.room, device: n.device, home }, fly: view || null };
}

export function clonePose(p) {
  return { th: p.th, ph: p.ph, r: p.r, tgt: [p.tgt[0], p.tgt[1], p.tgt[2]], fov: p.fov != null ? p.fov : 50 };
}

/**
 * The controller: batches selection changes so that everything one user
 * action does lands as ONE decision. Tapping a room while a card is open
 * closes the card (device -> null) and selects the room in the same
 * gesture; reduced separately those would be a return flight and then a
 * room flight, and the home pose would be captured mid-flight. Batched they
 * are one room flight.
 *
 * A batch is open while a pointer is down (hold()), and is decided when it
 * is released (release(mode)) -- by then the page knows whether the pointer
 * was a tap (explicit) or a drag (gesture). Outside a hold, a request is
 * decided on the next task (`schedule`), so a burst of synchronous changes
 * (a keyboard Escape, a sidebar Back) still merges.
 *
 * @param o.getPose      () => the camera's current pose
 * @param o.fly          (pose) => Promise -- start a flight (the scene's flyTo)
 * @param o.resolveView  (sel) => pose | null
 * @param o.schedule     (fn) => void -- defer to the next task (default setTimeout 0)
 */
export function createFocusController(o) {
  let state = FOCUS_INITIAL;
  let pending = null;        // the selection the batch is heading to
  let gesture = false;       // any gesture in this batch -> the batch is a gesture
  let held = 0;
  let scheduled = false;
  let flights = 0;
  let returning = null;      // the home pose a return flight is heading to
  const schedule = o.schedule || (fn => setTimeout(fn, 0));

  function sel() { return pending || { room: state.room, device: state.device }; }
  function flush() {
    scheduled = false;
    if (!pending) return Promise.resolve(null);
    const next = pending, mode = gesture ? 'gesture' : 'explicit';
    pending = null; gesture = false;
    // While the camera is still flying HOME, "where the camera was before
    // the selection" is that home, not wherever the return flight has got
    // to: a quick re-selection must not capture a mid-flight pose.
    const pose = returning || (o.getPose ? o.getPose() : null);
    const res = focusReduce(state, next, mode, pose, o.resolveView);
    const goingHome = !!res.fly && !focusKey(res.state);
    state = res.state;
    if (res.fly && !goingHome) returning = null;
    if (!res.fly) return Promise.resolve(null);
    flights++;
    const p = Promise.resolve(o.fly(res.fly));
    if (goingHome) {
      const mine = returning = res.fly;
      // Landed: the camera IS home. Cancelled (the next tap's pointer down
      // stops it): keep it -- that tap's selection must still capture the
      // home the camera was heading to. A drag or wheel forgets it
      // (markGesture): then the user put the camera where it is.
      p.then(st => { if (returning === mine && st !== 'cancelled') returning = null; }, () => { if (returning === mine) returning = null; });
    }
    return p;
  }
  const api = {
    /** Change the selection (a partial { room?, device? }). */
    request(partial, mode) {
      const cur = sel();
      pending = Object.assign({}, cur, partial || {});
      if (mode === 'gesture') gesture = true;
      if (!held && !scheduled) { scheduled = true; schedule(() => { if (scheduled) flush(); }); }
    },
    /** The user is driving the camera (a drag, wheel or pinch): the open
     *  batch, if any, is a gesture, and a cancelled return flight's home is
     *  forgotten. */
    markGesture() { returning = null; if (pending || held) gesture = true; },
    /** Decide the batch now; resolves to the flight's result (or null). */
    flushNow() { return flush(); },
    hold() { held++; },
    release(mode) {
      if (held > 0) held--;
      if (mode === 'gesture') gesture = gesture || !!pending;
      if (!held) return flush();
      return Promise.resolve(null);
    },
    /** What the batch is heading to (or the committed selection). */
    selection: () => sel(),
    state: () => state,
    /** Forget everything (the feature was switched off). */
    reset() { state = FOCUS_INITIAL; pending = null; gesture = false; scheduled = false; held = 0; returning = null; },
    flights: () => flights,
  };
  return api;
}

/**
 * Generation gate for the device tap: tap -> fly -> open the card. Every new
 * tap (and anything that supersedes one: a pointer down elsewhere, Escape)
 * begins a new generation, and a stale await must never open a card for an
 * earlier target.
 */
export function createFocusGate() {
  let gen = 0;
  return {
    begin() { return ++gen; },
    invalidate() { gen++; },
    current(token) { return token === gen; },
    gen: () => gen,
  };
}

/**
 * Fly to a device, then open its card -- unless a newer tap (or anything
 * that invalidated the gate) arrived meanwhile.
 * @param gate     createFocusGate()
 * @param focus    () => Promise (resolves when the flight lands / is cancelled)
 * @param open     () => void, called only if still current
 * @param abandon  () => void, called when superseded (so the page can drop
 *                 the device it selected for this tap)
 * @returns Promise<boolean> -- true when the card opened
 */
export async function focusThenOpen(gate, focus, open, abandon) {
  const token = gate.begin();
  try { await focus(); } catch (e) { /* a failed flight still opens the card */ }
  if (!gate.current(token)) { if (abandon) abandon(); return false; }
  open();
  return true;
}
