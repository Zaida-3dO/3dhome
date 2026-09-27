/**
 * sofa.js - single-type module: `sofa`.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0, and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 * See docs/house-profile.md, "Furniture", and PR7 of
 * plan-furniture-system-r2.md.
 *
 * A corner (L-shaped) sofa: soft fabric seat and back cushions on a
 * contrasting plinth base, a low arm at the non-chaise end (a plinth-coloured
 * box with a padded fabric top), and a chaise that runs forward to the full
 * `depth` on the chaise side, with no arm and no back on its outer end. The
 * back cushions run the full length of the back, behind the chaise too.
 * `chaise: 'none'` is a straight sofa with an arm at BOTH ends; its depth is
 * the whole `depth` (a caller making a straight sofa sets depth = seatDepth).
 *
 * `chaise` is named as seen from the FRONT: +x is the viewer's right, so
 * 'right' puts the chaise at +x.
 *
 * Every size is clamped so ANY params build to exactly width x depth x height
 * (the contract's bbox), whatever the individual part sizes say.
 *
 * No real measurements, no house-specific placement: a generic,
 * publishable corner-sofa shape only.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

export const TYPE = 'sofa';

/** Defaults, in cm. An ordinary retail corner sofa. */
export const DEFAULTS = Object.freeze({
  width: 275,
  depth: 197,             // front of the chaise; the main leg is seatDepth deep
  height: 88,             // floor to the top of the back cushions
  chaise: 'right',        // 'right' | 'left' | 'none', seen from the front
  seatDepth: 97,          // depth of the main (non-chaise) leg
  chaiseWidth: 105,
  seatHeight: 44,         // floor to the top of the seat cushions
  baseHeight: 24,         // floor to the top of the plinth
  backDepth: 22,          // back cushion thickness (z)
  armWidth: 20,
  armHeight: 64,          // floor to the top of the arm pad
  cushions: 3,            // seat cushions across the main leg (1..4)
  upholsteryColor: '#1e1e20',
  baseColor: '#ecebe7',
  baseFinish: 'satin'
});

const CM = 0.01;
const CHAISE_SIDES = ['right', 'left', 'none'];

function resolveParams(params) {
  return Object.assign({}, DEFAULTS, params || {});
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/**
 * A soft rounded box, w x h x d exactly (metres), centred on the origin, the
 * rounded outline in the XY plane and the bevel on the two Z faces (the same
 * pattern as gaming-chair.js). The bevel grows the outline by bevelSize and
 * the depth by 2 x bevelThickness, so both are subtracted first.
 */
function roundedBox(THREE, w, h, d, r, seg) {
  const bevel = seg > 1 ? Math.min(r * 0.6, d * 0.3) : 0;
  const bs = bevel * 0.8;
  w -= 2 * bs; h -= 2 * bs;
  r = Math.max(1e-4, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4));
  const s = new THREE.Shape();
  const x0 = -w / 2, y0 = -h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0);
  s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + h - r);
  s.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  s.lineTo(x0 + r, y0 + h);
  s.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(1e-4, d - 2 * bevel), curveSegments: seg,
    bevelEnabled: seg > 1, bevelThickness: bevel, bevelSize: bs, bevelSegments: Math.max(1, seg - 1)
  });
  g.center();
  return g;
}

