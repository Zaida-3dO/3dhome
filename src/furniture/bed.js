/**
 * bed.js - single-type module: `bed`.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0, and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 * See docs/house-profile.md, "Furniture".
 *
 * A soft, upholstered bed made up and ready to sleep in -- no real
 * measurements, no house-specific placement; a generic, publishable shape.
 *
 *   - HEADBOARD: vertical padded channels set INSIDE a continuous padded
 *     border (a rolled edge running up both sides and across the top), all in
 *     one velvet. `height` IS the headboard height, honoured directly.
 *   - BASE: upholstered side and foot rails in the same velvet, with rounded
 *     tops and rounded foot corners, floating on a dark recessed plinth. The
 *     mattress sits down inside the rails, which hide its lower edge.
 *   - MATTRESS: rounded edges and a crowned top, dressed in a fitted sheet
 *     (`mattressColor` is the sheet you see).
 *   - BEDDING: a duvet in a cover, draped over the sides and the foot to the
 *     rail tops, its top edge folded back; accent pillows propped against the
 *     headboard (sized so the headboard shows above them, and never above
 *     `height`), sleeping pillows in front of them, and a faux-fur cushion.
 *     `beddingPreset: 'botanical'` scatters a dense wildflower print over the
 *     duvet cover; 'plain' leaves it plain.
 *
 * THE PRINT IS GEOMETRY, NOT A TEXTURE. Each stem, blade and blossom is one
 * or two triangles placed through the same cloth map as the duvet, lifted a few
 * millimetres off it, so it follows the roll, the drape and the fold. All
 * motifs of one colour are one mesh on a plain `matte` material, so the room
 * merge folds them into the matte bucket it already draws -- no texture, no
 * new material kind, no image of anything.
 *
 * Soft forms come from ./soft.js (rounded boxes, pillows, swept rails, cloth).
 * Budget (TRIANGLE_CAPS): 2,500 full / 800 low. Low detail keeps the shape --
 * headboard, rails, mattress, a plain duvet with its fold, two pillows -- on
 * coarser grids, and drops the print, the accent pillows and the cushion
 * (with its fur).
 */
import { makeFinish, isKeptFinish } from './finishes.js';
import { roundedBox, pillow, sweep, clothSheet, concatGeometries, prng } from './soft.js';

export const TYPE = 'bed';

/**
 * Defaults, in cm. A double/king frame ~161 x 220 with a ~150 x 200 mattress,
 * headboard 120 tall. `height` IS the headboard height (floor to its top).
 */
export const DEFAULTS = Object.freeze({
  width: 161,
  depth: 220,
  height: 120,            // floor to the top of the headboard
  baseHeight: 38,         // floor to the top of the upholstered rails
  mattressHeight: 24,
  channelCount: 8,        // vertical padded channels inside the headboard border
  channelDepth: 3.5,      // how far each channel stands proud at its centre, cm
  headboardColor: '#9ba8b3',   // pale blue-grey velvet
  baseColor: '#9ba8b3',        // the rails: same velvet by default
  plinthColor: '#2b2b2d',
  mattressColor: '#efe6d6',    // the fitted sheet
  pillowColor: '#f7f5f0',
  accentPillowColor: '#c9d3b0',
  cushionColor: '#5d6b45',
  duvet: true,
  duvetColor: '#f4f1ea',
  beddingPreset: 'botanical',  // 'botanical' | 'plain'
  finish: 'matte'
});

/** The per-type triangle budget (perf audit): asserted by scripts/test-bed.mjs. */
export const TRIANGLE_CAPS = Object.freeze({ full: 2500, low: 800 });

/**
 * The print's colours -- a wildflower meadow: sage and olive stems and leaf
 * blades; pink, rose, yellow and dusty-blue flower heads. One plain matte
 * mesh per colour.
 */
export const PRINT_COLORS = Object.freeze({
  leafSage: '#9cae86',
  leafOlive: '#6f7f4e',
  flowerPink: '#e0a7b4',
  flowerRose: '#c4546c',
  flowerYellow: '#e3c25a',
  flowerBlue: '#8fa3bf'
});

/**
 * Propped pillows (cm / radians): the accent pillows' length along the lean
 * and their lean off the mattress; the cushion's size and lean. These are
 * the UPPER bounds -- see pillowTops() for how they come down.
 */
const ACCENT_LEN = 42, ACCENT_LEAN = 58 * Math.PI / 180;
const CUSHION_LEN = 40, CUSHION_LEAN = 62 * Math.PI / 180;
const ACCENT_RISE = 32;    // accent pillow tops aim this far above the mattress top
const HEAD_SHOW = 12;      // ...but always leave at least this much headboard showing

/**
 * Where the propped pillows' tops aim, in cm from the floor: the accent
 * pillows ~ACCENT_RISE above the mattress, never within HEAD_SHOW of the
 * headboard top; the cushion 2 cm below them. Exported for the tests.
 */
export function pillowTops(params) {
  const p = resolveParams(params);
  const L = layout(p);
  const H = Math.max(p.height, 1);
  const accent = Math.min(L.mattTop + ACCENT_RISE, H - HEAD_SHOW);
  return { accent, cushion: accent - 2 };
}

