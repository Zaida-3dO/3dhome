/**
 * bathroom.js - bathroom fittings. A MULTI-TYPE module:
 *
 *   bathtub          a straight built-in bath: flat outer panel, rolled deck,
 *                    a deep rounded inner basin and a chrome waste
 *   toilet           a back-to-wall WC: a lofted pan, a square soft-close seat
 *                    and lid, and (optionally) the concealed cistern's flush
 *                    plate on the wall behind it
 *   vanity-counter   a boxed counter (a duct / vanity unit) with a countertop,
 *                    an optional semi-recessed basin let into a notch in the
 *                    countertop, and a square mono mixer
 *   shower-set       a thermostatic bar valve, a riser rail with a handset and
 *                    hose, and an optional wall bath spout
 *   shower-screen    framed glazing in one plane: a bath screen (hinge jamb +
 *                    top rail) or a fixed pane and a hinged door with a mullion
 *   shower-tray      a low rounded tray with a waste
 *   towel-rail       a chrome ladder towel rail
 *
 * A mirror cabinet is NOT here: it is the `cabinet` type with mirror fronts
 * and no plinth (see BathroomFittingsSpec's preset).
 *
 * Builder contract: see box.js and docs/house-profile.md ("Furniture"). Pure
 * ESM, THREE injected, local frame in METRES with y = 0 at the bottom, x
 * centred along the width, the BACK at z = 0 and the front facing +z. Every
 * material comes from makeFinish(): ceramic is `gloss`, chrome a light-grey `gloss` (see CHROME_FINISH), glass
 * `glass` (kept, one draw). Nothing here adds a light or a texture.
 *
 * CURVED CERAMIC. The bath, WC pan, seat, lid, basin and tray are LOFTS: a
 * stack of rounded-rectangle rings (each with its own width, depth, height and
 * back/front corner radii) stitched into one smooth-shaded skin. Walking the
 * rings up the outer wall, over a rolled rim and down into the bowl gives one
 * continuous surface with no boxes. The skins are single-sided (FrontSide):
 * the ring order is wound so the outer wall faces out and the bowl faces in
 * and up, and scripts/test-furniture-bathroom.mjs pins that. `detail: 'low'`
 * uses 2 segments per rounded corner instead of 5 and drops rings.
 *
 * ENVELOPES. Each type's width / depth / height is its bounding box (the
 * contract). Where a type's box follows from other params, a helper computes
 * it: vanityEnvelope() (the tap rises to `height`, the basin reaches `depth`),
 * and showerSetEnvelope(), whose width/depth/height are OUTPUTS -- a shower
 * set is authored by floor heights (valveHeight, riserFrom, ...) and the
 * helper says how big it came out and at what `elevation` to hang it.
 */
import { makeFinish, isKeptFinish } from './finishes.js';
import { select, unsupported } from './controls.js';

const CM = 0.01;

function deepFreeze(o) {
  Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
}

function resolve(defaults, params) {
  const p = Object.assign({}, defaults);
  if (params) Object.keys(params).forEach(k => { if (params[k] !== undefined) p[k] = params[k]; });
  return p;
}

const isLow = opts => !!opts && opts.detail === 'low';

// ---- materials and parts -------------------------------------------------------

function fin(THREE, finish, color) {
  const m = makeFinish(THREE, finish, color);
  if (isKeptFinish(m.userData.finish)) m.userData.keep = true;
  return m;
}

function part(THREE, parent, geo, mat, name) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  if (mat.userData.keep) m.userData.keep = true;
  parent.add(m);
  return m;
}

function boxPart(THREE, parent, w, h, d, x, y, z, mat, name) {
  const m = part(THREE, parent, new THREE.BoxGeometry(Math.max(1e-4, w), Math.max(1e-4, h), Math.max(1e-4, d)), mat, name);
  m.position.set(x, y, z);
  return m;
}

function cylPart(THREE, parent, rTop, rBot, h, segs, mat, name) {
  return part(THREE, parent, new THREE.CylinderGeometry(rTop, rBot, Math.max(1e-4, h), segs), mat, name);
}

const alongX = m => { m.rotation.z = Math.PI / 2; return m; };   // cylinder axis -> X
const alongZ = m => { m.rotation.x = Math.PI / 2; return m; };   // cylinder axis -> Z

// ---- lofting ---------------------------------------------------------------------

/**
 * One rounded-rectangle ring at height p.y: x centred on p.cx (default 0) and
 * p.w wide; z from p.back to p.front. Back corners use radius p.rb, front
 * corners p.rf (a big rf and a small rb make the D-shape of a basin or a WC
 * pan). The points run anticlockwise seen from above (+z, +x, -z, -x), so
 * consecutive rings stitch without a seam.
 */
export function rrRing(p, seg) {
  const cx = p.cx || 0, hw = p.w / 2;
  const cz = (p.back + p.front) / 2, hd = (p.front - p.back) / 2;
  const lim = Math.max(0.002, Math.min(hw, hd) - 1e-4);
  const rf = Math.max(0.002, Math.min(p.rf, lim)), rb = Math.max(0.002, Math.min(p.rb, lim));
  const corners = [
    [cx + hw - rf, cz + hd - rf, rf, Math.PI / 2],    // front-right
    [cx + hw - rb, cz - hd + rb, rb, 0],              // back-right
    [cx - hw + rb, cz - hd + rb, rb, -Math.PI / 2],   // back-left
    [cx - hw + rf, cz + hd - rf, rf, -Math.PI]        // front-left
  ];
  const pts = [];
  corners.forEach(([ox, oz, r, a0]) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 - (Math.PI / 2) * i / seg;
      pts.push([ox + r * Math.cos(a), p.y, oz + r * Math.sin(a)]);
    }
  });
  return pts;
}

