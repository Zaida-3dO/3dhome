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
 * @param o.height   the room's ceiling height (metres): the fit covers the
 *                   floor-to-ceiling volume. 0 / absent: the floor only.
 */
export function deriveRoomView(o) {
  const fov = o.fov || ROOM_VIEW.fov;
  const ip = interiorPoint(o.poly);
  const w = o.toWorld(ip[0], ip[1]);
  // The room's VOLUME, floor to ceiling, so its ceiling lights are in frame
  // (and tappable) too; the target sits at mid-height to centre it.
  const hgt = o.height > 0 ? o.height : 0;
  let tgt = [w[0], hgt / 2, w[1]];
  const pts = [];
  o.poly.forEach(p => { const q = o.toWorld(p[0], p[1]); pts.push([q[0], 0, q[1]]); if (hgt) pts.push([q[0], hgt, q[1]]); });
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

/**
 * OCCLUSION-AWARE DEVICE FRAMING.
 *
 * A device view must show the WHOLE item, as close as that allows, from an
 * angle where nothing stands between the camera and the item (a shelf in
 * front of a plant). So, per tap (never per frame):
 *   1. candidate directions around the item's preferred one -- azimuth
 *      offsets of 0, +-20, +-40, +-60, +-90 deg, each at the default polar
 *      and at steeper ones up to near top-down -- sorted by how far they
 *      stray from the preferred view (a small penalty, always < 1 ray);
 *   2. for each, the distance that fits the item's whole box in the frustum
 *      (both FOV axes, the canvas beside the sidebar), with a margin;
 *   3. a score: the number of sample rays (box centre, top centre, eight
 *      shrunken corners) from the camera to the item that something else
 *      blocks, plus the penalty. A candidate the caller disallows (a camera
 *      outside the item's room below wall height, i.e. behind a wall) is
 *      skipped.
 * The first candidate with NO blocked ray is the answer (they are tried in
 * penalty order, so it is also the best score); otherwise the lowest score.
 * The caller supplies the ray test, so this stays pure and testable.
 */
export const OCCLUSION_VIEW = Object.freeze({
  azOffsetsDeg: [0, 20, -20, 40, -40, 60, -60, 90, -90],
  margin: 1.25, minR: 0.8, maxR: 14,
  topPolar: Math.PI * 0.1,
  azPenalty: 0.3,      // at a 90 deg offset
  polarPenalty: 0.25,  // at near top-down
});

/** The eight corners of a box { min, max }. */
export function boxCorners(box) {
  const out = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) out.push([x, y, z]);
  return out;
}

/** Ray targets on a box: its centre, its top centre and its corners pulled 15% toward the centre. */
export function boxSamples(box) {
  const c = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const pts = [c, [c[0], box.max[1] - (box.max[1] - box.min[1]) * 0.1, c[2]]];
  boxCorners(box).forEach(p => pts.push([p[0] + (c[0] - p[0]) * 0.15, p[1] + (c[1] - p[1]) * 0.15, p[2] + (c[2] - p[2]) * 0.15]));
  return pts;
}

/**
 * Does the segment p -> q cross the axis-aligned box { min, max }? (Slab
 * method.) Furniture occludes as its world box: conservative, and a box test
 * costs nothing next to raycasting a merged furniture mesh's triangles.
 */
export function segmentHitsBox(p, q, b) {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = q[k] - p[k];
    if (Math.abs(d) < 1e-12) { if (p[k] < b.min[k] || p[k] > b.max[k]) return false; continue; }
    let a = (b.min[k] - p[k]) / d, c = (b.max[k] - p[k]) / d;
    if (a > c) { const x = a; a = c; c = x; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return false;
  }
  return true;
}

/** Candidate (th, ph) around a preferred one, sorted by penalty (ascending). */
export function deviceCandidates(baseTh, basePh, opts) {
  const o = Object.assign({}, OCCLUSION_VIEW, opts || {});
  const top = Math.min(o.topPolar, basePh);
  const polars = [basePh];
  [0.66, 0.33, 0].forEach(f => { const ph = top + (basePh - top) * f; if (polars.every(q => Math.abs(q - ph) > 1e-3)) polars.push(ph); });
  const out = [];
  o.azOffsetsDeg.forEach(d => polars.forEach(ph => {
    const az = Math.abs(d) / 90;
    const pol = basePh > top ? (basePh - ph) / (basePh - top) : 0;
    out.push({ th: baseTh + d * Math.PI / 180, ph, penalty: o.azPenalty * az + o.polarPenalty * pol });
  }));
  out.sort((a, b) => a.penalty - b.penalty);
  return out;
}

