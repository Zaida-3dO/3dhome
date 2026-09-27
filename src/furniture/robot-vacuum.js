/**
 * robot-vacuum.js - single-type module: `robot-vacuum`.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0, and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js). No lights, no
 *     textures.
 *   - bbox == params.width/depth/height within 0.5 cm for ANY params.
 * See docs/house-profile.md, "Furniture".
 *
 * A round robot vacuum on a self-emptying dock: a rounded dock tower at the
 * BACK (z = 0 .. towerDepth) -- white lower part, a champagne metal band
 * round its middle and a white lid -- standing on a thin base plate that runs
 * the full depth and ends in a small ramp at the front. The robot sits at the
 * FRONT of the plate, its front at z = depth and its rear tucked into an
 * alcove under the tower's front. The robot is a true-circle lathe body
 * (ROBOT_SEGMENTS) with a rounded top edge, a darker bumper round the front,
 * subtle top seams, a raised lidar turret and a small emissive status LED.
 * The tower has soft vertical corners, and its lower part and lid have
 * rounded top and bottom edges.
 *
 * `dock: false` builds the robot alone. The caller then sets the envelope to
 * the robot's own size (width = depth = robotDiameter, height = robotHeight);
 * the robot always fills the envelope exactly, so any other envelope gives an
 * elliptical robot rather than a bbox mismatch.
 *
 * ENVELOPE, for any params (dock: true): the base plate is exactly `width`
 * wide and `depth` deep, and the tower's lid top is exactly `height`. Every
 * other part is CLAMPED inside that box: the robot's diameter to
 * min(robotDiameter, width, depth), the tower to min(towerWidth, width) x
 * min(towerDepth, depth), the robot's height to what fits above the plate.
 *
 * CREDIT: Proportions recreated (not copied: no mesh data) from a
 * robot-vacuum model by eltayerkebulan on Sketchfab,
 * https://sketchfab.com/models/47a9b14156cc4f48b2e9113b58c288ad, licensed
 * CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Changes: the
 * mesh was not used; this builder re-creates the overall proportions from
 * simple primitives.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

export const TYPE = 'robot-vacuum';

/** Defaults, in cm. */
export const DEFAULTS = Object.freeze({
  width: 35,
  depth: 48,
  height: 59,
  dock: true,              // false = the robot alone (envelope = the robot)
  robotDiameter: 35,
  robotHeight: 10,         // floor to the top of the lidar puck
  towerWidth: 34,
  towerDepth: 24,
  bodyColor: '#f4f4f2',    // robot body, dock tower, lid and base plate
  bandColor: '#b9a88a',    // champagne band round the tower (metal finish)
  puckColor: '#8a8c8e',    // lidar puck
  ledColor: '#2fd0e0'      // status LED (emissive)
});

const CM = 0.01;
const PLATE_T = 1.0;       // base plate thickness, cm
const RAMP_LEN = 6;        // ramp length at the plate's front, cm
const ALCOVE_GAP = 1.5;    // clearance above the robot inside the tower alcove, cm

function resolveParams(params) {
  return Object.assign({}, DEFAULTS, params || {});
}

const num = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** '#rrggbb' scaled toward black by `k` (0..1). */
function darken(hex, k) {
  const c = typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex.slice(1), 16) : 0xcccccc;
  const ch = s => Math.round(((c >> s) & 255) * k);
  return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('');
}

/**
 * A vertical rounded-rectangle prism: `w` (x) by `d` (z) in plan, `h` tall,
 * its bottom at y = 0 and centred on x/z. Corner radius `r`, `seg` curve
 * segments per corner. `bevel` (metres, optional) rounds the top and bottom
 * edges: the side walls stay exactly on the w x d outline (bevelOffset =
 * -bevelSize) and the caps are inset by `bevel`, so the bbox is unchanged.
 */