/**
 * Stitch a profile (an array of rrRing specs) into one BufferGeometry.
 *
 * WINDING. Each band is wound (ring i, j) -> (ring i, j+1) -> (ring i+1, j),
 * so a band whose next ring is ABOVE faces outward and a band whose next ring
 * is below and inside faces inward -- i.e. a profile that climbs the outer
 * wall, rolls over a rim and descends into a bowl is front-facing everywhere
 * it is seen from. `capLast` closes the last ring facing UP (a bowl floor);
 * `capFirst` closes the first ring facing DOWN (an underside). Caps have
 * their own vertices so they shade flat while the walls stay smooth.
 */
export function loftRR(THREE, profile, opts) {
  const o = opts || {};
  const seg = o.seg || 5;
  const rings = profile.map(p => rrRing(p, seg));
  const n = rings[0].length;
  const pos = [], idx = [];
  rings.forEach(r => r.forEach(v => pos.push(v[0], v[1], v[2])));
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j, b = i * n + (j + 1) % n;
      const c = (i + 1) * n + j, d = (i + 1) * n + (j + 1) % n;
      idx.push(a, b, c, b, d, c);
    }
  }
  const cap = (r, up) => {
    const base = pos.length / 3;
    let sx = 0, sy = 0, sz = 0;
    r.forEach(v => { pos.push(v[0], v[1], v[2]); sx += v[0]; sy += v[1]; sz += v[2]; });
    const ci = pos.length / 3;
    pos.push(sx / n, sy / n, sz / n);
    for (let j = 0; j < n; j++) {
      if (up) idx.push(ci, base + j, base + (j + 1) % n);
      else idx.push(ci, base + (j + 1) % n, base + j);
    }
  };
  if (o.capFirst) cap(rings[0], false);
  if (o.capLast) cap(rings[rings.length - 1], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A rolled rim: the rings strictly BETWEEN ring A (outer wall top) and ring B
 * (bowl lip), on a half-round rising `lipH` at the crown. `steps` bands.
 */
export function rollRings(A, B, lipH, steps) {
  const out = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps, s = (1 - Math.cos(Math.PI * t)) / 2;
    const L = k => A[k] + (B[k] - A[k]) * s;
    out.push({
      y: A.y + (B.y - A.y) * t + lipH * Math.sin(Math.PI * t),
      w: L('w'), back: L('back'), front: L('front'), rb: L('rb'), rf: L('rf'),
      cx: (A.cx || 0) + ((B.cx || 0) - (A.cx || 0)) * s
    });
  }
  return out;
}

const CERAMIC = '#f7f5f0';
const CHROME = '#d3d7db';
// Chrome is drawn `gloss` in a light cool grey, NOT `metal`. The live house has
// no environment map, and a 0.9-metalness surface with nothing to reflect has
// almost no diffuse term: taps, valves and rails came out near-black there.
// A smooth light grey reads as polished chrome under the room lights, and
// still picks up the spec pages' reflections.
const CHROME_FINISH = 'gloss';

// ---- bathtub -----------------------------------------------------------------------

const BATHTUB_DEFAULTS = deepFreeze({
  width: 170,          // cm, the run along the wall (local x)
  depth: 70,           // cm, out from the wall
  height: 55,          // cm, floor to the rim
  rim: 5,              // cm, the flat deck all round the inner basin
  wasteEnd: 'right',   // 'left' | 'right' as you face the bath: the plug end
  color: CERAMIC,
  wasteColor: CHROME
});

function buildBathtub(THREE, params, opts) {
  const p = resolve(BATHTUB_DEFAULTS, params);
  const low = isLow(opts);
  const L = p.width * CM, D = p.depth * CM, h = p.height * CM;
  const rim = Math.max(0.02, Math.min(p.rim * CM, D / 4, L / 4));
  const seg = low ? 2 : 5;
  const wasteRight = p.wasteEnd !== 'left';
  const floorY = Math.max(0.04, Math.min(0.16, h - 0.39));
  // A ring inset `head` at the headrest end, `foot` at the waste end and `s`
  // front and back: the headrest end slopes more gently than the waste end.
  const ring = (y, head, foot, s, r) => {
    const left = wasteRight ? head : foot, right = wasteRight ? foot : head;
    return { y, w: L - left - right, cx: (left - right) / 2, back: s, front: D - s, rb: r, rf: r };
  };
  const outerTop = ring(h - 0.012, 0, 0, 0, 0.012);
  const lip = ring(h - 0.004, rim, rim, rim, 0.12);
  const profile = [ring(0, 0, 0, 0, 0.012), outerTop, ...rollRings(outerTop, lip, 0.006, low ? 2 : 4), lip];
  profile.push(ring(h - 0.07, rim + 0.03, rim + 0.02, rim + 0.01, 0.145));
  if (!low) {
    profile.push(ring(floorY + 0.10, rim + 0.12, rim + 0.06, rim + 0.04, 0.13));
    profile.push(ring(floorY + 0.02, rim + 0.17, rim + 0.09, rim + 0.06, 0.095));
  }
  const floor = ring(floorY, rim + 0.19, rim + 0.11, rim + 0.075, 0.075);
  profile.push(floor);

  const group = new THREE.Group();
  group.name = 'furniture:bathtub';
  part(THREE, group, loftRR(THREE, profile, { seg, capLast: true }), fin(THREE, 'gloss', p.color), 'bathShell');
  const wasteX = wasteRight ? floor.cx + floor.w / 2 - 0.07 : floor.cx - floor.w / 2 + 0.07;
  const waste = cylPart(THREE, group, 0.03, 0.03, 0.006, low ? 8 : 12, fin(THREE, CHROME_FINISH, p.wasteColor), 'bathWaste');
  waste.position.set(wasteX, floorY + 0.003, D / 2);
  return group;
}

// ---- toilet ---------------------------------------------------------------------------