/**
 * Choose the device view.
 * @param o.box       { min, max } world metres -- the item
 * @param o.baseTh    preferred azimuth (the item's front, or the current one)
 * @param o.basePh    preferred polar
 * @param o.fov       vertical FOV, degrees
 * @param o.aspect    canvas width / height
 * @param o.inset     { right, width, height } -- a covering sidebar, or null
 * @param o.occluded  (eye, samples, limit) => number of sample rays blocked
 *                    (may stop counting at `limit`)
 * @param o.allowed   (eye) => bool -- false for a camera behind a wall
 * @returns { pose, occluded, penalty, tried }
 */
export function chooseItemView(o) {
  const opt = Object.assign({}, OCCLUSION_VIEW, o.options || {});
  const box = o.box;
  const centre = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const corners = boxCorners(box), samples = boxSamples(box);
  const fov = o.fov || 50;
  const inset = o.inset && o.inset.right > 0 && o.inset.width > o.inset.right ? o.inset : null;
  const aspect = inset ? (inset.width - inset.right) / inset.height : (o.aspect || 1);
  let best = null, tried = 0, first = null;
  for (const c of deviceCandidates(o.baseTh, o.basePh, opt)) {
    let r = fitDistance(corners, centre, c.th, c.ph, fov, aspect, opt.margin);
    r = Math.min(opt.maxR, Math.max(o.minR != null ? o.minR : opt.minR, r));
    let tgt = centre;
    if (inset) {
      const s = (inset.right / 2) * (2 * r * Math.tan((fov * Math.PI / 180) / 2) / inset.height);
      const { right } = cameraBasis(c.th, c.ph);
      tgt = [centre[0] + right[0] * s, centre[1], centre[2] + right[2] * s];
    }
    const b = backVector(c.th, c.ph);
    const eye = [tgt[0] + b[0] * r, tgt[1] + b[1] * r, tgt[2] + b[2] * r];
    const pose = { th: c.th, ph: c.ph, r, tgt, fov };
    if (!first) first = pose;
    if (o.allowed && !o.allowed(eye)) continue;
    tried++;
    // Only a count that could still beat the best is worth finishing.
    const limit = best ? Math.ceil(best.occluded + best.penalty - c.penalty) : samples.length;
    const occ = o.occluded ? o.occluded(eye, samples, limit) : 0;
    const score = occ + c.penalty;
    if (!best || score < best.occluded + best.penalty) best = { pose, occluded: occ, penalty: c.penalty };
    if (occ === 0) break;   // penalty order: nothing later can score lower
  }
  if (!best) return { pose: first, occluded: null, penalty: 0, tried };
  return { pose: best.pose, occluded: best.occluded, penalty: best.penalty, tried };
}

/**
 * IN-ROOM ROOM VIEWS -- the estate agent's corner photo.
 *
 * A room with no authored `view` is framed from INSIDE it: a camera standing
 * in a corner (or along a wall), below the ceiling, pitched down, looking
 * across the room with a wide lens -- the angle that shows the most of the
 * room. "The most of the room" is COVERAGE: the room's floor (a grid of
 * samples over its polygon) plus its furniture (samples on each item's box,
 * weighted by how big the item reads) plus its ceiling fixtures, counted as
 * the fraction that is inside the frustum AND unoccluded. Floor and furniture
 * count together, each by its area.
 *
 * Per room, once (the scene caches it), never per frame:
 *   1. Vantage points: every convex corner, inset `inset` from both walls,
 *      and points along each wall, inset from it; each at a couple of eye
 *      heights, never closer than `ceilingGap` to the ceiling; strictly
 *      inside the polygon and never inside (or touching) a furniture box.
 *   2. Visibility per (eye, sample) -- it does not depend on where the camera
 *      points: a sample is blocked when the eye->sample segment leaves the
 *      room polygon (an L-shaped room's own notch walls), crosses another of
 *      the room's furniture boxes, or -- for the best few eyes only, since it
 *      is the expensive part -- the caller's ray test says a solid mesh is in
 *      the way. From inside a room every wall renders solid, so a wall always
 *      blocks.
 *   3. Orientations per eye: yaws aimed at the furniture-weighted centroid,
 *      the room's interior point and the farthest corner, each with small
 *      offsets, times a range of downward pitches. Scored by frustum tests
 *      alone (cheap), so trying many costs nothing.
 *   4. Score = coverage + mild preferences: a corner vantage, floor corners
 *      in frame, a long view (not a blank wall), standing near a doorway, a
 *      photographer's tilt (about 22 degrees down); minus wall-blocked
 *      samples and furniture right in front of the lens.
 * If even the best in-room view covers less than `minCoverage` (a cupboard
 * a camera cannot stand in), the result says so and the caller falls back to
 * the above-the-walls view (deriveRoomView).
 *
 * World coordinates throughout: polygons are [[x, z], ...] in metres, boxes
 * { min: [x,y,z], max: [x,y,z] }.
 */