/**
 * Size and lean a propped pillow so its top reaches no higher than `target`
 * (cm). makeGeo(lenCm) builds it lying flat (length along z, thickness y);
 * it is then rotated x = -(PI - lean) and its centre raised to
 * baseY + sin(lean) * len / 2, as build() places it. The top is measured on
 * its rotated bounding box, as the item's envelope is. Shrinks the length first (so the
 * footprint cos(lean) * len never grows), then the lean.
 */
function solveProp(THREE, makeGeo, baseY, target, o) {
  // Measured the way the envelope is (Box3.setFromObject): the rotated
  // corners of the geometry's own bounding box -- a little above the
  // pillow's true crest, so the item's bbox top is what gets honoured.
  const topOf = (geo, lean, len) => {
    const a = -(Math.PI - lean), ca = Math.cos(a), sa = Math.sin(a);
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    let hi = -Infinity;
    for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) hi = Math.max(hi, y * ca - z * sa);
    return baseY + Math.sin(lean) * len / 2 + hi / CM;
  };
  let len = o.len, lean = o.lean, geo = makeGeo(len);
  if (topOf(geo, lean, len) <= target) return { geo, len, lean };
  const bisect = (lo, hi, fits) => {       // the largest v in [lo, hi] that fits
    if (!fits(lo)) return lo;
    for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    return lo;
  };
  const byLen = () => { len = bisect(o.minLen, len, v => topOf(makeGeo(v), lean, v) <= target); geo = makeGeo(len); };
  const byLean = () => { lean = bisect(o.minLean, lean, v => topOf(geo, v, len) <= target); };
  byLen();
  if (topOf(geo, lean, len) > target) byLean();
  return { geo, len, lean };
}

/**
 * The faux-fur cushion's body: a pillow with a seeded lumpy surface (fur
 * piles up unevenly), so its outline is not a smooth sewn case.
 */
function furCushion(THREE, w, h, d) {
  const g = pillow(THREE, w, h, d, 4);
  const pos = g.attributes.position;
  const rnd = prng(0xf00f);
  for (let i = 0; i < pos.count; i++) {
    const k = 1 + 0.12 * (rnd() - 0.5);
    pos.setXYZ(i, pos.getX(i) * (1 + 0.04 * (rnd() - 0.5)), pos.getY(i) * k, pos.getZ(i) * (1 + 0.04 * (rnd() - 0.5)));
  }
  g.computeVertexNormals();
  return g;
}

/**
 * The faux fur itself: FUR_TUFTS shaggy tufts over the cushion's
 * room-facing surface -- each a broad triangle rooted on the surface and
 * lying down along it, "combed" roughly one way, its tip lifted ~1 cm off
 * the body -- so the pile overlaps like long shag rather than bristling.
 * Two meshes, lighter and darker tufts, as long pile catches the light in
 * streaks. Same transform as the cushion.
 */
const FUR_TUFTS = 100;
export const FUR_LENGTH = Object.freeze({ min: 2.5, max: 4 });
function addFur(THREE, cmesh, geo, color, add) {
  const rnd = prng(0xfa11);
  const pos = geo.attributes.position, idx = geo.index;
  const faces = [];
  let total = 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    A.fromBufferAttribute(pos, idx.getX(i)); B.fromBufferAttribute(pos, idx.getX(i + 1)); C.fromBufferAttribute(pos, idx.getX(i + 2));
    e1.subVectors(B, A); e2.subVectors(C, A); n.crossVectors(e1, e2);
    const area = n.length() / 2;
    n.normalize();
    // The cushion is turned face-down-and-back (rotation.x = -(PI - lean)),
    // so its local -y side is the one facing the room; skip the hidden side.
    if (!(area > 0) || n.y > 0.3) continue;
    total += area;
    faces.push({ a: A.clone(), b: B.clone(), c: C.clone(), n: n.clone(), cum: total });
  }
  const buckets = [[], []];
  const comb = new THREE.Vector3(0, 0, 1);
  for (let k = 0; k < FUR_TUFTS && faces.length; k++) {
    const r = rnd() * total;
    const f = faces.find(q => q.cum >= r) || faces[faces.length - 1];
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const root = f.a.clone().multiplyScalar(1 - u - v).addScaledVector(f.b, u).addScaledVector(f.c, v);
    // the combing direction on this face, turned up to +-50 degrees at random
    let t1 = comb.clone().addScaledVector(f.n, -comb.dot(f.n));
    if (t1.lengthSq() < 1e-6) t1 = new THREE.Vector3().subVectors(f.b, f.a);
    t1.normalize();
    const t2 = new THREE.Vector3().crossVectors(f.n, t1).normalize();
    const ang = (rnd() - 0.5) * 1.75;
    const dir = t1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(t2, Math.sin(ang));
    const len = (FUR_LENGTH.min + rnd() * (FUR_LENGTH.max - FUR_LENGTH.min)) * CM;
    // lying down, ~22 degrees off the surface; wound to face out (+n)
    const tip = root.clone().addScaledVector(dir, len * 0.92).addScaledVector(f.n, len * 0.38);
    const side = new THREE.Vector3().crossVectors(f.n, dir).normalize().multiplyScalar(0.9 * CM);
    const b0 = root.clone().add(side), b1 = root.clone().sub(side);
    buckets[rnd() < 0.5 ? 0 : 1].push(b0, b1, tip);
  }
  const base = new THREE.Color(color);
  const tones = [base.clone().lerp(new THREE.Color('#c9cf9a'), 0.45), base.clone().multiplyScalar(0.72)];
  buckets.forEach((verts, i) => {
    if (!verts.length) return;
    const arr = [];
    verts.forEach(v => arr.push(v.x, v.y, v.z));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    const mesh = add(g, makeFinish(THREE, 'matte', '#' + tones[i].getHexString()), 'cushion-fur',
      cmesh.position.x, cmesh.position.y, cmesh.position.z);
    mesh.rotation.copy(cmesh.rotation);
  });
}