const TOILET_DEFAULTS = deepFreeze({
  width: 36,           // cm, the pan (and seat) width
  depth: 54,           // cm, wall to the front of the pan
  height: 75,          // cm, the envelope: the flush plate's top (the lid's top with no plate)
  seatHeight: 40,      // cm, floor to the top of the pan's rim (the seat sits on it)
  flushPlate: true,    // the concealed cistern's plate on the wall behind the pan
  plateWidth: 22,
  plateHeight: 15,
  color: CERAMIC,
  plateColor: CHROME
});

const SEAT_T = 0.022, LID_T = 0.02;

function buildToilet(THREE, params, opts) {
  const p = resolve(TOILET_DEFAULTS, params);
  const low = isLow(opts);
  const w = p.width * CM, dep = p.depth * CM, h = p.seatHeight * CM;
  const seg = low ? 2 : 5;
  const group = new THREE.Group();
  group.name = 'furniture:toilet';
  const ceramic = fin(THREE, 'gloss', p.color);
  const chrome = fin(THREE, CHROME_FINISH, p.plateColor);

  // Pan: pedestal -> flared body -> rolled rim -> bowl -> water level.
  const outerTop = { y: h - 0.014, w, back: 0, front: dep, rb: 0.02, rf: 0.15 };
  const lip = { y: h - 0.004, w: w - 0.064, back: 0.075, front: dep - 0.036, rb: 0.05, rf: 0.13 };
  const profile = [{ y: 0, w: w * 0.60, back: 0, front: dep * 0.74, rb: 0.02, rf: 0.09 }];
  if (!low) profile.push({ y: 0.12, w: w * 0.64, back: 0, front: dep * 0.78, rb: 0.02, rf: 0.10 });
  profile.push({ y: h * 0.62, w: w * 0.86, back: 0, front: dep * 0.92, rb: 0.02, rf: 0.13 });
  if (!low) profile.push({ y: h * 0.86, w: w * 0.98, back: 0, front: dep * 0.99, rb: 0.02, rf: 0.15 });
  profile.push(outerTop, ...rollRings(outerTop, lip, 0.012, low ? 2 : 4), lip);
  profile.push({ y: h - 0.05, w: w * 0.74, back: 0.10, front: dep - 0.055, rb: 0.07, rf: 0.12 });
  if (!low) profile.push({ y: h - 0.13, w: w * 0.54, back: 0.14, front: dep - 0.10, rb: 0.09, rf: 0.10 });
  profile.push({ y: h - 0.19, w: w * 0.36, back: 0.17, front: dep - 0.15, rb: 0.07, rf: 0.07 });
  part(THREE, group, loftRR(THREE, profile, { seg, capLast: true }), ceramic, 'wcPan');

  // Square soft-close seat (a closed ring loft) and lid (a capped slab).
  const outer = y => ({ y, w: w * 0.97, back: 0.05, front: dep, rb: 0.03, rf: 0.14 });
  const hole = y => ({ y, w: w - 0.1, back: 0.12, front: dep - 0.07, rb: 0.07, rf: 0.11 });
  part(THREE, group, loftRR(THREE, [outer(h), outer(h + SEAT_T), hole(h + SEAT_T), hole(h), outer(h)], { seg }), ceramic, 'wcSeat');
  part(THREE, group, loftRR(THREE, [outer(h + SEAT_T), outer(h + SEAT_T + LID_T)], { seg, capFirst: true, capLast: true }), ceramic, 'wcLid');
  if (!low) {
    [-1, 1].forEach((sx, i) => {
      const hp = cylPart(THREE, group, 0.012, 0.014, 0.03, 8, chrome, i ? 'wcHingeR' : 'wcHingeL');
      hp.position.set(sx * w * 0.28, h + 0.015, 0.03);
    });
  }

  // Flush plate on the wall behind the pan, its top at `height`.
  if (p.flushPlate) {
    const pw = Math.min(p.plateWidth * CM, w), ph = p.plateHeight * CM, top = p.height * CM;
    boxPart(THREE, group, pw, ph, 0.01, 0, top - ph / 2, 0.005, chrome, 'wcFlushPlate');
    if (!low) {
      [-1, 1].forEach((sx, i) => {
        boxPart(THREE, group, pw * 0.36, ph * 0.62, 0.008, sx * pw * 0.21, top - ph / 2, 0.014, chrome,
          i ? 'wcFlushButtonR' : 'wcFlushButtonL');
      });
    }
  }
  return group;
}

/** The toilet's envelope height when it has no flush plate: the lid's top, in cm. */
export function toiletLidTop(seatHeight) {
  return seatHeight + (SEAT_T + LID_T) / CM;
}

// ---- vanity-counter ------------------------------------------------------------------

const VANITY_DEFAULTS = deepFreeze({
  width: 120,          // cm, along the wall
  depth: 48,           // cm, the envelope: counterDepth + how far the basin stands proud of it
  height: 106,         // cm, the envelope: the tap's top (the basin rim with no tap)
  counterDepth: 30,    // cm, wall to the counter's front face
  counterHeight: 90,   // cm, floor to the countertop's top
  topThick: 3,         // cm, the countertop slab
  basin: true,
  basinWidth: 50,
  basinDepth: 40,      // cm, front to back; clamped so the back clears the wall by 1 cm
  basinHeight: 18,     // cm, rim to the underside of the bowl
  basinAt: null,       // cm from the counter's LEFT end (as you face it) to the basin's centre; null = centred
  basinLip: 2,         // cm the basin's rim stands above the countertop
  tap: true,           // a square mono mixer on the basin's rear deck, rising to `height`
  bodyColor: '#cdc2b1',
  topColor: '#f6f4ef',
  ceramicColor: CERAMIC,
  tapColor: CHROME,
  tileWidth: 40,       // cm, grout-line pitch on the counter's front; 0 = no grout lines
  tileHeight: 25,
  groutColor: '#a89c87'
});