export const IN_ROOM_VIEW = Object.freeze({
  inset: 0.4,               // from each wall (the polygon is the walls' inner face)
  heights: [2.0, 2.25],     // eye heights (m), capped by the ceiling
  ceilingGap: 0.22,         // the eye stays at least this far below the ceiling
  minHeight: 1.5,
  fov: 70,                  // vertical, degrees: a wide lens
  minHFov: 70,              // the visible window is at least this wide (portrait)
  maxFov: 86,
  // Downward tilts tried. Capped low enough that the ceiling and its
  // fixtures stay in the top of the frame -- a steeper tilt shows more floor
  // but loses the downlights, which are what the room's controls drive.
  pitchesDeg: [14, 18, 22, 26, 30],
  pitchPref: 22,            // degrees down: the photographer's tilt
  pitchPenalty: 0.1,        // per 20 degrees away from pitchPref
  yawOffsetsDeg: [-24, -16, -8, 0, 8, 16, 24],
  floorSamples: 32,
  floorMargin: 0.15,        // floor samples keep this far off the walls
  floorY: 0.05,
  eyePad: 0.2,              // the eye keeps this far out of every furniture box
  refine: 5,                // eyes that get the expensive ray test
  minCoverage: 0.2,         // below this, fall back to the view from above
  frustumMargin: 0.96,
  cornerBonus: 0.03,
  cornersSeenBonus: 0.04,   // all floor corners in frame
  depthBonus: 0.04,         // the optical axis runs the full room diagonal
  doorBonus: 0.025,
  doorReach: 2,             // m
  wallPenalty: 0.15,        // x the weighted fraction a wall hides
  nearPenalty: 0.04,        // per item within `near` of the lens, in frame
  near: 0.8,
  lightWeight: 0.25,        // each ceiling fixture: they are what the room's controls drive
  minR: 1.2, maxR: 8,
});

/** Signed area of a [[x, z]] polygon (positive counter-clockwise in x/z). */
export function polySignedArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

/** Distance from (x, z) to the polygon's boundary. */
export function distToPolyEdge(poly, x, z) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], az = poly[j][1], bx = poly[i][0], bz = poly[i][1];
    const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
    d = Math.min(d, Math.hypot(x - (ax + ex * t), z - (az + ez * t)));
  }
  return d;
}

/** Inward unit normal of edge j -> i (whatever the winding). */
function inwardNormal(poly, j, i) {
  const ax = poly[j][0], az = poly[j][1], bx = poly[i][0], bz = poly[i][1];
  const l = Math.hypot(bx - ax, bz - az) || 1;
  let nx = -(bz - az) / l, nz = (bx - ax) / l;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2, e = Math.min(0.02, l / 4);
  if (!insidePoly(poly, mx + nx * e, mz + nz * e)) { nx = -nx; nz = -nz; }
  return [nx, nz];
}

/**
 * Candidate eye positions (x, z) inside a room: each convex corner inset
 * from both of its walls (kind 'corner'), each reflex corner likewise (kind
 * 'edge' -- it is not a corner shot), and points along each wall inset from
 * it (kind 'edge'). Every one is strictly inside, at least ~`inset` off
 * every wall. A room too small for any gets its interior point (kind
 * 'centre') when that clears the walls by a third of the inset.
 */