const CM = 0.01;
const RAIL_W = 6;          // rail thickness, cm
const PLINTH_H = 3.5;      // the dark recessed plinth under the rails
const HEAD_T = 10;         // headboard thickness (border depth)
const BORDER_W = 7.5;      // padded border width
const BACKING_T = 6;       // flat backing the channels stand on
const SHEET_R = 4;         // mattress edge radius
const CROWN = 1.5;         // mattress crown at the centre
const DUVET_T = 6;         // duvet thickness on top
const DUVET_SIDE_T = 4.5;  // how far the drape stands off the mattress side

function resolveParams(params) {
  return Object.assign({}, DEFAULTS, params || {});
}

/** The layout every part agrees on, in cm, derived from the params. */
export function layout(p) {
  const W = p.width, D = p.depth;
  const railTop = Math.max(PLINTH_H + 5, p.baseHeight);
  const mattH = Math.max(8, p.mattressHeight);
  const mattBottom = railTop - 3;                   // the rails hide the lower 3 cm
  const mattTop = mattBottom + mattH;                // at the edge; the crown adds CROWN
  const mattHalfW = W / 2 - RAIL_W - 0.5;
  const zHead = HEAD_T + 1;
  const zFoot = D - RAIL_W - 1;
  return { W, D, railTop, mattH, mattBottom, mattTop, mattHalfW, zHead, zFoot };
}

// ---------------------------------------------------------------------------
// The duvet's cloth map. (s, t) are cloth coordinates in cm: s runs across
// the bed (0 at the centre line), t runs from the fold at the head end down
// to the hem at the foot. Across and along are separate profiles; a point is
// their sum, so the foot corners hang diagonally, and the drop is clamped at
// the rail top so no corner pokes through a rail.
// ---------------------------------------------------------------------------
export function duvetMap(p) {
  const L = layout(p);
  const T = DUVET_T;
  const YT = L.mattTop + T;                    // the duvet top over the flat
  const s0 = L.mattHalfW - SHEET_R;            // half-width of the flat top
  const rollH = SHEET_R + DUVET_SIDE_T, rollV = SHEET_R + T;
  const rollLen = Math.PI / 2 * (rollH + rollV) / 2;
  const dropLen = Math.max(1, (L.mattTop - SHEET_R) - (L.railTop + 0.5));
  const flare = 1.0;
  const sMax = s0 + rollLen + dropLen;

  // across: s -> {x, dy (<= 0), drop 0..1}
  function across(s) {
    const a = Math.abs(s), sg = s < 0 ? -1 : 1;
    if (a <= s0) return { x: s, dy: 0, k: 0 };
    if (a <= s0 + rollLen) {
      const th = (a - s0) / rollLen * Math.PI / 2;
      return { x: sg * (s0 + rollH * Math.sin(th)), dy: (rollV * Math.cos(th)) - rollV, k: 0 };
    }
    const d = Math.min(dropLen, a - s0 - rollLen);
    const k = d / dropLen;
    return { x: sg * (s0 + rollH + flare * k * k), dy: -rollV - d, k };
  }

  // along: the fold (a curl of radius T), the fold-back band, the band hem,
  // the main top, the roll over the foot and the drop.
  const coverFrac = 0.6;                         // share of the mattress length covered
  const f = L.zFoot - coverFrac * (L.zFoot - L.zHead);
  const band = 30;
  const z0 = L.zFoot - SHEET_R;                   // where the foot roll starts
  const curlLen = Math.PI * T;
  const stepLen = 3;
  const mainLen = Math.max(1, z0 - (f + band + stepLen));
  const tCurl = curlLen, tBand = tCurl + band, tStep = tBand + stepLen, tMain = tStep + mainLen;
  const tRoll = tMain + rollLen, tMax = tRoll + dropLen;
  function along(t) {
    if (t <= tCurl) {
      // semicircle about (f, dy 0): from the bottom (dy -T) round the head
      // side (z f-T) to the top (dy +T)
      const th = t / curlLen * Math.PI;
      return { z: f - T * Math.sin(th), dy: -T * Math.cos(th), k: 0, band: true };
    }
    if (t <= tBand) return { z: f + (t - tCurl), dy: T, k: 0, band: true };
    if (t <= tStep) {
      const u = (t - tBand) / stepLen;
      return { z: f + band + (t - tBand), dy: T * (0.5 + 0.5 * Math.cos(u * Math.PI)), k: 0, band: false };
    }
    if (t <= tMain) return { z: f + band + stepLen + (t - tStep), dy: 0, k: 0, band: false };
    if (t <= tRoll) {
      const th = (t - tMain) / rollLen * Math.PI / 2;
      return { z: z0 + rollH * Math.sin(th), dy: rollV * Math.cos(th) - rollV, k: 0, band: false };
    }
    const d = Math.min(dropLen, t - tRoll);
    const k = d / dropLen;
    return { z: z0 + rollH + flare * k * k, dy: -rollV - d, k, band: false };
  }

  const floorY = L.railTop + 0.5;
  const xLim = L.W / 2 - 0.3, zLim = L.D - 0.3;
  function map(s, t) {
    const A = across(s), B = along(t);
    // a soft sag/wrinkle on the top, and a gentle wave in the hanging hem
    const onTop = A.k === 0 && B.k === 0 && !B.band;
    const sag = onTop ? -0.5 * Math.sin(s * 0.085 + 1.3) * Math.sin(t * 0.06 + 0.4) : 0;
    const wave = A.k * 0.7 * Math.sin(t * 0.22) ;
    const waveZ = B.k * 0.7 * Math.sin(s * 0.22 + 0.8);
    const x = Math.max(-xLim, Math.min(xLim, A.x + Math.sign(A.x || 1) * wave * 0.5));
    const z = Math.min(zLim, B.z + waveZ * 0.5);
    const y = Math.max(floorY, YT + A.dy + B.dy + sag);
    return { x, y, z };
  }
  return { map, sMax, tMax, tCurl, tBand, tStep, tMain, tRoll, s0, rollLen, dropLen, f, band, YT, L };
}