function roundedPrism(THREE, w, d, h, r, seg, bevel) {
  r = Math.max(1e-4, Math.min(r, w / 2 - 1e-4, d / 2 - 1e-4));
  const s = new THREE.Shape();
  const x0 = -w / 2, y0 = -d / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x0 + w - r, y0);
  s.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  s.lineTo(x0 + w, y0 + d - r);
  s.quadraticCurveTo(x0 + w, y0 + d, x0 + w - r, y0 + d);
  s.lineTo(x0 + r, y0 + d);
  s.quadraticCurveTo(x0, y0 + d, x0, y0 + d - r);
  s.lineTo(x0, y0 + r);
  s.quadraticCurveTo(x0, y0, x0 + r, y0);
  // A bevel may not eat more than a third of the height or the corner.
  const b = bevel ? Math.min(bevel, h / 3, r * 0.9) : 0;
  const g = b > 1e-5
    ? new THREE.ExtrudeGeometry(s, { depth: h - 2 * b, curveSegments: seg, bevelEnabled: true,
      bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 2 }).translate(0, 0, b)
    : new THREE.ExtrudeGeometry(s, { depth: h, curveSegments: seg, bevelEnabled: false });
  // extrusion runs along +z; turn it to run up +y (shape y -> -z, symmetric)
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * A wedge (ramp) `w` wide along x: `h` tall at z = 0, sloping to nothing at
 * z = len. Bottom at y = 0. Eight triangles, wound outward.
 */
function rampGeometry(THREE, w, h, len) {
  const x = w / 2;
  const A = [-x, 0, 0], B = [x, 0, 0], C = [x, h, 0], D = [-x, h, 0], E = [-x, 0, len], F = [x, 0, len];
  const tris = [A, D, C, A, C, B,  A, B, F, A, F, E,  D, E, F, D, F, C,  A, E, D,  B, C, F];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris.flat()), 3));
  g.computeVertexNormals();
  return g;
}

/** Radial segments of the robot's round parts: a TRUE circle at both details. */
export const ROBOT_SEGMENTS = Object.freeze({ full: 64, low: 32 });

/** A quarter-circle of `n` + 1 points from (cx + e, cy) up to (cx, cy + e). */
function arc(cx, cy, e, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI / 2;
    out.push([cx + e * Math.cos(a), cy + e * Math.sin(a)]);
  }
  return out;
}

const lathe = (THREE, pts, seg, phiStart, phiLength) =>
  new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[0], p[1])), seg, phiStart || 0,
    phiLength === undefined ? Math.PI * 2 : phiLength);

/**
 * The robot, centred on x/z with its bottom at y = 0: radius `r`, total
 * height `h` (to the top of the lidar turret), in metres.
 *
 * Full detail: a 64-segment lathe body -- a chamfered bottom edge, a straight
 * side and a ROUNDED top edge (a quarter circle) -- with a front bumper band
 * (the outermost ring, 200 degrees round the front, darker), two subtle
 * seams on the flat top (the lid line and a ring round the turret), and a
 * raised lidar turret: a rounded cap over a dark sensor window. Low detail:
 * the same outline on 32 segments with a plain chamfered top edge, the
 * bumper as a single band and no seams.
 */
