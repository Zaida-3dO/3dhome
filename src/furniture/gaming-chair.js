/**
 * gaming-chair.js - a racing-style gaming chair, procedural and low-poly.
 *
 * Default dimensions are a typical large ("L") racing-style chair, taken from
 * published manufacturer figures for that class of chair (estimates flagged
 * inline). Nothing here is measured from a real room; the chair is a
 * stand-alone piece of furniture.
 *
 * COLOUR PLACEMENT (the usual racing-chair two-tone):
 *   primaryColor  seat cushion, seat bolsters, backrest FRONT incl. the
 *                 shoulder wings
 *   backColor     backrest back and side panels (textured mesh / PU)
 *   frameColor    armrests (pads + posts), recline lever, gas lift,
 *                 mechanism, 5-star base, twin-wheel casters
 *   pillowColor   magnetic neck pillow (velour)
 *   labelColor    the wordmark strip on the neck pillow
 * The wordmark strip at the top of the backrest front and the diamond logo
 * outline are tone-on-tone: a darker shade of primaryColor. Wordmarks are
 * abstract flat strips, not text -- no textures anywhere.
 *
 * FINISHES: flat colours only. Every mesh carries userData.finish (one of
 * FINISHES) so a renderer can merge meshes by finish; the small logo and
 * wordmark shapes also carry userData.keep = true to stay separate.
 *
 * LOCAL FRAME (the furniture contract):
 *   metres; y = 0 on the floor; x centred on the chair; the BACK of the
 *   chair (its rearmost point, whatever the recline) at z = 0; the seat's
 *   front edge faces +z.
 *
 * THREE is passed in rather than imported, so this module has no import-map
 * dependency and loads in a plain Node test (the src/wall-fittings.js
 * precedent).
 */

import { makeFinish, FINISHES } from './finishes.js';

export const TYPE = 'gaming-chair';

/** Defaults, in cm and degrees. Size-L figures. */
export const DEFAULTS = Object.freeze({
  primaryColor: '#3fc9b8',
  backColor: '#18181a',
  frameColor: '#141416',
  pillowColor: '#111113',
  labelColor: '#f4f4f4',
  seatHeight: 47,        // top of the seat cushion above the floor; 44.5-51
  reclineDeg: 95,        // backrest angle to the seat; 90 (upright) - 155
  armHeight: 24,         // top of the arm pads above the seat top; 13 cm travel
  seatWidth: 52.5,       // across both bolsters
  seatDepth: 46.5,
  backrestHeight: 80,
  backrestWidth: 53,     // at the shoulder wings
  baseDiameter: 53.7,    // 5-star wheelbase, 21.13 in
  casterDiameter: 6.5,   // 65 mm PU twin-wheel
  // Overall bounding envelope at the DEFAULT pose (recline 95, seat 47), in
  // cm: width = armrest span (the widest part), depth = backrest back to the
  // caster tip, height = floor to backrest top. Descriptive only -- build()
  // does not read them; the params above drive the shape, and
  // scripts/test-gaming-chair.mjs pins the built bbox to these within 0.5 cm.
  width: 70,
  height: 119.7,
  depth: 61.5,
});

/** Adjustment ranges the chair physically allows. build() clamps to these. */
export const LIMITS = Object.freeze({
  seatHeight: Object.freeze([44.5, 51]),
  reclineDeg: Object.freeze([90, 155]),
  armHeight: Object.freeze([20, 33]),
});

/** Colourway presets. They only set colours. */
export const PRESETS = Object.freeze({
  mint: Object.freeze({ label: 'Racing chair – mint', primaryColor: '#3fc9b8' }),
  pink: Object.freeze({ label: 'Racing chair – pink', primaryColor: '#e9a3ab' }),
});

/** The finish palette a renderer merges by (re-exported from ./finishes.js). */
export { FINISHES };

const CM = 0.01;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Merge params over DEFAULTS and clamp the adjustables to LIMITS. */
export function resolveParams(params) {
  const p = Object.assign({}, DEFAULTS, params || {});
  for (const k of ['seatWidth', 'seatDepth', 'backrestHeight', 'backrestWidth',
                   'baseDiameter', 'casterDiameter']) {
    p[k] = Math.max(1, num(p[k], DEFAULTS[k]));
  }
  for (const k of Object.keys(LIMITS)) {
    p[k] = clamp(num(p[k], DEFAULTS[k]), LIMITS[k][0], LIMITS[k][1]);
  }
  return p;
}