export function roomVantages(poly, inset) {
  const n = poly.length, out = [];
  const ccw = polySignedArea(poly) > 0;
  const ok = (x, z) => insidePoly(poly, x, z) && distToPolyEdge(poly, x, z) >= inset * 0.85;
  for (let i = 0; i < n; i++) {
    const h = (i - 1 + n) % n, k = (i + 1) % n;
    const n1 = inwardNormal(poly, h, i), n2 = inwardNormal(poly, i, k);
    // Convex when the turn h -> i -> k agrees with the winding.
    const cross = (poly[i][0] - poly[h][0]) * (poly[k][1] - poly[i][1]) - (poly[i][1] - poly[h][1]) * (poly[k][0] - poly[i][0]);
    const convex = ccw ? cross > 0 : cross < 0;
    const x = poly[i][0] + (n1[0] + n2[0]) * inset, z = poly[i][1] + (n1[1] + n2[1]) * inset;
    if (ok(x, z)) out.push({ x, z, kind: convex ? 'corner' : 'edge', vertex: i });
  }
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j][0], az = poly[j][1], bx = poly[i][0], bz = poly[i][1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 2 * inset + 0.3) continue;
    const nn = inwardNormal(poly, j, i);
    const fr = len > 3 ? [0.25, 0.5, 0.75] : [0.5];
    fr.forEach(f => {
      const x = ax + (bx - ax) * f + nn[0] * inset, z = az + (bz - az) * f + nn[1] * inset;
      if (ok(x, z)) out.push({ x, z, kind: 'edge' });
    });
  }
  if (!out.length) {
    const c = interiorPoint(poly);
    if (insidePoly(poly, c[0], c[1]) && distToPolyEdge(poly, c[0], c[1]) >= inset / 3) out.push({ x: c[0], z: c[1], kind: 'centre' });
  }
  return out;
}

/** A grid of about `n` points over the polygon, each `margin` clear of the walls. */
export function floorGrid(poly, n, margin) {
  const area = Math.abs(polySignedArea(poly));
  if (!(area > 0)) return [];
  const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  let step = Math.sqrt(area / Math.max(1, n));
  let pts = [];
  for (let tries = 0; tries < 4; tries++) {
    pts = [];
    for (let x = minX + step / 2; x < maxX; x += step) for (let z = minZ + step / 2; z < maxZ; z += step) {
      if (insidePoly(poly, x, z) && distToPolyEdge(poly, x, z) >= Math.min(margin, step / 3)) pts.push([x, z]);
    }
    if (pts.length >= n * 0.6) break;
    step *= 0.8;
  }
  return pts;
}

/** Does segment p -> q (x/z) cross segment a -> b? Parameter on p -> q, or -1. */
function segCross(px, pz, qx, qz, ax, az, bx, bz) {
  const rx = qx - px, rz = qz - pz, sx = bx - ax, sz = bz - az;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return -1;
  const t = ((ax - px) * sz - (az - pz) * sx) / den;
  const u = ((ax - px) * rz - (az - pz) * rx) / den;
  return t > 1e-9 && t < 1 && u >= 0 && u <= 1 ? t : -1;
}

/**
 * Does the sight line eye -> point leave the room before it arrives? The
 * last `tail` metres are forgiven: a wall-mounted item sits on the boundary.
 */
export function leavesRoom(poly, eye, pt, tail) {
  const len = Math.hypot(pt[0] - eye[0], pt[2] - eye[2]);
  if (!(len > 1e-6)) return false;
  const lim = 1 - Math.min(0.5, (tail != null ? tail : 0.12) / len);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const t = segCross(eye[0], eye[2], pt[0], pt[2], poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
    if (t > 0 && t < lim) return true;
  }
  return false;
}

function inBox(b, p, pad) {
  const e = pad || 0;
  return p[0] >= b.min[0] - e && p[0] <= b.max[0] + e && p[1] >= b.min[1] - e && p[1] <= b.max[1] + e &&
    p[2] >= b.min[2] - e && p[2] <= b.max[2] + e;
}

