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
 *     rail tops, its top edge folded back; sleeping pillows against the
 *     headboard, accent pillows propped against those, and a cushion.
 *     `beddingPreset: 'botanical'` scatters a leaf-and-flower print over the
 *     duvet cover; 'plain' leaves it plain.
 *
 * THE PRINT IS GEOMETRY, NOT A TEXTURE. Each leaf and flower is a few
 * triangles placed through the same cloth map as the duvet, lifted a few
 * millimetres off it, so it follows the roll, the drape and the fold. All
 * motifs of one colour are one mesh on a plain `matte` material, so the room
 * merge folds them into the matte bucket it already draws -- no texture, no
 * new material kind, no image of anything.
 *
 * Soft forms come from ./soft.js (rounded boxes, pillows, swept rails, cloth).
 * Budget (TRIANGLE_CAPS): 2,500 full / 800 low. Low detail keeps the shape --
 * headboard, rails, mattress, a plain duvet with its fold, two pillows -- on
 * coarser grids, and drops the print, the accent pillows and the cushion.
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

/** The print's colours: sage and olive leaves, dusty-blue and pink flowers. */
export const PRINT_COLORS = Object.freeze({
  leafSage: '#9cae86',
  leafOlive: '#6f7f4e',
  flowerBlue: '#8fa3bf',
  flowerPink: '#d8a3a6'
});

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
  const bpath = [[-cx, hbBottom]];
  for (let i = 0; i <= arcSeg + 1; i++) {
    const th = Math.PI - i / (arcSeg + 1) * Math.PI / 2;
    bpath.push([-cx + cr + cr * Math.cos(th), cy - cr + cr * Math.sin(th)]);
  }
  for (let i = 0; i <= arcSeg + 1; i++) {
    const th = Math.PI / 2 - i / (arcSeg + 1) * Math.PI / 2;
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
  const mattGeo = roundedBox(THREE, m(mw), m(L.mattH), m(ml), m(SHEET_R),
    full ? { bevel: 2, inner: [2, 1, 2], displace: crown } : { bevel: 1, inner: [2, 1, 2], displace: crown });
  add(mattGeo, sheetMat, 'mattress', 0, m(L.mattBottom + L.mattH / 2), m(L.zHead + ml / 2));

  // ---- pillows -----------------------------------------------------------------
  // Made up the way the bed is actually dressed: the accent pillows stand at
  // the back, propped at ~60 degrees against the headboard; the two sleeping
  // pillows lie flat in front of them, side by side; the cushion leans on the
  // sleeping pillows in the middle.
  const pw = Math.min(72, (mw - 4) / 2), pd = 50, ph = 12;
  const pSeg = full ? 4 : 2;
  const lean = 60 * Math.PI / 180;
  const ad = 45;
  const accentFoot = L.zHead + 2 + Math.cos(lean) * ad;   // where a propped pillow meets the mattress
  const sleepZ0 = full ? accentFoot - 6 : L.zHead + 2;      // the sleeping pillows' head end
  const pillowGeo = pillow(THREE, m(pw), m(ph), m(pd), pSeg);
  const pillowY = L.mattTop + CROWN * 0.6 + ph / 2 - 0.5;
  for (const sx of [-1, 1]) {
    add(pillowGeo, pillowMat, 'pillow', m(sx * (pw / 2 + 1)), m(pillowY), m(sleepZ0 + pd / 2));
  }
  if (full) {
    const aw = Math.min(62, (mw - 8) / 2), ah = 12;
    const accGeo = pillow(THREE, m(aw), m(ah), m(ad), 4);
    const baseY = L.mattTop + 2;
    for (const sx of [-1, 1]) {
      const mesh = add(accGeo, accentMat, 'accent-pillow',
        m(sx * (aw / 2 + 1.5)), m(baseY + Math.sin(lean) * ad / 2), m(accentFoot - Math.cos(lean) * ad / 2));
      mesh.rotation.x = -(Math.PI - lean);
    }
    // the cushion, centred, leaning on the sleeping pillows
    const cw = 45;
    const cushGeo = pillow(THREE, m(cw), m(14), m(cw), 4);
    const cl = 62 * Math.PI / 180;
    const cFoot = sleepZ0 + pd + 4;
    const cmesh = add(cushGeo, cushionMat, 'cushion',
      0, m(L.mattTop + 3 + Math.sin(cl) * cw / 2), m(cFoot - Math.cos(cl) * cw / 2));
    cmesh.rotation.x = -(Math.PI - cl);
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
 * The botanical print: leaves (a 2-triangle lens) and flowers (two crossed
 * diamonds, 4 triangles) scattered by a seeded PRNG over the duvet's cloth
 * coordinates -- the top, the drapes and the folded-back band, not the curl.
 * Every vertex goes through the duvet's own map and is lifted along the
 * cloth normal, so the print follows every fold. One mesh per colour.
 */
function addPrint(THREE, Dv, add, m) {
  const rnd = prng(0x5eed);
  const lift = 0.35;
  const eps = 0.5;
  function clothNormal(s, t) {
    const a = Dv.map(s + eps, t), b = Dv.map(s - eps, t), c = Dv.map(s, t + eps), d = Dv.map(s, t - eps);
    const ds = [a.x - b.x, a.y - b.y, a.z - b.z], dt = [c.x - d.x, c.y - d.y, c.z - d.z];
    const n = [dt[1] * ds[2] - dt[2] * ds[1], dt[2] * ds[0] - dt[0] * ds[2], dt[0] * ds[1] - dt[1] * ds[0]];
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / nl, n[1] / nl, n[2] / nl];
  }
  function lifted(s, t) {
    const q = Dv.map(s, t);
    const a = Dv.map(s + eps, t), b = Dv.map(s - eps, t), c = Dv.map(s, t + eps), d = Dv.map(s, t - eps);
    // cross(dt, ds) points out of the cloth (see soft.js clothSheet)
    const ds = [a.x - b.x, a.y - b.y, a.z - b.z], dt = [c.x - d.x, c.y - d.y, c.z - d.z];
    let nx = dt[1] * ds[2] - dt[2] * ds[1], ny = dt[2] * ds[0] - dt[0] * ds[2], nz = dt[0] * ds[1] - dt[1] * ds[0];
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    return [m(q.x + nx * lift), m(q.y + ny * lift), m(q.z + nz * lift)];
  }
  const buckets = { leafSage: [], leafOlive: [], flowerBlue: [], flowerPink: [] };
  // A triangle in (s, t) faces out when its 2D winding is clockwise. Each
  // motif's triangles are staged, then kept only if every one of them lies
  // flat on the cloth and faces out of it -- a motif straddling the band's
  // hem step or a foot corner (where the drop is clamped at the rail top and
  // the cloth folds) is discarded and another placed instead.
  let pending = [], pendingOk = true;
  function tri(list, p0, p1, p2) {
    const cr = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    const [a, b, c] = cr < 0 ? [p0, p1, p2] : [p0, p2, p1];
    const A = lifted(a[0], a[1]), B = lifted(b[0], b[1]), C = lifted(c[0], c[1]);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const nl = Math.hypot(n[0], n[1], n[2]);
    const cn = clothNormal((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3);
    if (!(nl > 1e-12) || (n[0] * cn[0] + n[1] * cn[1] + n[2] * cn[2]) / nl < 0.7) pendingOk = false;
    pending.push([list, A, B, C]);
  }
  const sLo = -Dv.sMax + 4, sHi = Dv.sMax - 4, tLo = Dv.tCurl + 3, tHi = Dv.tMax - 4;
  const place = (count, fn) => {
    let kept = 0;
    for (let tries = 0; kept < count && tries < count * 6; tries++) {
      pending = []; pendingOk = true;
      fn(sLo + rnd() * (sHi - sLo), tLo + rnd() * (tHi - tLo), rnd() * Math.PI * 2, rnd());
      if (!pendingOk) continue;
      for (const [list, A, B, C] of pending) list.push(A, B, C);
      kept++;
    }
  };
  const rot = (s, t, ang, u, w) => [s + u * Math.cos(ang) - w * Math.sin(ang), t + u * Math.sin(ang) + w * Math.cos(ang)];
  // leaf sprigs: 4 leaves alternating along a short stem
  const leaf = (list, s, t, ang, len) => {
    const wid = len * 0.36;
    const A = rot(s, t, ang, 0, 0), B = rot(s, t, ang, len / 2, wid / 2), C = rot(s, t, ang, len, 0), E = rot(s, t, ang, len / 2, -wid / 2);
    tri(list, A, B, C); tri(list, A, C, E);
  };
  place(26, (s, t, ang, r) => {
    const list = r < 0.55 ? buckets.leafSage : buckets.leafOlive;
    for (let k = 0; k < 4; k++) {
      const along = k * 3.2;
      const side = k % 2 ? 1 : -1;
      const [ls, lt] = rot(s, t, ang, along, 0);
      leaf(list, ls, lt, ang + side * 0.75, 6 + r * 3);
    }
  });
  // flowers: ~5 cm across, two crossed diamonds
  place(30, (s, t, ang, r) => {
    const list = r < 0.55 ? buckets.flowerBlue : buckets.flowerPink;
    const R = 2.2 + r * 1.0, w = R * 0.5;
    for (const a2 of [ang, ang + Math.PI / 2]) {
      const A = rot(s, t, a2, -R, 0), B = rot(s, t, a2, 0, w), C = rot(s, t, a2, R, 0), E = rot(s, t, a2, 0, -w);
      tri(list, A, B, C); tri(list, A, C, E);
    }
  });
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