/**
 * Backrest outline: half-width as a fraction of the shoulder half-width, and
 * how far the edge wraps FORWARD (fraction of the backrest height), at
 * fractional height v. Racing silhouette: wide base, pinched lumbar, flared
 * shoulder wings, narrow head section with rounded shoulders to the top.
 */
const OUTLINE = [
  // v,    halfW, wrap
  [0.00, 0.92, 0.060],
  [0.12, 0.88, 0.070],
  [0.28, 0.81, 0.075],  // lumbar pinch
  [0.50, 0.93, 0.100],
  [0.66, 1.00, 0.140],  // shoulder wings
  [0.74, 0.97, 0.120],
  [0.80, 0.72, 0.040],
  [0.85, 0.62, 0.025],  // head section
  [0.95, 0.60, 0.020],
  [1.00, 0.50, 0.015],
];
function outlineAt(v) {
  for (let i = 1; i < OUTLINE.length; i++) {
    const [v1, w1, r1] = OUTLINE[i];
    if (v <= v1 + 1e-9) {
      const [v0, w0, r0] = OUTLINE[i - 1];
      const f = (v - v0) / (v1 - v0);
      return [w0 + (w1 - w0) * f, r0 + (r1 - r0) * f];
    }
  }
  const last = OUTLINE[OUTLINE.length - 1];
  return [last[1], last[2]];
}

/** Rounded-rectangle slab in XY, extruded along z and centred on the origin. */
function roundedBox(THREE, w, h, d, r, seg) {
  // The bevel grows the outline by bevelSize and the depth by 2 x
  // bevelThickness; shrink both first so the finished part is w x h x d.
  const bevel = seg > 1 ? Math.min(r * 0.6, d * 0.3) : 0;
  const bs = bevel * 0.8;
  w -= 2 * bs; h -= 2 * bs;
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
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
    bevelEnabled: seg > 1, bevelThickness: bevel, bevelSize: bs, bevelSegments: Math.max(1, seg - 1),
  });
  g.center();
  return g;
}

/**
 * Build the chair.
 * @param THREE   the three.js namespace (injected)
 * @param params  any subset of DEFAULTS (cm / degrees / CSS colours)
 * @param opts    { detail: 'full' | 'low' }
 *                'low' drops the twin-wheel caster detail, the logo, wordmarks,
 *                strap slots and lumbar knobs, and halves the segment counts.
 * @returns THREE.Group in the local frame above. group.userData carries
 *          { type, params (resolved), detail, pivot }.
 */