function buildRobot(THREE, r, h, full, mats, add) {
  const robot = new THREE.Group();
  robot.name = 'robot';
  const seg = full ? ROBOT_SEGMENTS.full : ROBOT_SEGMENTS.low;
  const bodyH = h * 0.8;                     // body top; the turret rises above it
  const side = r * 0.992;                    // the bumper is the outermost ring, ~1.4 mm proud
  const e = Math.min(bodyH * 0.3, r * 0.2);  // top-edge rounding radius
  // Open at the bottom: the underside is never seen, and it saves a disc.
  const profile = full
    ? [[r * 0.9, 0], [r * 0.96, bodyH * 0.06], [side, bodyH * 0.14]]
      .concat(arc(side - e, bodyH - e, e, 3)).concat([[0, bodyH]])
    : [[r * 0.93, 0], [side, bodyH * 0.12], [side, bodyH - e * 0.6], [side - e * 0.8, bodyH], [0, bodyH]];
  add(robot, lathe(THREE, profile, seg), mats.body, 'robot-body', 0, 0, 0);

  // Bumper: a darker band proud of the body round the FRONT (+z), lower
  // half of the side. Its outer face is the robot's full radius.
  const b0 = bodyH * 0.16, b1 = bodyH * 0.56, lip = r - side;
  const arcLen = Math.PI * 200 / 180;
  const bSeg = Math.max(4, Math.round(seg * 200 / 360));
  const bumperProfile = full
    ? [[side, b0], [r, b0 + lip], [r, b1 - lip], [side, b1]]
    : [[r, b0], [r, b1]];
  add(robot, lathe(THREE, bumperProfile, bSeg, -arcLen / 2, arcLen), mats.bumper, 'robot-bumper', 0, 0, 0);

  // Lidar turret, slightly toward the rear, its top at h.
  const pr = r * 0.26, ph = h - bodyH;
  const tz = -r * 0.18;
  const tSeg = full ? 40 : 16;
  const turretProfile = full
    ? [[pr, 0], [pr, ph * 0.62]].concat(arc(pr * 0.82, ph * 0.82, pr * 0.18, 2).map(p => [p[0], Math.min(p[1], ph)]))
      .concat([[0, ph]])
    : [[pr, 0], [pr, ph], [0, ph]];
  add(robot, lathe(THREE, turretProfile, tSeg), mats.puck, 'robot-turret', 0, bodyH, tz);
  if (full) {
    // The dark sensor window round the turret's lower half, a hair proud.
    const wr = pr * 1.01;
    add(robot, new THREE.CylinderGeometry(wr, wr, ph * 0.34, tSeg, 1, true), mats.window, 'robot-turret-window',
      0, bodyH + ph * 0.1 + ph * 0.17, tz);
    // Subtle top seams: the lid line and a ring round the turret base. Thin
    // flat rings a fraction of a millimetre above the top face.
    const lift = 0.0004, w = Math.max(0.0006, r * 0.006);
    const lidR = r * 0.72;
    const seam1 = new THREE.RingGeometry(lidR - w, lidR, 48, 1).rotateX(-Math.PI / 2);
    add(robot, seam1, mats.seam, 'robot-seam-lid', 0, bodyH + lift, 0).castShadow = false;
    const seam2 = new THREE.RingGeometry(pr * 1.18, pr * 1.18 + w, 32, 1).rotateX(-Math.PI / 2);
    add(robot, seam2, mats.seam, 'robot-seam-turret', 0, bodyH + lift, tz).castShadow = false;
  }

  // small status LED on the flat top, forward of the turret
  const ledH = Math.min(0.003, ph * 0.5);
  const led = new THREE.BoxGeometry(Math.min(0.014, r * 0.2), ledH, Math.min(0.006, r * 0.1));
  add(robot, led, mats.led, 'robot-led', 0, bodyH + ledH / 2, r * 0.5);
  return robot;
}