/**
 * The counter's envelope in cm, from its params: {width, depth, height, overhang}.
 * With a basin, depth = counterDepth + overhang (the params' own `depth` is
 * where the basin's front is); with a tap, height is the params' `height`.
 */
export function vanityEnvelope(params) {
  const p = resolve(VANITY_DEFAULTS, params);
  const overhang = p.basin ? Math.max(0, p.depth - p.counterDepth) : 0;
  const rim = p.counterHeight + p.basinLip;
  return {
    width: p.width,
    depth: p.counterDepth + overhang,
    height: p.basin ? (p.tap ? Math.max(p.height, rim + 4) : rim) : p.counterHeight,
    overhang
  };
}

/** The basin's centre x in the builder frame (metres), clamped onto the counter. */
export function vanityBasinX(p) {
  const W = p.width * CM, bw = p.basinWidth * CM;
  const x = p.basinAt == null ? 0 : -W / 2 + p.basinAt * CM;
  return Math.max(-W / 2 + bw / 2, Math.min(W / 2 - bw / 2, x));
}

function buildVanity(THREE, params, opts) {
  const p = resolve(VANITY_DEFAULTS, params);
  const low = isLow(opts);
  const env = vanityEnvelope(p);
  const W = p.width * CM, cd = p.counterDepth * CM, ch = p.counterHeight * CM, tt = p.topThick * CM;
  const D = env.depth * CM, H = env.height * CM;
  const group = new THREE.Group();
  group.name = 'furniture:vanity-counter';

  // Counter body (stops a slab short of the top) and grout lines on its face.
  const bodyH = ch - tt;
  boxPart(THREE, group, W, bodyH, cd, 0, bodyH / 2, cd / 2, fin(THREE, 'gloss', p.bodyColor), 'counterBody');
  if (!low && p.tileWidth > 0 && p.tileHeight > 0) {
    const grout = fin(THREE, 'matte', p.groutColor);
    const tw = p.tileWidth * CM, th = p.tileHeight * CM, gz = cd + 0.0005, gw = 0.004;
    for (let x = -W / 2 + tw; x < W / 2 - 0.01; x += tw) boxPart(THREE, group, gw, bodyH, 0.001, x, bodyH / 2, gz, grout, 'counterGroutV');
    for (let y = th; y < bodyH - 0.01; y += th) boxPart(THREE, group, W, gw, 0.001, 0, y, gz, grout, 'counterGroutH');
  }

  // Basin: semi-recessed, the rim `basinLip` above the countertop, the bowl
  // and its apron hanging IN FRONT of the counter face below the countertop.
  let notch = null;
  if (p.basin) {
    const bw = p.basinWidth * CM, bh = p.basinHeight * CM;
    const bd = Math.min(p.basinDepth * CM, D - 0.01);
    const bcx = vanityBasinX(p);
    const seg = low ? 2 : 5;
    const topY = ch + p.basinLip * CM, baseY = topY - bh;
    const front = D, back = D - bd;
    const underY = ch - tt;                 // countertop underside
    const fwdBack = cd + 0.004;             // below it, never behind the counter face
    const bowlBack = back + Math.min(0.10, bd * 0.28);
    const profile = [];
    const steps = low ? [0, 5] : [0, 1, 2, 3, 4, 5];
    steps.forEach(i => {
      const a = (Math.PI / 2) * i / 5, e = Math.sin(a), yk = 1 - Math.cos(a);
      profile.push({
        y: baseY + Math.min(bh * 0.35, underY - baseY - 0.004) * yk, cx: bcx,
        w: bw * (0.62 + 0.26 * e), back: fwdBack + 0.01 * (1 - e),
        front: front - 0.04 + 0.028 * e, rb: 0.03 - 0.01 * e, rf: 0.07 + 0.05 * e
      });
    });
    profile.push({ y: underY - 0.002, cx: bcx, w: bw, back: fwdBack, front: front - 0.002, rb: 0.02, rf: 0.155 });
    profile.push({ y: underY, cx: bcx, w: bw, back, front, rb: 0.02, rf: 0.16 });
    const outerTop = { y: topY - 0.012, cx: bcx, w: bw, back, front, rb: 0.02, rf: 0.16 };
    const lip = { y: topY - 0.004, cx: bcx, w: bw - 0.07, back: bowlBack, front: front - 0.035, rb: 0.06, rf: 0.15 };
    profile.push(outerTop, ...rollRings(outerTop, lip, 0.008, low ? 2 : 4), lip);
    const bowlFloorY = topY - bh * 0.72;
    profile.push({ y: topY - 0.03, cx: bcx, w: bw * 0.80, back: Math.max(bowlBack + 0.04, fwdBack + 0.012), front: front - 0.05, rb: 0.08, rf: 0.14 });
    if (!low) profile.push({ y: underY - 0.01, cx: bcx, w: bw * 0.66, back: Math.max(fwdBack + 0.015, bowlBack + 0.08), front: front - 0.07, rb: 0.09, rf: 0.12 });
    const floorRing = { y: bowlFloorY, cx: bcx, w: bw * 0.40, back: Math.max(fwdBack + 0.03, bowlBack + 0.12), front: front - 0.10, rb: 0.07, rf: 0.07 };
    profile.push(floorRing);
    part(THREE, group, loftRR(THREE, profile, { seg, capFirst: true, capLast: true }), fin(THREE, 'gloss', p.ceramicColor), 'basinBody');
    const chrome = fin(THREE, CHROME_FINISH, p.tapColor);
    if (!low) {
      const waste = cylPart(THREE, group, 0.018, 0.018, 0.004, 12, chrome, 'basinWaste');
      waste.position.set(bcx, bowlFloorY + 0.002, (floorRing.back + floorRing.front) / 2);
    }
    if (p.tap) {
      // Square mono mixer on the rear deck: body, lever on top, flat spout.
      const tapZ = back + (bowlBack - back) * 0.5;
      const bodyW = 0.045, lever = 0.012;
      const bodyTall = Math.max(0.03, H - topY - lever);
      boxPart(THREE, group, bodyW, bodyTall, bodyW, bcx, topY + bodyTall / 2, tapZ, chrome, 'basinTapBody');
      boxPart(THREE, group, 0.02, lever, 0.07, bcx, topY + bodyTall + lever / 2, tapZ - 0.01, chrome, 'basinTapLever');
      const spoutLen = Math.max(0.06, (lip.back + 0.06) - tapZ);
      boxPart(THREE, group, bodyW * 0.95, 0.018, spoutLen, bcx, topY + bodyTall - 0.03, tapZ + spoutLen / 2, chrome, 'basinTapSpout');
    }
    notch = { x0: bcx - bw / 2, x1: bcx + bw / 2, back };
  }

  // Countertop: one slab, or three round the basin's notch (left of it, right
  // of it, and the strip between the wall and the basin's back).
  const top = fin(THREE, 'gloss', p.topColor);
  const slab = (x0, x1, z0, z1, name) => {
    if (x1 - x0 <= 0.0005 || z1 - z0 <= 0.0005) return;
    boxPart(THREE, group, x1 - x0, tt, z1 - z0, (x0 + x1) / 2, ch - tt / 2, (z0 + z1) / 2, top, name);
  };
  if (!notch) {
    slab(-W / 2, W / 2, 0, cd, 'countertop');
  } else {
    const x0 = Math.max(-W / 2, notch.x0), x1 = Math.min(W / 2, notch.x1);
    slab(-W / 2, x0, 0, cd, 'countertopL');
    slab(x1, W / 2, 0, cd, 'countertopR');
    slab(x0, x1, 0, Math.min(cd, Math.max(0, notch.back)), 'countertopBack');
  }
  return group;
}