/** How big an item reads: its footprint plus half its largest side, clamped. */
export function itemWeight(box) {
  const w = box.max[0] - box.min[0], h = box.max[1] - box.min[1], d = box.max[2] - box.min[2];
  return Math.max(0.05, Math.min(3, w * d + 0.5 * Math.max(w, d) * h));
}

/** Distance along (dx, dz) from (x, z) to the polygon's boundary (Infinity if none). */
function rayToBoundary(poly, x, z, dx, dz) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], az = poly[j][1], sx = poly[i][0] - ax, sz = poly[i][1] - az;
    const den = dx * sz - dz * sx;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - x) * sz - (az - z) * sx) / den, u = ((ax - x) * dz - (az - z) * dx) / den;
    if (t > 1e-6 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

/** Forward, right and up unit vectors for a camera at yaw `yaw` (x/z) pitched DOWN by `pitch`. */
export function lookBasis(yaw, pitch) {
  const cp = Math.cos(pitch);
  const f = [cp * Math.cos(yaw), -Math.sin(pitch), cp * Math.sin(yaw)];
  const r = [-Math.sin(yaw), 0, Math.cos(yaw)];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f, r, u };
}

/**
 * The orbit pose (th, ph, r, tgt) of a camera at `eye` looking along
 * (yaw, pitch); the orbit target sits `r` metres down the view.
 */
export function poseFromLook(eye, yaw, pitch, r, fov) {
  const { f } = lookBasis(yaw, pitch);
  const th = Math.atan2(-f[2], -f[0]);
  const ph = Math.acos(Math.max(-1, Math.min(1, -f[1])));
  return { th, ph, r, tgt: [eye[0] + f[0] * r, eye[1] + f[1] * r, eye[2] + f[2] * r], fov };
}

/**
 * Choose a room's in-room view.
 * @param o.poly      [[x, z]] world metres
 * @param o.ceiling   ceiling height (m)
 * @param o.items     [{ id, box }] the room's furniture (world boxes)
 * @param o.lights    [[x, y, z]] the room's fixtures
 * @param o.doors     [[x, z]] door centres on this room's walls
 * @param o.aspect    canvas width / height
 * @param o.inset     { right, width, height } a covering sidebar, or null
 * @param o.occluded  (eye, point) => bool -- a solid mesh between them (the
 *                    walls, doors, fittings); called for the best few eyes
 * @param o.options   overrides of IN_ROOM_VIEW
 * @returns { pose, eye, coverage, score, fallback, kind, tried, rays }
 *          pose null and fallback true when no vantage reaches minCoverage
 */