export function build(THREE, params, opts) {
  const P = resolveParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';
  const seg = full ? 3 : 1;           // curve segments on rounded parts
  const cyl = full ? 16 : 8;          // radial segments on cylinders

  // ---- materials ----------------------------------------------------------
  const primaryCol = new THREE.Color(P.primaryColor);
  const embossCol = primaryCol.clone().multiplyScalar(0.78);
  // PU leather gets a soft satin sheen (no sharp highlight); the gas lift is
  // metal; everything else is matte.
  // Every material comes from makeFinish() so the renderer can merge by finish.
  const FINISH = { primary: 'satin', back: 'matte', frame: 'matte', metal: 'metal', pillow: 'matte', emboss: 'matte', label: 'matte' };
  const hex = c => '#' + c.getHexString();
  const COLOR = {
    primary: P.primaryColor, back: P.backColor, frame: P.frameColor, metal: P.frameColor,
    pillow: P.pillowColor, emboss: hex(embossCol), label: P.labelColor,
  };
  const mat = {};
  for (const k of Object.keys(FINISH)) mat[k] = makeFinish(THREE, FINISH[k], COLOR[k]);
  for (const [k, m] of Object.entries(mat)) m.name = 'gamingChair_' + k;

  const root = new THREE.Group();
  root.name = 'gamingChair';
  const chair = new THREE.Group();   // built around the gas-lift axis, shifted at the end
  root.add(chair);

  function add(parent, geo, role, name, keep) {
    const m = new THREE.Mesh(geo, mat[role]);
    m.name = name;
    m.userData.role = role;
    m.userData.finish = FINISH[role];
    if (keep) m.userData.keep = true;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  // ---- key heights (m) ----------------------------------------------------
  const S = P.seatHeight * CM;                 // seat cushion top
  const W = P.seatWidth * CM;
  const D = P.seatDepth * CM;
  const H = P.backrestHeight * CM;
  const casterR = P.casterDiameter * CM / 2;
  const baseR = P.baseDiameter * CM / 2;
  const cushionT = 0.09;
  const panY = S - cushionT;                   // underside of the cushion
  const mechTop = panY - 0.02, mechBot = mechTop - 0.06;
  const hubBot = 0.085, hubTop = 0.145;
  const seatZc = 0.03;                          // seat centre sits a little ahead of the lift
  const seatRear = seatZc - D / 2;

  // ---- 5-star base + casters ----------------------------------------------
  const hub = add(chair, new THREE.CylinderGeometry(0.05, 0.045, hubTop - hubBot, cyl), 'frame', 'baseHub');
  hub.position.y = (hubBot + hubTop) / 2;
  const legIn = 0.04, legOut = baseR - 0.012;
  const legLen = legOut - legIn;
  const legYin = hubTop - 0.02, legYout = 2 * casterR + 0.045;
  const legSlope = Math.atan2(legYin - legYout, legLen);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + Math.PI / 2;   // one leg straight ahead
    const arm = new THREE.Group();
    arm.name = 'baseArm_' + i;
    arm.rotation.y = a - Math.PI / 2;                 // local +z -> this leg's direction
    chair.add(arm);
    const leg = add(arm, new THREE.BoxGeometry(0.05, 0.035, Math.hypot(legLen, legYin - legYout)), 'frame', 'baseLeg_' + i);
    leg.position.set(0, (legYin + legYout) / 2, legIn + legLen / 2);
    leg.rotation.x = legSlope;
    const cap = add(arm, new THREE.CylinderGeometry(0.022, 0.022, 0.035, cyl), 'frame', 'baseLegTip_' + i);
    cap.position.set(0, legYout, legOut - 0.01);

    const caster = new THREE.Group();
    caster.name = 'caster_' + i;
    caster.position.set(0, 0, legOut - 0.01);
    arm.add(caster);
    const wheelGeo = new THREE.CylinderGeometry(casterR, casterR, full ? 0.016 : 0.04, cyl);
    wheelGeo.rotateZ(Math.PI / 2);                    // axle along x
    const wheelZ = -0.012;                            // trails behind the stem
    if (full) {
      for (const s of [-1, 1]) {
        const w = add(caster, wheelGeo, 'frame', `casterWheel_${i}_${s < 0 ? 'L' : 'R'}`);
        w.position.set(s * 0.013, casterR, wheelZ);
      }
      const hood = add(caster, new THREE.BoxGeometry(0.012, casterR * 1.3, casterR * 1.9), 'frame', 'casterHood_' + i);
      hood.position.set(0, casterR * 1.25, wheelZ);
      const stem = add(caster, new THREE.CylinderGeometry(0.008, 0.008, legYout - 2 * casterR, 6), 'frame', 'casterStem_' + i);
      stem.position.set(0, (legYout + 2 * casterR) / 2, 0);
    } else {
      const w = add(caster, wheelGeo, 'frame', `casterWheel_${i}`);
      w.position.set(0, casterR, wheelZ);
    }
  }

  // ---- gas lift + mechanism + recline lever -------------------------------
  const liftLen = mechBot - hubTop;
  const lift = add(chair, new THREE.CylinderGeometry(0.027, 0.03, liftLen + 0.01, cyl), 'metal', 'gasLift');
  lift.position.y = hubTop + liftLen / 2;
  const mech = add(chair, new THREE.BoxGeometry(0.26, mechTop - mechBot, 0.28), 'frame', 'mechanism');
  mech.position.set(0, (mechTop + mechBot) / 2, seatZc - 0.02);
  const lever = add(chair, new THREE.BoxGeometry(0.16, 0.012, 0.022), 'frame', 'reclineLever');
  lever.position.set(0.13 + 0.08, mechTop - 0.035, seatZc + 0.07);
  lever.rotation.z = -0.12;                           // droops slightly
  const leverGrip = add(chair, new THREE.BoxGeometry(0.05, 0.02, 0.03), 'frame', 'reclineLeverGrip');
  leverGrip.position.set(0.13 + 0.16 + 0.02, mechTop - 0.045, seatZc + 0.07);

  // ---- seat ---------------------------------------------------------------
  const pan = add(chair, new THREE.BoxGeometry(W - 0.04, 0.02, D - 0.03), 'frame', 'seatPan');
  pan.position.set(0, panY - 0.01, seatZc);
  const bolsterW = 0.085;
  const cushionW = W - 2 * bolsterW;
  const cushionGeo = roundedBox(THREE, cushionW + 0.01, D, cushionT, 0.03, seg);
  cushionGeo.rotateX(-Math.PI / 2);                  // slab thickness -> y
  const cushion = add(chair, cushionGeo, 'primary', 'seatCushion');
  cushion.position.set(0, S - cushionT / 2, seatZc);
  const bolsterRise = 0.05;
  const bolsterT = cushionT + bolsterRise;
  const bolsterD = D * 0.94;
  for (const s of [-1, 1]) {
    const g = roundedBox(THREE, bolsterW, bolsterD, bolsterT, 0.035, seg);
    g.rotateX(-Math.PI / 2);
    const b = add(chair, g, 'primary', 'seatBolster_' + (s < 0 ? 'L' : 'R'));
    const lean = 0.08;                                // top edge leans in toward the sitter
    const halfSpan = (bolsterW * Math.cos(lean) + bolsterT * Math.sin(lean)) / 2;
    b.position.set(s * (W / 2 - halfSpan), panY + bolsterT / 2, seatRear + bolsterD / 2);
    b.rotation.z = s * lean;
  }

  // ---- armrests (do not recline) ------------------------------------------
  const padTop = S + P.armHeight * CM;
  const padW = 0.105, padT = 0.035, padL = 0.27;
  const armX = W / 2 + 0.035;
  for (const s of [-1, 1]) {
    const side = s < 0 ? 'L' : 'R';
    const bracket = add(chair, new THREE.BoxGeometry(armX - 0.1, 0.03, 0.07), 'frame', 'armBracket_' + side);
    bracket.position.set(s * (0.1 + (armX - 0.1) / 2), mechTop - 0.03, seatZc - 0.03);
    const postBot = mechTop - 0.045;
    const postTop = padTop - padT;
    const post = add(chair, new THREE.BoxGeometry(0.045, postTop - postBot, 0.075), 'frame', 'armPost_' + side);
    post.position.set(s * armX, (postTop + postBot) / 2, seatZc - 0.03);
    const padGeo = roundedBox(THREE, padW, padL, padT, 0.03, seg);
    padGeo.rotateX(-Math.PI / 2);
    const pad = add(chair, padGeo, 'frame', 'armPad_' + side);
    pad.position.set(s * armX, padTop - padT / 2, seatZc + 0.01);
  }

  // ---- backrest (pivots at the seat's rear edge) --------------------------
  const pivot = new THREE.Group();
  pivot.name = 'backrestPivot';
  pivot.position.set(0, S - 0.08, seatRear);
  pivot.rotation.x = -(P.reclineDeg - 90) * Math.PI / 180;   // top tips toward -z
  chair.add(pivot);

  const halfShoulder = P.backrestWidth * CM / 2;
  const T = 0.075;                                    // pad thickness at the centre line
  const nu = full ? 12 : 6, nv = full ? 24 : 12;
  const across = u => { const a = Math.max(0, (Math.abs(u) - 0.45) / 0.55); return a * a; };
  // front surface z, back surface z at (u in [-1,1], v in [0,1])
  const frontZ = (u, v) => outlineAt(v)[1] * H * across(u);
  const backZ = (u, v) => -T + 0.55 * frontZ(u, v);
  const at = (u, v, z) => [u * outlineAt(v)[0] * halfShoulder, v * H, z];

  function grid(zf, flip) {
    const pos = [], idx = [];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = -1 + 2 * i / nu, v = j / nv;
        pos.push(...at(u, v, zf(u, v)));
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        if (!flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  add(pivot, grid(frontZ, false), 'primary', 'backrestFront');
  add(pivot, grid(backZ, true), 'back', 'backrestBack');

  // side + top + bottom panels joining front to back around the perimeter (black)
  {
    const ring = [];
    for (let j = 0; j <= nv; j++) ring.push([1, j / nv]);          // right edge, up
    for (let i = nu - 1; i >= 0; i--) ring.push([-1 + 2 * i / nu, 1]); // top, right -> left
    for (let j = nv - 1; j >= 0; j--) ring.push([-1, j / nv]);      // left edge, down
    for (let i = 1; i < nu; i++) ring.push([-1 + 2 * i / nu, 0]);  // bottom, left -> right
    const pos = [], idx = [];
    for (const [u, v] of ring) { pos.push(...at(u, v, frontZ(u, v)), ...at(u, v, backZ(u, v))); }
    const n = ring.length;
    for (let k = 0; k < n; k++) {
      const a = 2 * k, b = a + 1, c = 2 * ((k + 1) % n), d = c + 1;
      idx.push(a, b, c, b, d, c);                       // outward-facing
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    add(pivot, g, 'back', 'backrestSides');
  }

  // a marker at the top-centre of the backrest front, for tests and callers
  const top = new THREE.Object3D();
  top.name = 'backrestTop';
  top.position.set(0, H, 0);
  pivot.add(top);

  // neck pillow (black velour) on the head section, with its wordmark
  const pillowW = 0.30, pillowH = 0.15, pillowD = 0.09;
  const pillowV = 0.82;              // hangs below the strap slots
  const pillowGeo = roundedBox(THREE, pillowW, pillowH, pillowD, 0.06, seg);
  const pillow = add(pivot, pillowGeo, 'pillow', 'neckPillow');
  pillow.position.set(0, pillowV * H, frontZ(0, pillowV) + pillowD / 2 - 0.01);

  if (full) {
    // wordmarks as abstract flat strips (no text, no textures)
    const pw = add(pivot, new THREE.BoxGeometry(0.15, 0.022, 0.003), 'label', 'pillowWordmark', true);
    pw.position.set(0, pillowV * H - 0.01, pillow.position.z + pillowD / 2 + 0.0015);
    const bw = add(pivot, new THREE.BoxGeometry(0.16, 0.02, 0.003), 'emboss', 'backrestWordmark', true);
    bw.position.set(0, 0.965 * H, frontZ(0, 0.965) + 0.0015);

    // the two slots the pillow strap threads through, above the pillow
    for (const s of [-1, 1]) {
      const slot = add(pivot, new THREE.BoxGeometry(0.045, 0.018, 0.006), 'back', 'strapSlot_' + (s < 0 ? 'L' : 'R'));
      slot.position.set(s * 0.075, 0.935 * H, 0.002);
    }

    // diamond / shield logo outline, mid-upper backrest, tone-on-tone
    const lw = 0.05, lh = 0.065, t = 0.009;
    const outer = new THREE.Shape();
    outer.moveTo(0, lh); outer.lineTo(lw, lh * 0.35); outer.lineTo(0, -lh); outer.lineTo(-lw, lh * 0.35); outer.lineTo(0, lh);
    const hole = new THREE.Path();
    hole.moveTo(0, lh - t * 1.6); hole.lineTo(-lw + t * 1.3, lh * 0.35); hole.lineTo(0, -lh + t * 1.8); hole.lineTo(lw - t * 1.3, lh * 0.35); hole.lineTo(0, lh - t * 1.6);
    outer.holes.push(hole);
    const logo = add(pivot, new THREE.ExtrudeGeometry(outer, { depth: 0.003, bevelEnabled: false }), 'emboss', 'backrestLogo', true);
    logo.position.set(0, 0.60 * H, frontZ(0, 0.60) + 0.001);

    // lumbar knobs, one each side (height / depth)
    const lv = 0.28;
    for (const s of [-1, 1]) {
      const g = new THREE.CylinderGeometry(0.022, 0.022, 0.02, cyl);
      g.rotateZ(Math.PI / 2);
      const knob = add(pivot, g, 'frame', 'lumbarKnob_' + (s < 0 ? 'L' : 'R'));
      knob.position.set(s * (outlineAt(lv)[0] * halfShoulder + 0.01), lv * H, backZ(1, lv) * 0.5 + frontZ(1, lv) * 0.5);
    }
  }

  // ---- shift into the furniture frame: floor at y=0, back at z=0 ----------
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(chair);
  chair.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -box.min.z);
  root.updateMatrixWorld(true);

  root.userData = {
    type: TYPE,
    params: P,
    detail: full ? 'full' : 'low',
    // backrest hinge in the output frame (m), for callers that animate recline
    pivot: pivot.getWorldPosition(new THREE.Vector3()).toArray(),
  };
  return root;
}

export const buildGamingChair = build;

/** Only the params that differ from DEFAULTS -- the furniture JSON shape. */
export function toFurnitureJSON(params) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (params && params[k] !== undefined && params[k] !== DEFAULTS[k]) out[k] = params[k];
  }
  return { type: TYPE, params: out };
}