// ---- shower-set -------------------------------------------------------------------------

const SHOWER_SET_DEFAULTS = deepFreeze({
  width: 44.7,         // cm -- OUTPUTS: the envelope showerSetEnvelope() computes
  depth: 19.2,
  height: 133.8,
  valveHeight: 110,    // cm, floor to the bar valve's centreline
  valveLength: 30,     // cm, the bar between its two end controls
  riserOffset: 20,     // cm along the wall from the valve's centre to the riser; + is right as you face the wall
  riserFrom: 118,      // cm, floor to the riser's lower bracket
  riserTo: 200,        // cm, floor to its upper bracket
  handsetHeight: null, // cm, floor to the handset slider; null = 22 below riserTo
  hose: true,
  spoutHeight: null,   // cm, floor to a wall bath spout's centreline under the valve; null = none
  spoutReach: 16,
  color: CHROME,
  faceColor: '#9aa0a6'
});

/** Parts at their FLOOR heights, x = 0 at the valve's centre. Not yet framed. */
function rawShowerSet(THREE, p, low) {
  const g = new THREE.Group();
  const chrome = fin(THREE, CHROME_FINISH, p.color);
  const vy = p.valveHeight * CM, L = p.valveLength * CM, ra = p.riserOffset * CM;
  const rBot = p.riserFrom * CM, rTop = Math.max(rBot + 0.1, p.riserTo * CM);
  const hsY = p.handsetHeight == null ? rTop - 0.22 : p.handsetHeight * CM;
  const VZ = 0.065, RZ = 0.05;
  const s = low ? 6 : 8, m = low ? 6 : 12, big = low ? 6 : 16;

  // (a) bar valve on two wall legs, a knurled control at each end
  alongX(cylPart(THREE, g, 0.024, 0.024, L, big, chrome, 'showerBarValve')).position.set(0, vy, VZ);
  [-1, 1].forEach((sg, i) => {
    alongZ(cylPart(THREE, g, 0.011, 0.011, VZ, s, chrome, 'showerValveLeg' + i)).position.set(sg * L * 0.3, vy, VZ / 2);
    alongX(cylPart(THREE, g, 0.031, 0.031, 0.04, m, chrome, 'showerBarKnob' + i)).position.set(sg * (L / 2 + 0.022), vy, VZ);
    if (!low) {
      alongZ(cylPart(THREE, g, 0.028, 0.028, 0.008, s, chrome, 'showerValveRosette' + i)).position.set(sg * L * 0.3, vy, 0.004);
      alongX(cylPart(THREE, g, 0.026, 0.026, 0.008, s, chrome, 'showerKnobCollar' + i)).position.set(sg * (L / 2 + 0.002), vy, VZ);
    }
  });
  if (!low) cylPart(THREE, g, 0.011, 0.011, 0.03, s, chrome, 'showerValveOutlet').position.set(0, vy - 0.035, VZ);

  // (b) riser rail on two brackets, slider and cradle
  cylPart(THREE, g, 0.011, 0.011, rTop - rBot, m, chrome, 'showerRiser').position.set(ra, (rBot + rTop) / 2, RZ);
  [rBot, rTop].forEach((y, i) => {
    alongZ(cylPart(THREE, g, 0.012, 0.012, RZ, s, chrome, 'showerRiserBracket' + i)).position.set(ra, y, RZ / 2);
    if (!low) {
      alongZ(cylPart(THREE, g, 0.026, 0.026, 0.008, s, chrome, 'showerRiserRosette' + i)).position.set(ra, y, 0.004);
      cylPart(THREE, g, 0.014, 0.014, 0.02, s, chrome, 'showerRiserCap' + i).position.set(ra, y + (i ? 0.01 : -0.01), RZ);
    }
  });
  boxPart(THREE, g, 0.036, 0.055, 0.036, ra, hsY, RZ, chrome, 'showerSlider');
  if (!low) alongZ(cylPart(THREE, g, 0.008, 0.008, 0.05, s, chrome, 'showerCradle')).position.set(ra, hsY, RZ + 0.035);

  // (c) handset, tilted out, with a round spray head
  const hs = new THREE.Group();
  hs.name = 'showerHandset';
  hs.position.set(ra, hsY, RZ + 0.07);
  hs.rotation.x = 0.35;
  g.add(hs);
  cylPart(THREE, hs, 0.016, 0.012, 0.18, m, chrome, 'showerHandsetHandle').position.set(0, -0.02, 0);
  const head = cylPart(THREE, hs, 0.055, 0.05, 0.03, big, chrome, 'showerHandsetHead');
  head.position.set(0, 0.09, 0.02);
  head.rotation.x = Math.PI / 2 - 0.25;
  if (!low) {
    const face = cylPart(THREE, hs, 0.046, 0.046, 0.004, big, fin(THREE, CHROME_FINISH, p.faceColor), 'showerHandsetFace');
    face.position.set(0, 0.094, 0.0355);
    face.rotation.x = Math.PI / 2 - 0.25;
  }

  // (d) hose: valve outlet, down in a loop, up to the handle's base
  if (p.hose && !low) {
    const hb = new THREE.Vector3(ra, hsY - 0.11 * Math.cos(0.35), RZ + 0.07 - 0.11 * Math.sin(0.35));
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, vy - 0.05, VZ),
      new THREE.Vector3(ra * 0.2, vy - 0.30, VZ + 0.03),
      new THREE.Vector3(ra * 0.6, vy - 0.42, VZ + 0.05),
      new THREE.Vector3(ra * 1.05, vy - 0.22, VZ + 0.05),
      new THREE.Vector3(ra * 1.1, (vy + hb.y) / 2, RZ + 0.06),
      hb
    ]);
    part(THREE, g, new THREE.TubeGeometry(curve, 20, 0.007, 6, false), chrome, 'showerHose');
  }

  // (e) wall bath spout under the valve
  if (p.spoutHeight != null) {
    const sy = p.spoutHeight * CM, reach = Math.max(0.05, p.spoutReach * CM);
    if (!low) alongZ(cylPart(THREE, g, 0.03, 0.03, 0.01, s, chrome, 'bathSpoutRosette')).position.set(0, sy, 0.005);
    boxPart(THREE, g, 0.045, 0.032, reach, 0, sy, reach / 2, chrome, 'bathSpout');
    boxPart(THREE, g, 0.045, 0.03, 0.03, 0, sy - 0.02, reach - 0.015, chrome, 'bathSpoutOutlet');
  }
  return g;
}