export function chooseInRoomView(o) {
  const opt = Object.assign({}, IN_ROOM_VIEW, o.options || {});
  const poly = o.poly, D2R = Math.PI / 180;
  const ceiling = o.ceiling > 0 ? o.ceiling : 2.5;
  const items = (o.items || []).filter(it => it && it.box);
  const area = Math.abs(polySignedArea(poly));

  // ---- Samples, grouped by what they belong to (each group a weight).
  const groups = [];
  const floor = floorGrid(poly, opt.floorSamples, opt.floorMargin).map(p => [p[0], opt.floorY, p[1]]);
  if (floor.length) groups.push({ kind: 'floor', weight: area, pts: floor });
  items.forEach((it, idx) => groups.push({ kind: 'item', id: it.id, idx, weight: itemWeight(it.box), pts: boxSamples(it.box) }));
  (o.lights || []).forEach(p => groups.push({ kind: 'light', weight: opt.lightWeight, pts: [p] }));
  const totalW = groups.reduce((s, g) => s + g.weight, 0) || 1;
  const flat = [];   // { p, g }
  groups.forEach((g, gi) => g.pts.forEach(p => flat.push({ p, g: gi })));
  const corners = poly.map(p => [p[0], 0.02, p[1]]);

  // ---- The lens: a vertical FOV wide enough that the visible window (the
  // canvas left of any covering sidebar) spans at least minHFov.
  const inset = o.inset && o.inset.right > 0 && o.inset.width > o.inset.right ? o.inset : null;
  const aspect = o.aspect > 0 ? o.aspect : 1;
  const frac = inset ? inset.right / inset.width : 0;
  let tanV = Math.tan(opt.fov * D2R / 2);
  tanV = Math.max(tanV, Math.tan(opt.minHFov * D2R / 2) / (aspect * (1 - frac)));
  tanV = Math.min(tanV, Math.tan(opt.maxFov * D2R / 2));
  const fov = 2 * Math.atan(tanV) / D2R;
  const tanH = tanV * aspect;
  const xMin = -tanH * opt.frustumMargin, xMax = tanH * (1 - 2 * frac) * opt.frustumMargin, yLim = tanV * opt.frustumMargin;
  const yawShift = Math.atan(frac * tanH);   // centre the VISIBLE window on the aim

  // ---- Aim points: the weighted centroid of everything, the room's interior point.
  let ax = 0, az = 0;
  groups.forEach(g => g.pts.forEach(p => { ax += p[0] * g.weight / g.pts.length; az += p[2] * g.weight / g.pts.length; }));
  ax /= totalW; az /= totalW;
  const ip = interiorPoint(poly);
  const aims = [[ax, az], ip];
  const diag = (() => { let m = 0; poly.forEach(a => poly.forEach(b => { m = Math.max(m, Math.hypot(a[0] - b[0], a[1] - b[1])); })); return m || 1; })();

  // ---- Eyes.
  const topEye = ceiling - opt.ceilingGap;
  const heights = [];
  opt.heights.forEach(h => { const y = Math.min(h, topEye); if (y >= Math.min(opt.minHeight, topEye) && heights.every(q => Math.abs(q - y) > 0.05)) heights.push(y); });
  const eyes = [];
  roomVantages(poly, opt.inset).forEach(v => heights.forEach(y => {
    const e = [v.x, y, v.z];
    if (items.some(it => inBox(it.box, e, opt.eyePad))) return;
    eyes.push({ e, kind: v.kind });
  }));

  // Cheap visibility (orientation-free): polygon walls and furniture boxes.
  let rays = 0;
  function visibility(eye) {
    const vis = new Uint8Array(flat.length), wall = new Uint8Array(flat.length);
    flat.forEach((s, k) => {
      if (leavesRoom(poly, eye, s.p)) { wall[k] = 1; return; }
      const g = groups[s.g];
      for (let b = 0; b < items.length; b++) {
        if (g.kind === 'item' && g.idx === b) continue;
        const bx = items[b].box;
        if (inBox(bx, s.p, 0.005) || inBox(bx, eye, 0)) continue;
        if (segmentHitsBox(eye, s.p, bx)) return;
      }
      vis[k] = 1;
    });
    const cornerVis = corners.map(c => !leavesRoom(poly, eye, c, 0.05));
    return { vis, wall, cornerVis };
  }
  const doorBonus = eye => {
    if (!o.doors || !o.doors.length) return 0;
    const d = Math.min(...o.doors.map(p => Math.hypot(p[0] - eye[0], p[1] - eye[2])));
    return opt.doorBonus * Math.max(0, 1 - d / opt.doorReach);
  };
  function scoreEye(ev) {
    const eye = ev.e, V = ev.V;
    const yaws = [];
    const far = poly.reduce((m, p) => { const d = Math.hypot(p[0] - eye[0], p[1] - eye[2]); return d > m.d ? { d, p } : m; }, { d: -1, p: null });
    aims.concat(far.p ? [far.p] : []).forEach(a => {
      const base = Math.atan2(a[1] - eye[2], a[0] - eye[0]) + yawShift;
      opt.yawOffsetsDeg.forEach(dd => yaws.push(base + dd * D2R));
    });
    // Everything orientation-free, once per eye: the eye-relative vector of
    // each sample that counts either way (seen, or hidden by a wall), and
    // what it is worth; the near items; the visible floor corners.
    const qs = [], ws = [];
    for (let k = 0; k < flat.length; k++) {
      if (!V.vis[k] && !V.wall[k]) continue;
      const p = flat[k].p, g = groups[flat[k].g];
      qs.push(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
      // Positive: coverage when in frame. Negative: a wall hides it.
      ws.push(V.vis[k] ? g.weight / g.pts.length / totalW : -opt.wallPenalty * g.weight / g.pts.length / totalW);
    }
    const nearQ = [];
    items.forEach(it => {
      const b = it.box;
      const dx = Math.max(b.min[0] - eye[0], 0, eye[0] - b.max[0]), dy = Math.max(b.min[1] - eye[1], 0, eye[1] - b.max[1]), dz = Math.max(b.min[2] - eye[2], 0, eye[2] - b.max[2]);
      if (Math.hypot(dx, dy, dz) < opt.near) nearQ.push((b.min[0] + b.max[0]) / 2 - eye[0], (b.min[1] + b.max[1]) / 2 - eye[1], (b.min[2] + b.max[2]) / 2 - eye[2]);
    });
    const cornerQ = [];
    corners.forEach((c, i) => { if (V.cornerVis[i]) cornerQ.push(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]); });
    let best = null;
    const fixed = (ev.kind === 'corner' ? opt.cornerBonus : 0) + doorBonus(eye);
    for (const yaw of yaws) for (const pd of opt.pitchesDeg) {
      const pitch = pd * D2R, B = lookBasis(yaw, pitch);
      const f0 = B.f[0], f1 = B.f[1], f2 = B.f[2], r0 = B.r[0], r2 = B.r[2], u0 = B.u[0], u1 = B.u[1], u2 = B.u[2];
      const inFrame = (Q, i) => {
        const qx = Q[i], qy = Q[i + 1], qz = Q[i + 2];
        const z = qx * f0 + qy * f1 + qz * f2;
        if (z < 0.15) return false;
        const x = (qx * r0 + qz * r2) / z, y = (qx * u0 + qy * u1 + qz * u2) / z;
        return x >= xMin && x <= xMax && y >= -yLim && y <= yLim;
      };
      let cov = 0, hid = 0;
      for (let i = 0, k = 0; i < qs.length; i += 3, k++) {
        if (!inFrame(qs, i)) continue;
        if (ws[k] > 0) cov += ws[k]; else hid -= ws[k];
      }
      let nearN = 0, cs = 0;
      for (let i = 0; i < nearQ.length; i += 3) if (inFrame(nearQ, i)) nearN++;
      for (let i = 0; i < cornerQ.length; i += 3) if (inFrame(cornerQ, i)) cs++;
      const depth = Math.min(1, rayToBoundary(poly, eye[0], eye[2], Math.cos(yaw - yawShift), Math.sin(yaw - yawShift)) / diag);
      const score = cov + fixed + opt.cornersSeenBonus * cs / corners.length + opt.depthBonus * depth - hid - opt.nearPenalty * nearN -
        opt.pitchPenalty * Math.abs(pd - opt.pitchPref) / 20;
      if (!best || score > best.score) best = { score, coverage: cov, yaw, pitch };
    }
    return best;
  }

  eyes.forEach(ev => { ev.V = visibility(ev.e); ev.best = scoreEye(ev); });
  // The expensive part, for the best few only: the scene's own meshes.
  const ranked = eyes.filter(ev => ev.best).sort((a, b) => b.best.score - a.best.score);
  const top = ranked.slice(0, Math.max(1, opt.refine));
  if (o.occluded) top.forEach(ev => {
    flat.forEach((s, k) => {
      if (!ev.V.vis[k]) return;
      rays++;
      if (o.occluded(ev.e, s.p)) { ev.V.vis[k] = 0; ev.V.wall[k] = 1; }
    });
    ev.best = scoreEye(ev);
  });
  top.sort((a, b) => b.best.score - a.best.score);
  const win = top[0];
  if (!win || win.best.coverage < opt.minCoverage) {
    return { pose: null, eye: win ? win.e : null, coverage: win ? win.best.coverage : 0, score: win ? win.best.score : 0,
      fallback: true, kind: win ? win.kind : null, tried: eyes.length, rays };
  }
  const eye = win.e, { yaw, pitch } = win.best;
  // Orbit distance: to the aim along the view, kept above the floor.
  const dAim = Math.hypot(ax - eye[0], az - eye[2]);
  let r = dAim / Math.max(0.2, Math.cos(pitch));
  r = Math.min(r, (eye[1] - 0.25) / Math.max(0.05, Math.sin(pitch)));
  r = Math.max(opt.minR, Math.min(opt.maxR, r));
  return { pose: poseFromLook(eye, yaw, pitch, r, fov), eye, coverage: win.best.coverage, score: win.best.score,
    fallback: false, kind: win.kind, tried: eyes.length, rays };
}