/**
 * Build the robot vacuum (with or without its dock).
 * @param {Object} THREE
 * @param {Object} [params]  overrides for DEFAULTS
 * @param {{detail?: 'full'|'low'}} [opts]  'low' halves the robot's radial
 *   segments (still a true circle), drops the seams, the turret window and the
 *   rounded top edge, and draws the tower as plain boxes
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const p = resolveParams(params);
  const full = !(opts && opts.detail === 'low');

  const W = Math.max(1, num(p.width, DEFAULTS.width));
  const D = Math.max(1, num(p.depth, DEFAULTS.depth));
  const H = Math.max(1, num(p.height, DEFAULTS.height));

  const group = new THREE.Group();
  group.name = 'furniture:robot-vacuum';

  const mats = {
    body: makeFinish(THREE, 'satin', p.bodyColor),
    bumper: makeFinish(THREE, 'matte', darken(p.bodyColor, 0.62)),
    puck: makeFinish(THREE, 'matte', p.puckColor),
    window: makeFinish(THREE, 'gloss', darken(p.puckColor, 0.3)),
    seam: makeFinish(THREE, 'matte', darken(p.bodyColor, 0.8)),
    led: makeFinish(THREE, 'emissive', p.ledColor),
    band: makeFinish(THREE, 'metal', p.bandColor),
    plate: makeFinish(THREE, 'matte', p.bodyColor)
  };

  function add(parent, geo, mat, name, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    parent.add(mesh);
    return mesh;
  }

  if (p.dock === false) {
    // The robot alone, filling the envelope: a round robot of the smaller
    // plan size, stretched along the other axis only when W != D (the
    // intended use is W == D, so no stretch and true-size details).
    const m = Math.min(W, D);
    const robot = buildRobot(THREE, m * CM / 2, H * CM, full, mats, add);
    robot.scale.set(W / m, 1, D / m);
    robot.position.set(0, 0, D * CM / 2);
    group.add(robot);
  } else {
    // ---- clamp every part into the envelope --------------------------------
    const plateT = Math.min(PLATE_T, H * 0.1);
    const rD = clamp(num(p.robotDiameter, DEFAULTS.robotDiameter), 1, Math.min(W, D));
    const rH = clamp(num(p.robotHeight, DEFAULTS.robotHeight), 0.5, H - plateT);
    const tW = clamp(num(p.towerWidth, DEFAULTS.towerWidth), 1, W);
    const tD = clamp(num(p.towerDepth, DEFAULTS.towerDepth), 1, D);
    const alcoveTop = Math.min(plateT + rH + ALCOVE_GAP, H - Math.min(1, H * 0.1));
    const robotRear = D - rD;                                  // z of the robot's rear
    const backD = clamp(robotRear, Math.min(0.5, tD), tD);     // alcove back block depth

    // ---- base plate (full width and depth) + ramp at the front ------------
    const rampLen = Math.min(RAMP_LEN, D * 0.25);
    const plateD = D - rampLen;
    // The plate is too thin to shadow anything; casting would only speckle
    // its own top with shadow acne.
    add(group, new THREE.BoxGeometry(W * CM, plateT * CM, plateD * CM), mats.plate, 'dock-plate',
      0, plateT * CM / 2, plateD * CM / 2).castShadow = false;
    add(group, rampGeometry(THREE, W * CM, plateT * CM, rampLen * CM), mats.plate, 'dock-ramp',
      0, 0, plateD * CM).castShadow = false;

    // ---- tower -----------------------------------------------------------
    // Below alcoveTop only a back block stands (the robot's rear slides in
    // under the tower's front); above it the full-depth tower: white lower
    // part, champagne band, white lid.
    const bodyH = H - alcoveTop;
    const lowerH = bodyH * 0.18, bandH = bodyH * 0.3, lidH = bodyH - lowerH - bandH;
    const inset = Math.min(0.4, tW * 0.02, tD * 0.02);        // band sits a hair inside
    // Full detail: soft vertical corners (a quarter of the smaller side, as
    // on the real base) and rounded top/bottom edges on the lower part and
    // the lid, so the band reads as a groove between two pillowy blocks.
    const rad = full ? Math.min(6, tW * 0.2, tD * 0.2) : 0;
    const bev = Math.min(1.6, tW * 0.05, tD * 0.05);
    const prism = (w, d, h, bevel) => full
      ? roundedPrism(THREE, w * CM, d * CM, h * CM, rad * CM, 4, bevel ? bev * CM : 0)
      : new THREE.BoxGeometry(w * CM, h * CM, d * CM).translate(0, h * CM / 2, 0);
    const towerPart = (name, mat, w, d, y0, h, bevel) =>
      add(group, prism(w, d, h, bevel), mat, name, 0, y0 * CM, d * CM / 2);
    towerPart('dock-tower-back', mats.body, tW, backD, plateT, alcoveTop - plateT, false);
    towerPart('dock-tower-lower', mats.body, tW, tD, alcoveTop, lowerH, true);
    towerPart('dock-tower-band', mats.band, tW - 2 * inset, tD - 2 * inset, alcoveTop + lowerH, bandH, false);
    towerPart('dock-tower-lid', mats.body, tW, tD, alcoveTop + lowerH + bandH, lidH, true);

    // ---- robot at the front of the plate ----------------------------------
    const robot = buildRobot(THREE, rD * CM / 2, rH * CM, full, mats, add);
    robot.position.set(0, plateT * CM, (D - rD / 2) * CM);
    group.add(robot);
  }

  group.userData = { type: TYPE, params: p, detail: full ? 'full' : 'low' };
  return group;
}

export const buildRobotVacuum = build;

/** Only the params that differ from DEFAULTS -- the furniture JSON shape. */
export function toFurnitureJSON(params) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (params && params[k] !== undefined && params[k] !== DEFAULTS[k]) out[k] = params[k];
  }
  return { type: TYPE, params: out };
}