function rawBox(THREE, g) {
  g.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(g);
}

/**
 * How big a shower set comes out, in cm: {width, depth, height} (its
 * bounding box -- put these in its params), `bottom` (floor to its lowest
 * part -- its `elevation`) and `valveX` (the valve's centre along local x
 * from the set's centre, + to the right as you face the wall).
 */
export function showerSetEnvelope(THREE, params) {
  const p = resolve(SHOWER_SET_DEFAULTS, params);
  const b = rawBox(THREE, rawShowerSet(THREE, p, false));
  const r1 = v => Math.round(v * 1000) / 10;
  return {
    width: r1(b.max.x - b.min.x), depth: r1(b.max.z - b.min.z), height: r1(b.max.y - b.min.y),
    bottom: r1(b.min.y), valveX: r1(-(b.min.x + b.max.x) / 2)
  };
}

function buildShowerSet(THREE, params, opts) {
  const p = resolve(SHOWER_SET_DEFAULTS, params);
  // Frame BOTH details by the full build's box, so a low build sits exactly
  // where the full one does (it only has fewer parts).
  const b = rawBox(THREE, rawShowerSet(THREE, p, false));
  const raw = isLow(opts) ? rawShowerSet(THREE, p, true) : rawShowerSet(THREE, p, false);
  raw.position.set(-(b.min.x + b.max.x) / 2, -b.min.y, -b.min.z);
  const group = new THREE.Group();
  group.name = 'furniture:shower-set';
  group.add(raw);
  return group;
}

// ---- shower-screen ----------------------------------------------------------------------

const SHOWER_SCREEN_DEFAULTS = deepFreeze({
  width: 70,           // cm, the whole run (the panels' widths are scaled to it)
  height: 140,
  depth: 3,            // cm, frame depth (+2 for the door handle when there is a door)
  frame: 'rail',       // 'rail': a hinge jamb and a top rail (a bath screen); 'full': framed panels
  panels: [{ kind: 'fixed', width: 70 }],   // left to right as you face the screen; kind 'fixed' | 'door'
  hinge: 'right',      // which end the jamb (rail) / each door's hinge (full) is at
  frameColor: '#f1ede2',
  glassColor: '#bcd8e6'
});

const SASH = 0.032, MULLION = 0.04, HANDLE = 0.02;