/**
 * Build the sofa.
 * @param {Object} THREE
 * @param {Object} [params]  overrides for DEFAULTS
 * @param {{detail?: 'full'|'low'}} [opts]  'low' draws every part as a plain box
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const p = resolveParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';
  const side = CHAISE_SIDES.indexOf(p.chaise) !== -1 ? p.chaise : DEFAULTS.chaise;

  // ---- clamped sizes, cm ---------------------------------------------------
  const W = Math.max(40, num(p.width, DEFAULTS.width));
  const D = Math.max(30, num(p.depth, DEFAULTS.depth));
  const H = Math.max(20, num(p.height, DEFAULTS.height));
  const armW = clamp(num(p.armWidth, DEFAULTS.armWidth), 4, W * 0.25);
  // The main leg: the whole depth for a straight sofa, otherwise seatDepth
  // (never deeper than the envelope, never so shallow the seat vanishes).
  const mainD = side === 'none' ? D : clamp(num(p.seatDepth, DEFAULTS.seatDepth), Math.min(30, D), D);
  const chaiseW = side === 'none' ? 0 : clamp(num(p.chaiseWidth, DEFAULTS.chaiseWidth), 20, W - armW - 20);
  const backD = clamp(num(p.backDepth, DEFAULTS.backDepth), 4, mainD * 0.5);
  const baseH = clamp(num(p.baseHeight, DEFAULTS.baseHeight), 2, H * 0.8);
  const seatH = clamp(num(p.seatHeight, DEFAULTS.seatHeight), baseH + 2, H - 1);
  const armH = clamp(num(p.armHeight, DEFAULTS.armHeight), baseH + 4, H);
  const padT = Math.min(11, (armH - baseH) * 0.45);
  const nSeat = Math.max(1, Math.min(4, Math.round(num(p.cushions, DEFAULTS.cushions))));

  // Plan x ranges (cm, x centred). sgn: +1 chaise on the right (+x), -1 left.
  const sgn = side === 'left' ? -1 : 1;
  const xL = -W / 2, xR = W / 2;
  const armSides = side === 'none' ? [-1, 1] : [-sgn];
  // Main-leg seat run, between the arm(s) and the chaise's inner edge.
  let seatA, seatB;
  if (side === 'none') { seatA = xL + armW; seatB = xR - armW; }
  else if (sgn > 0) { seatA = xL + armW; seatB = xR - chaiseW; }
  else { seatA = xL + chaiseW; seatB = xR - armW; }
  // Chaise run (plan x).
  const chaiseA = sgn > 0 ? xR - chaiseW : xL;
  const chaiseB = sgn > 0 ? xR : xL + chaiseW;
  // Back run: from the inner face of the arm(s) to the far end (behind the chaise).
  const backA = armSides.indexOf(-1) !== -1 ? xL + armW : xL;
  const backB = armSides.indexOf(1) !== -1 ? xR - armW : xR;

  const group = new THREE.Group();
  group.name = 'furniture:sofa';

  const fabric = makeFinish(THREE, 'matte', p.upholsteryColor);
  const baseMat = makeFinish(THREE, p.baseFinish, p.baseColor);

  const seg = full ? 3 : 1;
  const crease = full ? 0.8 : 0;   // cm between neighbouring cushions

  /**
   * One part, given as a cm box [x0,x1] x [y0,y1] x [z0,z1]. `kind`:
   *   'slab'  rounded in plan, bevelled top/bottom (seat cushions, pads, plinth)
   *   'panel' rounded in elevation, bevelled front/back (back cushions, arm body)
   */
  function part(name, mat, x0, x1, y0, y1, z0, z1, kind, r, sg) {
    const k = sg || seg;
    const w = (x1 - x0) * CM, h = (y1 - y0) * CM, d = (z1 - z0) * CM;
    let geo;
    if (!full) geo = new THREE.BoxGeometry(w, h, d);
    else if (kind === 'slab') {
      geo = roundedBox(THREE, w, d, h, r * CM, k);
      geo.rotateX(-Math.PI / 2);                  // extrusion (thickness) -> y
    } else {
      geo = roundedBox(THREE, w, h, d, r * CM, k);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.position.set((x0 + x1) / 2 * CM, (y0 + y1) / 2 * CM, (z0 + z1) / 2 * CM);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }

  // ---- plinth: under the main leg, and forward under the chaise ------------
  part('plinth', baseMat, xL, xR, 0, baseH, 0, mainD, 'slab', 3, 2);
  if (side !== 'none' && D > mainD) {
    // The chaise plinth overlaps the main one by a few cm so no seam shows.
    part('plinthChaise', baseMat, chaiseA, chaiseB, 0, baseH, mainD - 4, D, 'slab', 3, 2);
  }

  // ---- arms: plinth-coloured box topped with a padded fabric slab ----------
  for (const s of armSides) {
    const a = s < 0 ? xL : xR - armW;
    const b = s < 0 ? xL + armW : xR;
    const tag = s < 0 ? 'L' : 'R';
    // The body sits a little inside the pad's outline, so the pad overhangs.
    const inset = Math.min(1, armW * 0.1);
    const bodyA = s < 0 ? a + inset : a, bodyB = s < 0 ? b : b - inset;
    part('armBody_' + tag, baseMat, bodyA, bodyB, 0, armH - padT, 0, mainD - inset, 'panel', 3, 2);
    part('armPad_' + tag, fabric, a, b, armH - padT, armH, 0, mainD, 'slab', Math.min(6, armW * 0.3));
  }

  // ---- back cushions, the full back length ---------------------------------
  // One per main-leg seat cushion, plus one behind the chaise.
  const backCuts = [];
  const seatStep = (seatB - seatA) / nSeat;
  if (side === 'none' || sgn > 0) {
    for (let i = 0; i <= nSeat; i++) backCuts.push(seatA + i * seatStep);
    if (side !== 'none') backCuts.push(backB);
    backCuts[0] = backA;
  } else {
    backCuts.push(backA);
    for (let i = 0; i <= nSeat; i++) backCuts.push(seatA + i * seatStep);
    backCuts[backCuts.length - 1] = backB;
  }
  for (let i = 0; i + 1 < backCuts.length; i++) {
    const a = backCuts[i] + (i > 0 ? crease / 2 : 0);
    const b = backCuts[i + 1] - (i + 2 < backCuts.length ? crease / 2 : 0);
    part('backCushion_' + i, fabric, a, b, baseH, H, 0, backD, 'panel', 8);
  }

  // ---- seat cushions -------------------------------------------------------
  for (let i = 0; i < nSeat; i++) {
    const a = seatA + i * seatStep + (i > 0 ? crease / 2 : 0);
    const b = seatA + (i + 1) * seatStep - (i + 1 < nSeat || side !== 'none' ? crease / 2 : 0);
    part('seatCushion_' + i, fabric, a, b, baseH, seatH, backD, mainD, 'slab', 6);
  }
  if (side !== 'none') {
    const a = sgn > 0 ? chaiseA + crease / 2 : chaiseA;
    const b = sgn > 0 ? chaiseB : chaiseB - crease / 2;
    part('chaiseCushion', fabric, a, b, baseH, seatH, backD, D, 'slab', 6);
  }

  // ---- normalise the frame (defensive; every part is authored on it) -------
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const shiftX = -(box.min.x + box.max.x) / 2, shiftY = -box.min.y, shiftZ = -box.min.z;
  if (Math.abs(shiftX) > 1e-6 || Math.abs(shiftY) > 1e-6 || Math.abs(shiftZ) > 1e-6) {
    group.children.forEach(c => { c.position.x += shiftX; c.position.y += shiftY; c.position.z += shiftZ; });
    group.updateMatrixWorld(true);
  }

  group.userData = { type: TYPE, params: p, detail: full ? 'full' : 'low' };
  return group;
}

export const buildSofa = build;

/** Only the params that differ from DEFAULTS -- the furniture JSON shape. */
export function toFurnitureJSON(params) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (params && params[k] !== undefined && params[k] !== DEFAULTS[k]) out[k] = params[k];
  }
  return { type: TYPE, params: out };
}