/** Sample list: `segs` segments across [a, b] (inclusive). */
function lin(a, b, segs) {
  const out = [];
  for (let i = 0; i <= segs; i++) out.push(a + (b - a) * i / segs);
  return out;
}
function joinLists(...lists) {
  const out = [];
  for (const l of lists) for (const v of l) if (!out.length || Math.abs(out[out.length - 1] - v) > 1e-9) out.push(v);
  return out;
}

/**
 * Build the bed.
 * @param {Object} THREE
 * @param {Object} [params]  overrides for DEFAULTS
 * @param {{detail?: 'full'|'low'}} [opts]
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const p = resolveParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';
  const L = layout(p);
  const W = L.W, D = L.D, H = Math.max(p.height, 1);

  const group = new THREE.Group();
  group.name = 'furniture:bed';

  const velvet = makeFinish(THREE, p.finish, p.headboardColor);
  const railMat = makeFinish(THREE, p.finish, p.baseColor);
  const plinthMat = makeFinish(THREE, 'matte', p.plinthColor);
  const sheetMat = makeFinish(THREE, 'matte', p.mattressColor);
  const pillowMat = makeFinish(THREE, 'matte', p.pillowColor);
  const accentMat = makeFinish(THREE, 'matte', p.accentPillowColor);
  const cushionMat = makeFinish(THREE, 'matte', p.cushionColor);
  const duvetMat = makeFinish(THREE, 'matte', p.duvetColor);

  function add(geo, mat, name, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'bed:' + name;
    mesh.position.set(x || 0, y || 0, z || 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }
  const m = v => v * CM;

  // ---- headboard -----------------------------------------------------------
  // A flat backing (hidden behind the channels), a padded border swept up the
  // left edge, across the top and down the right, and the channels inside it.
  const hbBottom = PLINTH_H;
  const hbH = Math.max(1, H - hbBottom);
  add(new THREE.BoxGeometry(m(W - 1), m(hbH - 1), m(BACKING_T)), velvet, 'headboard-backing',
    0, m(hbBottom + (hbH - 1) / 2), m(BACKING_T / 2));

  const bw = Math.min(BORDER_W, W / 6, hbH / 3);
  const rr = Math.min(3.5, bw / 2 - 0.05);
  const arcSeg = full ? 3 : 1;
  // cross-section: a = across the border (outward to the path's right),
  // b = depth z, back flat on the wall, both front corners rolled
  const prof = [];
  const hb = bw / 2;
  prof.push([hb, 0]);
  for (let i = 0; i <= arcSeg; i++) {
    const th = i / arcSeg * Math.PI / 2;
    prof.push([hb - rr + rr * Math.cos(th), HEAD_T - rr + rr * Math.sin(th)]);
  }
  for (let i = 0; i <= arcSeg; i++) {
    const th = Math.PI / 2 + i / arcSeg * Math.PI / 2;
    prof.push([-hb + rr + rr * Math.cos(th), HEAD_T - rr + rr * Math.sin(th)]);
  }
  prof.push([-hb, 0]);
  // path: centreline of the border, an inverted U with rounded top corners.
  // Walked left-bottom -> up -> across -> down, the path's RIGHT is outward.
  const cx = W / 2 - hb, cy = H - hb;
  const cr = Math.min(6, cx, (cy - hbBottom) / 2);
  // 3 segments round each 6 cm top corner at full detail (2 at low): a 4th
  // is invisible at that radius and its triangles go to the print instead.
  const cornerSeg = full ? 3 : 2;
  const bpath = [[-cx, hbBottom]];
  for (let i = 0; i <= cornerSeg; i++) {
    const th = Math.PI - i / cornerSeg * Math.PI / 2;
    bpath.push([-cx + cr + cr * Math.cos(th), cy - cr + cr * Math.sin(th)]);
  }
  for (let i = 0; i <= cornerSeg; i++) {
    const th = Math.PI / 2 - i / cornerSeg * Math.PI / 2;
    bpath.push([cx - cr + cr * Math.cos(th), cy - cr + cr * Math.sin(th)]);
  }
  bpath.push([cx, hbBottom]);
  // Reverse the profile's a so "outward" (+a) is the path's right-hand side.
  const borderGeo = sweep(THREE, prof.map(([a, b]) => [m(a), m(b)]), bpath.map(([x, y]) => [m(x), m(y)]),
    { plane: 'xy', caps: true });
  add(borderGeo, velvet, 'headboard-border');

  // channels: front-only cushions, bulging (1-u^2)^0.6 so the creases between
  // neighbours run deep; each rounds off at its top end under the border.
  const n = Math.max(1, Math.round(p.channelCount));
  const innerW = W - 2 * bw;
  const pitch = innerW / n;
  const chBottom = Math.max(hbBottom, L.mattBottom - 2);
  const chTop = H - bw + 1;
  const chDepth = Math.max(0.2, Math.min(p.channelDepth, HEAD_T - BACKING_T));
  const nu = full ? 4 : 2;
  const vS = full ? [0, 0.5, 0.78, 0.92, 1] : [0, 0.85, 1];
  const chPos = [], chIdx = [];
  for (let j = 0; j < vS.length; j++) {
    const v = vS[j];
    const taper = v <= 0.75 ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow((v - 0.75) / 0.25, 2)));
    for (let i = 0; i <= nu; i++) {
      const u = -1 + 2 * i / nu;
      const bulge = Math.pow(Math.max(0, 1 - u * u), 0.6) * chDepth * taper;
      chPos.push(m(u * pitch / 2), m(chBottom + v * (chTop - chBottom)), m(BACKING_T + bulge));
    }
  }
  for (let j = 0; j < vS.length - 1; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, e = c + 1;
      chIdx.push(a, b, c, b, e, c);
    }
  }
  const chGeo = new THREE.BufferGeometry();
  chGeo.setAttribute('position', new THREE.Float32BufferAttribute(chPos, 3));
  chGeo.setIndex(chIdx);
  chGeo.computeVertexNormals();
  for (let i = 0; i < n; i++) {
    add(chGeo, velvet, 'headboard-channel', m(-innerW / 2 + pitch / 2 + i * pitch), 0, 0);
  }

  // ---- base: upholstered rails round the sides and the foot, on a plinth ----
  const railH = L.railTop - PLINTH_H;
  const rtop = Math.min(RAIL_W / 2, railH / 2);
  const rprof = [[-RAIL_W / 2, 0], [RAIL_W / 2, 0]];
  const rSeg = full ? 4 : 2;
  for (let i = 0; i <= rSeg; i++) {
    const th = i / rSeg * Math.PI;
    rprof.push([rtop * Math.cos(th) * (RAIL_W / 2 / rtop), railH - rtop + rtop * Math.sin(th)]);
  }
  // path walked from the back-left, down the left side, across the foot and
  // back up the right: its RIGHT-hand side is... inward, so flip `a`.
  const rx = W / 2 - RAIL_W / 2, rz = D - RAIL_W / 2, rc = 6;
  const rpath = [[-rx, HEAD_T]];
  const cSeg = full ? 3 : 1;
  for (let i = 0; i <= cSeg; i++) {
    const th = Math.PI - i / cSeg * Math.PI / 2;
    rpath.push([-rx + rc + rc * Math.cos(th), rz - rc + rc * Math.sin(th)]);
  }
  for (let i = 0; i <= cSeg; i++) {
    const th = Math.PI / 2 - i / cSeg * Math.PI / 2;
    rpath.push([rx - rc + rc * Math.cos(th), rz - rc + rc * Math.sin(th)]);
  }
  rpath.push([rx, HEAD_T]);
  const railGeo = sweep(THREE, rprof.map(([a, b]) => [m(-a), m(b)]).reverse(), rpath.map(([x, z]) => [m(x), m(z)]),
    { plane: 'xz' });
  add(railGeo, railMat, 'rail', 0, m(PLINTH_H), 0);
  add(new THREE.BoxGeometry(m(W - 8), m(PLINTH_H), m(D - HEAD_T - 6)), plinthMat, 'plinth',
    0, m(PLINTH_H / 2), m(HEAD_T + (D - HEAD_T - 6) / 2));

  // ---- mattress, in its fitted sheet -----------------------------------------
  const mw = 2 * L.mattHalfW, ml = L.zFoot - L.zHead;
  const crown = v => {
    if (v.y <= 0) return;
    const fx = Math.max(0, 1 - Math.pow(v.x / (mw * CM / 2), 2));
    const fz = Math.max(0, 1 - Math.pow(v.z / (ml * CM / 2), 2));
    v.y += m(CROWN) * fx * fz * Math.min(1, v.y / m(L.mattH / 2));
  };
  // The bottom face sits inside the rails, on the plinth: nobody can see it.
  const mattGeo = roundedBox(THREE, m(mw), m(L.mattH), m(ml), m(SHEET_R),
    full ? { bevel: 2, inner: [2, 1, 2], omit: ['-y'], displace: crown } : { bevel: 1, inner: [2, 1, 2], omit: ['-y'], displace: crown });
  add(mattGeo, sheetMat, 'mattress', 0, m(L.mattBottom + L.mattH / 2), m(L.zHead + ml / 2));

  // ---- pillows -----------------------------------------------------------------
  // Made up the way the bed is actually dressed: the accent pillows stand at
  // the back, propped against the headboard; the two sleeping pillows lie
  // flat in front of them, side by side; the cushion leans on the sleeping
  // pillows in the middle.
  //
  // HEIGHT: the propped pillows are sized to the headboard, not fixed. Their
  // tops aim for pillowTops(p).accent -- ~32 cm above the mattress, but
  // always leaving HEAD_SHOW of headboard above them -- so the channels show
  // (they used to reach ~103 of 120 and hide them), and on a low headboard
  // nothing pokes above `height`. Each is solved on its own rotated vertices:
  // the length shrinks first (so the pillow's footprint never creeps forward
  // into the duvet), then the lean.
  const pw = Math.min(72, (mw - 4) / 2), pd = 50, ph = 12;
  const pSeg = full ? 4 : 2;
  const pillowGeo = pillow(THREE, m(pw), m(ph), m(pd), pSeg);
  const pillowY = L.mattTop + CROWN * 0.6 + ph / 2 - 0.5;
  const tops = pillowTops(p);
  let sleepZ0 = L.zHead + 2;                                  // the sleeping pillows' head end
  if (full) {
    const aw = Math.min(62, (mw - 8) / 2), ah = 12;
    const baseY = L.mattTop + 2;
    const acc = solveProp(THREE, (len) => pillow(THREE, m(aw), m(ah), m(len), 4), baseY, tops.accent,
      { lean: ACCENT_LEAN, len: ACCENT_LEN, minLen: 22, minLean: 5 * Math.PI / 180 });
    const accentFoot = L.zHead + 2 + Math.cos(acc.lean) * acc.len;   // where it meets the mattress
    sleepZ0 = accentFoot - 6;
    for (const sx of [-1, 1]) {
      const mesh = add(acc.geo, accentMat, 'accent-pillow',
        m(sx * (aw / 2 + 1.5)), m(baseY + Math.sin(acc.lean) * acc.len / 2), m(accentFoot - Math.cos(acc.lean) * acc.len / 2));
      mesh.rotation.x = -(Math.PI - acc.lean);
    }
    // the cushion, centred, leaning on the sleeping pillows: faux fur (a
    // lumpy body and a coat of strands, see addFur)
    const cBase = L.mattTop + 3;
    const cush = solveProp(THREE, (len) => furCushion(THREE, m(len), m(14), m(len)), cBase, tops.cushion,
      { lean: CUSHION_LEAN, len: CUSHION_LEN, minLen: 32, minLean: 5 * Math.PI / 180 });
    const cFoot = sleepZ0 + pd + 4;
    const cmesh = add(cush.geo, cushionMat, 'cushion',
      0, m(cBase + Math.sin(cush.lean) * cush.len / 2), m(cFoot - Math.cos(cush.lean) * cush.len / 2));
    cmesh.rotation.x = -(Math.PI - cush.lean);
    addFur(THREE, cmesh, cush.geo, p.cushionColor, add);
  }
  for (const sx of [-1, 1]) {
    add(pillowGeo, pillowMat, 'pillow', m(sx * (pw / 2 + 1)), m(pillowY), m(sleepZ0 + pd / 2));
  }

  // ---- duvet ---------------------------------------------------------------------
  if (p.duvet) {
    const Dv = duvetMap(p);
    const sSeg = full ? { flat: 6, roll: 3, drop: 2 } : { flat: 2, roll: 1, drop: 1 };
    const sHalf = joinLists(lin(0, Dv.s0, sSeg.flat / 2), lin(Dv.s0, Dv.s0 + Dv.rollLen, sSeg.roll),
      lin(Dv.s0 + Dv.rollLen, Dv.sMax, sSeg.drop));
    const sList = sHalf.slice(1).reverse().map(v => -v).concat(sHalf);
    const tList = full
      ? joinLists(lin(0, Dv.tCurl, 4), lin(Dv.tCurl, Dv.tBand, 2), lin(Dv.tBand, Dv.tStep, 1),
        lin(Dv.tStep, Dv.tMain, 5), lin(Dv.tMain, Dv.tRoll, 3), lin(Dv.tRoll, Dv.tMax, 2))
      : joinLists(lin(0, Dv.tCurl, 2), lin(Dv.tCurl, Dv.tBand, 1), lin(Dv.tBand, Dv.tStep, 1),
        lin(Dv.tStep, Dv.tMain, 2), lin(Dv.tMain, Dv.tRoll, 1), lin(Dv.tRoll, Dv.tMax, 1));
    const mapM = (s, t) => { const q = Dv.map(s, t); return { x: m(q.x), y: m(q.y), z: m(q.z) }; };
    const duvetGeo = clothSheet(THREE, mapM, sList, tList);
    // hem: a strip turning in under the free edges (both sides and the foot),
    // so the hanging edge reads as a thick, filled duvet rather than a sheet.
    const hemPos = [], hemIdx = [];
    const hemT = 3;
    function hemEdge(pts, inward) {
      const base = hemPos.length / 3;
      for (const q of pts) {
        hemPos.push(m(q.x), m(q.y), m(q.z));
        hemPos.push(m(q.x + inward[0] * hemT), m(q.y + 0.4), m(q.z + inward[1] * hemT));
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, e = a + 3;
        hemIdx.push(a, c, b, b, c, e);
      }
    }
    // left edge runs +z (t increasing); right edge and foot are walked so each
    // strip's outer edge -> inner edge winding faces down/out.
    hemEdge(tList.map(t => Dv.map(-Dv.sMax, t)), [1, 0]);
    hemEdge(tList.slice().reverse().map(t => Dv.map(Dv.sMax, t)), [-1, 0]);
    hemEdge(sList.map(s => Dv.map(s, Dv.tMax)), [0, -1]);
    const hemGeo = new THREE.BufferGeometry();
    hemGeo.setAttribute('position', new THREE.Float32BufferAttribute(hemPos, 3));
    hemGeo.setIndex(hemIdx);
    hemGeo.computeVertexNormals();
    add(concatGeometries(THREE, [duvetGeo, hemGeo]), duvetMat, 'duvet');

    if (full && p.beddingPreset !== 'plain') addPrint(THREE, Dv, add, m);
  }

  // ---- overall bbox: bottom at y=0, back at z=0, x centred -------------------
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const shiftX = -(box.min.x + box.max.x) / 2;
  const shiftY = -box.min.y;
  const shiftZ = -box.min.z;
  if (Math.abs(shiftX) > 1e-6 || Math.abs(shiftY) > 1e-6 || Math.abs(shiftZ) > 1e-6) {
    group.children.forEach(c => {
      c.position.x += shiftX;
      c.position.y += shiftY;
      c.position.z += shiftZ;
    });
    group.updateMatrixWorld(true);
  }

  group.userData = { type: TYPE, params: p, detail: full ? 'full' : 'low' };
  return group;
}

/**
 * The botanical print, a dense WILDFLOWER scatter: stemmed daisies (a thin
 * stem, 1 triangle, topped by a nine-petal head of three overlapping
 * triangles), small six-point florets (2 triangles) and grass-like leaf
 * blades (1 triangle),
 * placed by a seeded PRNG over the duvet's cloth coordinates -- the top, the
 * drapes and the folded-back band, not the curl. Every vertex goes through
 * the duvet's own map and is lifted along the cloth normal, so the print
 * follows every fold. One mesh per colour, each colour on its own lift (a
 * little over 1 mm apart) so two colours can never z-fight where motifs
 * overlap -- and two colours are never placed overlapping at all. The motifs
 * are cheap on purpose: ~95 flowers in ~340 triangles, where the old
 * four-point stars spent 4 triangles each on 30.
 */