function buildShowerScreen(THREE, params, opts) {
  const p = resolve(SHOWER_SCREEN_DEFAULTS, params);
  const low = isLow(opts);
  const W = p.width * CM, H = p.height * CM;
  const group = new THREE.Group();
  group.name = 'furniture:shower-screen';
  const frame = fin(THREE, 'matte', p.frameColor);
  const glass = fin(THREE, 'glass', p.glassColor);
  const right = p.hinge !== 'left';

  if (p.frame !== 'full') {
    // Bath screen: a hinge jamb at one end, a top rail, one glass panel.
    const D = p.depth * CM, T = Math.min(0.03, D);
    const jx = right ? W / 2 - T / 2 : -W / 2 + T / 2;
    boxPart(THREE, group, T, H, D, jx, H / 2, D / 2, frame, 'screenHingeJamb');
    boxPart(THREE, group, W, 0.035, T, 0, H - 0.0175, D / 2, frame, 'screenTopRail');
    const gl = W - T - 0.005;
    boxPart(THREE, group, gl, H - 0.07, 0.008, right ? -W / 2 + gl / 2 : W / 2 - gl / 2, H / 2, D / 2, glass, 'screenGlass');
    return group;
  }

  // Framed panels. Panel widths are scaled to fill the run; a mullion sits
  // on every internal boundary. A door carries a handle on the room side.
  const panels = Array.isArray(p.panels) && p.panels.length ? p.panels : [{ kind: 'fixed', width: p.width }];
  const hasDoor = panels.some(q => q.kind === 'door');
  const FD = Math.max(0.01, p.depth * CM - (hasDoor ? HANDLE : 0));
  const zc = FD / 2, BT = Math.min(0.03, FD);
  const sum = panels.reduce((a, q) => a + Math.max(0, q.width || 0), 0) || 1;
  let x = -W / 2;
  panels.forEach((q, i) => {
    const a0 = x, b0 = x + W * Math.max(0, q.width || 0) / sum;
    x = b0;
    const a = a0 + (i > 0 ? MULLION / 2 : 0), b = b0 - (i < panels.length - 1 ? MULLION / 2 : 0);
    const len = Math.max(0.01, b - a), cx = (a + b) / 2;
    if (i < panels.length - 1) boxPart(THREE, group, MULLION, H, FD, b0, H / 2, zc, frame, 'screenMullion');
    boxPart(THREE, group, len, SASH, BT, cx, SASH / 2, zc, frame, 'screenRailBottom');
    boxPart(THREE, group, len, SASH, BT, cx, H - SASH / 2, zc, frame, 'screenRailTop');
    if (q.kind === 'door') {
      [a + SASH / 2, b - SASH / 2].forEach(sx => boxPart(THREE, group, SASH, H - 2 * SASH, BT, sx, H / 2, zc, frame, 'screenDoorStile'));
      boxPart(THREE, group, len - 2 * SASH, H - 2 * SASH, 0.008, cx, H / 2, zc, glass, 'screenDoorGlass');
      const latchX = right ? a + SASH * 1.6 : b - SASH * 1.6;
      boxPart(THREE, group, 0.02, 0.14, HANDLE, latchX, H / 2, FD + HANDLE / 2, fin(THREE, CHROME_FINISH, CHROME), 'screenDoorHandle');
    } else {
      boxPart(THREE, group, len, H - 2 * SASH, 0.008, cx, H / 2, zc, glass, 'screenFixedGlass');
    }
  });
  return group;
}

// ---- shower-tray ------------------------------------------------------------------------

const SHOWER_TRAY_DEFAULTS = deepFreeze({
  width: 90,
  depth: 80,
  height: 4.5,
  color: CERAMIC,
  wasteColor: CHROME
});

function buildShowerTray(THREE, params, opts) {
  const p = resolve(SHOWER_TRAY_DEFAULTS, params);
  const low = isLow(opts);
  const W = p.width * CM, D = p.depth * CM, h = p.height * CM;
  const floorY = Math.max(0.004, h - 0.02);
  const ring = (y, s, r) => ({ y, w: W - 2 * s, back: s, front: D - s, rb: r, rf: r });
  const outerTop = ring(h - 0.006, 0, 0.02), lip = ring(h - 0.001, 0.025, 0.03);
  const profile = low
    ? [ring(0, 0, 0.02), outerTop, ring(floorY, 0.05, 0.04)]
    : [ring(0, 0, 0.02), outerTop, ...rollRings(outerTop, lip, 0.003, 2), lip, ring(floorY, 0.05, 0.04)];
  const group = new THREE.Group();
  group.name = 'furniture:shower-tray';
  part(THREE, group, loftRR(THREE, profile, { seg: low ? 1 : 3, capLast: true }), fin(THREE, 'gloss', p.color), 'trayBody');
  if (!low) {
    const waste = cylPart(THREE, group, 0.045, 0.045, 0.003, 12, fin(THREE, CHROME_FINISH, p.wasteColor), 'trayWaste');
    waste.position.set(0, floorY + 0.0015, D / 2);
  }
  return group;
}

// ---- towel-rail ---------------------------------------------------------------------------

const TOWEL_RAIL_DEFAULTS = deepFreeze({
  width: 50,           // cm, outside to outside of the two posts
  height: 120,         // cm, floor to the posts' tops
  depth: 4.2,          // cm, wall side of the posts to the front of the rungs
  rungs: 7,
  color: CHROME
});

function buildTowelRail(THREE, params, opts) {
  const p = resolve(TOWEL_RAIL_DEFAULTS, params);
  const low = isLow(opts);
  const W = p.width * CM, H = p.height * CM, D = p.depth * CM;
  const sideR = Math.min(0.012, D / 3), rungR = Math.min(0.009, D / 4);
  const postZ = sideR, rungZ = Math.max(postZ, D - rungR);
  const chrome = fin(THREE, CHROME_FINISH, p.color);
  const group = new THREE.Group();
  group.name = 'furniture:towel-rail';
  [-1, 1].forEach((sx, i) => {
    cylPart(THREE, group, sideR, sideR, H, low ? 6 : 12, chrome, i ? 'railSideR' : 'railSideL')
      .position.set(sx * (W / 2 - sideR), H / 2, postZ);
  });
  const n = Math.max(2, Math.round(p.rungs));
  const shown = low ? Math.max(2, Math.ceil(n / 2)) : n;
  const len = Math.max(0.01, W - 4 * sideR);
  for (let i = 0; i < shown; i++) {
    const k = shown === 1 ? 0 : i / (shown - 1);
    alongX(cylPart(THREE, group, rungR, rungR, len, low ? 4 : 8, chrome, 'railRung'))
      .position.set(0, H * 0.08 + k * H * 0.86, rungZ);
  }
  return group;
}