/**
 * CAMERA FLIGHTS INTO AND OUT OF ROOMS.
 *
 * An orbit-space lerp (lerpPose) is right between two views from above, but
 * a camera flying into a room by it slides through walls on the way. So:
 *   'orbit'  neither end is inside a room: lerpPose, as before;
 *   'eye'    both ends are inside the SAME room and the straight line between
 *            them stays in it: the eye moves in a straight line;
 *   'arc'    otherwise: the eye rises straight up to `clearY` (above the
 *            walls), glides across, and drops straight down into the room.
 *            Parameterised by path length so the speed is continuous; the
 *            view direction, orbit distance and lens interpolate across the
 *            whole flight, so the camera turns smoothly and never spins.
 * Returns at(t) -> pose for an (already eased) t in [0, 1].
 */
export function eyeOf(p) {
  const b = backVector(p.th, p.ph);
  return [p.tgt[0] + b[0] * p.r, p.tgt[1] + b[1] * p.r, p.tgt[2] + b[2] * p.r];
}

export function planFlight(from, to, o) {
  const mode = (o && o.mode) || 'orbit';
  if (mode === 'orbit') return { mode, at: t => lerpPose(from, to, t), path: null };
  const A = eyeOf(from), B = eyeOf(to);
  const fa = from.fov != null ? from.fov : 50, fb = to.fov != null ? to.fov : 50;
  let pts;
  if (mode === 'eye') pts = [A, B];
  else {
    const cy = o.clearY;
    pts = [A, [A[0], Math.max(cy, A[1]), A[2]], [B[0], Math.max(cy, B[1]), B[2]], B];
  }
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]); segs.push(l); total += l; }
  const eyeAt = t => {
    if (!(total > 1e-9)) return A.slice();
    let d = Math.max(0, Math.min(1, t)) * total;
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i] || i === segs.length - 1) {
        const k = segs[i] > 0 ? Math.min(1, d / segs[i]) : 1, p = pts[i], q = pts[i + 1];
        return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
      }
      d -= segs[i];
    }
    return B.slice();
  };
  // The VIEW DIRECTION turns from the start's to the end's (azimuth by the
  // shortest arc, polar linearly) while the eye follows the path, and the
  // orbit target rides `r` ahead of it. Aiming at an interpolated look-at
  // point instead spins the camera when the eye passes over it.
  const ra = Math.max(1e-6, from.r), rb = Math.max(1e-6, to.r);
  const dTh = shortestArc(from.th, to.th);
  const at = t => {
    const k = Math.max(0, Math.min(1, t));
    if (k >= 1) return clonePose(to);
    if (k <= 0) return clonePose(from);
    const e = eyeAt(k);
    const th = from.th + dTh * k, ph = from.ph + (to.ph - from.ph) * k;
    const r = Math.exp(Math.log(ra) + (Math.log(rb) - Math.log(ra)) * k);
    const b = backVector(th, ph);
    return { th, ph, r, tgt: [e[0] - b[0] * r, e[1] - b[1] * r, e[2] - b[2] * r], fov: fa + (fb - fa) * k };
  };
  return { mode, at, path: pts, eyeAt };
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
    // A batch that closes with nothing to decide (a drag that changed no
    // selection) must not leave its gesture flag for the next batch: that
    // turned the next tap into a "gesture" -- no flight, home lost.
    if (!pending) { gesture = false; return Promise.resolve(null); }
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
      if (!held && !scheduled) { scheduled = true; schedule(() => { if (scheduled && !held) flush(); }); }
    },
    /** The user is driving the camera (a drag, wheel or pinch): the open
     *  batch, if any, is a gesture, and a cancelled return flight's home is
     *  forgotten. */
    markGesture() { returning = null; if (pending || held) gesture = true; },
    /** Decide the batch now; resolves to the flight's result (or null). */
    flushNow() { return flush(); },
    hold() {
      // A new pointer opens a fresh batch: a stale gesture flag with nothing
      // pending is dropped. Anything already pending joins this batch (its
      // scheduled flush defers to the release).
      if (held === 0 && !pending) gesture = false;
      held++;
    },
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