export const PRINT_COUNTS = Object.freeze({ sprigs: 52, blossoms: 44, blades: 58 });
const PRINT_LIFT = Object.freeze({
  leafOlive: 0.35, leafSage: 0.46, flowerBlue: 0.57, flowerYellow: 0.68, flowerPink: 0.79, flowerRose: 0.9
});
function addPrint(THREE, Dv, add, m) {
  const rnd = prng(0x5eed);
  const eps = 0.5;
  function clothNormal(s, t) {
    const a = Dv.map(s + eps, t), b = Dv.map(s - eps, t), c = Dv.map(s, t + eps), d = Dv.map(s, t - eps);
    const ds = [a.x - b.x, a.y - b.y, a.z - b.z], dt = [c.x - d.x, c.y - d.y, c.z - d.z];
    // cross(dt, ds) points out of the cloth (see soft.js clothSheet)
    const n = [dt[1] * ds[2] - dt[2] * ds[1], dt[2] * ds[0] - dt[0] * ds[2], dt[0] * ds[1] - dt[1] * ds[0]];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / nl, n[1] / nl, n[2] / nl];
  }
  // Lifted off the cloth, but never past the duvet's own envelope clamp (a
  // motif on a side drape is lifted outward, towards the rail's face).
  const xLim = Dv.L.W / 2 - 0.3, zLim = Dv.L.D - 0.3;
  function lifted(s, t, lift) {
    const q = Dv.map(s, t), n = clothNormal(s, t);
    const x = Math.max(-xLim, Math.min(xLim, q.x + n[0] * lift));
    return [m(x), m(q.y + n[1] * lift), m(Math.min(zLim, q.z + n[2] * lift))];
  }
  const buckets = {};
  for (const k of Object.keys(PRINT_COLORS)) buckets[k] = [];
  // A triangle in (s, t) faces out when its 2D winding is clockwise. Each
  // motif's triangles are staged, then kept only if every one of them lies
  // flat on the cloth and faces out of it -- a motif straddling the band's
  // hem step or a foot corner (where the drop is clamped at the rail top and
  // the cloth folds) is discarded and another placed instead.
  let pending = [], pendingOk = true;
  // Motifs of DIFFERENT colours never overlap (tested in cloth coordinates,
  // with a 2 mm margin): the colours sit on separate lifts, but a big flat
  // triangle on a curved cloth can still come within a millimetre of its
  // neighbour's plane, and two colours in one plane z-fight.
  const placed = [];                           // [{ key, pts: [[s,t] x3] }]
  const sepAxis = (A, B) => {
    for (const P of [A, B]) {
      for (let i = 0; i < 3; i++) {
        const a = P[i], b = P[(i + 1) % 3];
        const nx = b[1] - a[1], ny = a[0] - b[0];
        const len = Math.hypot(nx, ny) || 1;
        const pa = A.map(q => q[0] * nx + q[1] * ny), pb = B.map(q => q[0] * nx + q[1] * ny);
        if (Math.min(...pa) > Math.max(...pb) + 0.2 * len || Math.min(...pb) > Math.max(...pa) + 0.2 * len) return true;
      }
    }
    return false;
  };
  const clashes = (key, pts) => placed.some(q => q.key !== key && !sepAxis(q.pts, pts));
  // The hem step below the folded-back band is one grid segment over a
  // cosine drop, so there the drawn duvet runs up to ~6 mm ABOVE the cloth
  // map the print follows: a motif touching it would sink into the duvet.
  // Likewise keep motifs off the places the cloth is clamped or folded,
  // where the coarse duvet grid can run above the map: the side drapes of
  // the folded-back band, the hem where the drop is clamped at the rail top,
  // and the envelope clamp at the sides and foot.
  const stepLo = Dv.tBand - 1, stepHi = Dv.tStep + 2;
  const floorY = Dv.L.railTop + 0.5;
  const onCleanCloth = q => {
    if (q[1] > stepLo && q[1] < stepHi) return false;
    if (q[1] <= stepHi && Math.abs(q[0]) > Dv.s0 + Dv.rollLen / 2) return false;
    const c = Dv.map(q[0], q[1]);
    return c.y > floorY + 1.5 && Math.abs(c.x) < Dv.L.W / 2 - 1.3 && c.z < Dv.L.D - 1.3;
  };
  function tri(key, p0, p1, p2) {
    const lift = PRINT_LIFT[key];
    if (!onCleanCloth(p0) || !onCleanCloth(p1) || !onCleanCloth(p2) || clashes(key, [p0, p1, p2])) pendingOk = false;
    const cr = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    const [a, b, c] = cr < 0 ? [p0, p1, p2] : [p0, p2, p1];
    const A = lifted(a[0], a[1], lift), B = lifted(b[0], b[1], lift), C = lifted(c[0], c[1], lift);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const nl = Math.hypot(n[0], n[1], n[2]);
    const cn = clothNormal((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3);
    if (!(nl > 1e-12) || (n[0] * cn[0] + n[1] * cn[1] + n[2] * cn[2]) / nl < 0.7) pendingOk = false;
    pending.push([key, A, B, C, [p0, p1, p2]]);
  }
  const sLo = -Dv.sMax + 4, sHi = Dv.sMax - 4, tLo = Dv.tCurl + 3, tHi = Dv.tMax - 4;
  const place = (count, fn) => {
    let kept = 0;
    for (let tries = 0; kept < count && tries < count * 6; tries++) {
      pending = []; pendingOk = true;
      fn(sLo + rnd() * (sHi - sLo), tLo + rnd() * (tHi - tLo), rnd() * Math.PI * 2, rnd());
      if (!pendingOk) continue;
      for (const [key, A, B, C, pts] of pending) { buckets[key].push(A, B, C); placed.push({ key, pts }); }
      kept++;
    }
  };
  const at = (s, t, ang, r) => [s + r * Math.cos(ang), t + r * Math.sin(ang)];
  const FLOWERS = ['flowerPink', 'flowerRose', 'flowerYellow', 'flowerBlue'];
  const flowerKey = r => FLOWERS[Math.min(FLOWERS.length - 1, Math.floor(r * FLOWERS.length))];
  // A blossom of k triangles, each turned 120/k degrees on the last: k = 3
  // is a nine-petal daisy, k = 2 a small six-point floret. Its notches (the
  // points between petals) sit at radius notchR(k) * R, at ang + 60/k deg.
  const notchR = k => 0.5 / Math.cos(Math.PI / (3 * k));
  const blossom = (key, s, t, ang, R, k) => {
    for (let i = 0; i < k; i++) {
      const a0 = ang + i * 2 * Math.PI / (3 * k);
      tri(key, at(s, t, a0, R), at(s, t, a0 + 2 * Math.PI / 3, R), at(s, t, a0 + 4 * Math.PI / 3, R));
    }
  };
  // a thin tapering blade from (s, t) along `ang`
  const blade = (key, s, t, ang, len, wid) => {
    const perp = ang + Math.PI / 2;
    tri(key, at(s, t, perp, wid / 2), at(s, t, perp, -wid / 2), at(s, t, ang, len));
  };
  // Stemmed daisies. The stem stops just short of a notch of the head, and
  // that notch is turned to face back down the stem, so stem and head never
  // overlap.
  place(PRINT_COUNTS.sprigs, (s, t, ang, r) => {
    const len = 7 + r * 6, R = 3.4 + ((r * 7.3) % 1) * 1.6;
    blade(r < 0.5 ? 'leafSage' : 'leafOlive', s, t, ang, len, 1.0);
    const [hs, ht] = at(s, t, ang, len + notchR(3) * R + 0.15);
    blossom(flowerKey((r * 13.7) % 1), hs, ht, ang + Math.PI - Math.PI / 9, R, 3);
  });
  // loose florets, smaller
  place(PRINT_COUNTS.blossoms, (s, t, ang, r) => blossom(flowerKey(r), s, t, ang, 2.2 + r * 1.2, 2));
  place(PRINT_COUNTS.blades, (s, t, ang, r) => blade(r < 0.55 ? 'leafSage' : 'leafOlive', s, t, ang, 9 + r * 7, 2.8));
  for (const key of Object.keys(buckets)) {
    const verts = buckets[key];
    if (!verts.length) continue;
    const pos = [];
    verts.forEach(v => pos.push(v[0], v[1], v[2]));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    add(g, makeFinish(THREE, 'matte', PRINT_COLORS[key]), 'print-' + key);
  }
}

export const buildBed = build;

/** Only the params that differ from DEFAULTS -- the furniture JSON shape. */
export function toFurnitureJSON(params) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (params && params[k] !== undefined && params[k] !== DEFAULTS[k]) out[k] = params[k];
  }
  return { type: TYPE, params: out };
}