// ---- the module's types ------------------------------------------------------------------

// ---- edit-mode controls ---------------------------------------------------------
// Ranges, steps, options and labels are copied from the spec page (see controls.js).
const BATHTUB_CONTROLS = [
  select('wasteEnd', 'Waste end', ['left', 'right']),
];

const SHOWER_SCREEN_CONTROLS = [
  select('frame', 'Frame', ['rail', 'full']),
  select('hinge', 'Hinge', ['left', 'right']),
  unsupported('panels', 'Panels', 'array'),
  unsupported('width', 'Width', 'coupled'),
];

const SHOWER_SET_CONTROLS = [
  unsupported('width', 'Width', 'derived'),
  unsupported('depth', 'Depth', 'derived'),
  unsupported('height', 'Height', 'derived'),
];

// ---- edit-mode controls ---------------------------------------------------------
// Ranges, steps, options and labels are copied from the spec page (see controls.js).
const TOILET_CONTROLS = [
  // The height is the cistern/plate top, not a free dimension: it follows seatHeight and the flush plate.
  unsupported('height', 'Height', 'derived'),
];

const VANITY_CONTROLS = [
  // depth and height follow counterDepth / counterHeight / the basin.
  unsupported('depth', 'Depth', 'derived'),
  unsupported('height', 'Height', 'derived'),
];

const SHOWER_TRAY_CONTROLS = []; // BathroomFittingsSpec has no slider for this type: controlsFor() derives all of it

const TOWEL_RAIL_CONTROLS = []; // BathroomFittingsSpec has no slider for this type: controlsFor() derives all of it

export const TYPES = Object.freeze({
  'bathtub': Object.freeze({ DEFAULTS: BATHTUB_DEFAULTS, build: buildBathtub, CONTROLS: BATHTUB_CONTROLS }),
  'shower-screen': Object.freeze({ DEFAULTS: SHOWER_SCREEN_DEFAULTS, build: buildShowerScreen, CONTROLS: SHOWER_SCREEN_CONTROLS }),
  'shower-set': Object.freeze({ DEFAULTS: SHOWER_SET_DEFAULTS, build: buildShowerSet, CONTROLS: SHOWER_SET_CONTROLS }),
  'shower-tray': Object.freeze({ DEFAULTS: SHOWER_TRAY_DEFAULTS, build: buildShowerTray, CONTROLS: SHOWER_TRAY_CONTROLS }),
  'toilet': Object.freeze({ DEFAULTS: TOILET_DEFAULTS, build: buildToilet, CONTROLS: TOILET_CONTROLS }),
  'towel-rail': Object.freeze({ DEFAULTS: TOWEL_RAIL_DEFAULTS, build: buildTowelRail, CONTROLS: TOWEL_RAIL_CONTROLS }),
  'vanity-counter': Object.freeze({ DEFAULTS: VANITY_DEFAULTS, build: buildVanity, CONTROLS: VANITY_CONTROLS })
});

export { buildBathtub, buildToilet, buildVanity, buildShowerSet, buildShowerScreen, buildShowerTray, buildTowelRail };

/**
 * Triangle caps per type (full / low), perf-audit-furniture.md B3 style.
 * scripts/test-furniture-bathroom.mjs holds every preset to them, and to
 * "low <= 60% of full when full > 300".
 */
export const TRIANGLE_CAPS = deepFreeze({
  'bathtub': { full: 1200, low: 400 },
  'toilet': { full: 1200, low: 400 },
  'vanity-counter': { full: 1200, low: 400 },
  'shower-set': { full: 1200, low: 300 },
  'towel-rail': { full: 600, low: 200 },
  'shower-screen': { full: 300, low: 150 },
  'shower-tray': { full: 200, low: 100 }
});

/**
 * Generic presets for the spec page and the tests. ILLUSTRATIVE sizes only --
 * a real room's values belong in its own furniture[].params.
 */
export const PRESETS = deepFreeze({
  'Bath 170 x 70': { type: 'bathtub', params: {} },
  'Bath 160 x 75, plug left': { type: 'bathtub', params: { width: 160, depth: 75, wasteEnd: 'left' } },
  'WC with flush plate': { type: 'toilet', params: {} },
  'WC, no plate': { type: 'toilet', params: { flushPlate: false, height: 44.2 } },
  'Vanity 120, centred basin': { type: 'vanity-counter', params: {} },
  'Vanity 140, basin right': { type: 'vanity-counter', params: { width: 140, basinAt: 105 } },
  'Counter, no basin': { type: 'vanity-counter', params: { basin: false, depth: 30, height: 90 } },
  'Shower set': { type: 'shower-set', params: {} },
  'Shower set + bath spout': { type: 'shower-set', params: { valveHeight: 100, riserOffset: -15, riserFrom: 110, riserTo: 190, spoutHeight: 65, width: 39.7, depth: 19.2, height: 132.8 } },
  'Bath screen': { type: 'shower-screen', params: {} },
  'Shower glazing: fixed + door': { type: 'shower-screen', params: { width: 100, height: 195, depth: 6.5, frame: 'full', panels: [{ kind: 'fixed', width: 50 }, { kind: 'door', width: 50 }], hinge: 'right' } },
  'Shower tray 90 x 80': { type: 'shower-tray', params: {} },
  'Towel rail 50 x 120': { type: 'towel-rail', params: {} },
  'Towel rail 60 x 170': { type: 'towel-rail', params: { width: 60, height: 170, rungs: 9 } }
});

/** The params that differ from `type`'s DEFAULTS (what Copy JSON emits). */
export function paramsDiff(type, params) {
  const t = TYPES[type];
  if (!t) return {};
  const out = {};
  Object.keys(params || {}).forEach(k => {
    if (JSON.stringify(params[k]) !== JSON.stringify(t.DEFAULTS[k])) out[k] = params[k];
  });
  return out;
}
