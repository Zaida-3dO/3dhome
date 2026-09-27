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
 * alcove under the tower's front. The robot is a lathe body with a chamfered
 * top edge, a darker bumper band, a lidar puck on top and a small emissive
 * status LED.
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
 * CREDIT: Proportions recreated (not copied: no mesh data) from a CC-BY-4.0
 * Sketchfab robot-vacuum model by eltayerkebulan, Sketchfab model id
 * 47a9b14156cc4f48b2e9113b58c288ad.
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
 * segments per corner; no bevel.
 */
function roundedPrism(THREE, w, d, h, r, seg) {
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
  const g = new THREE.ExtrudeGeometry(s, { depth: h, curveSegments: seg, bevelEnabled: false });
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

/**
 * The robot, centred on x/z with its bottom at y = 0: radius `r`, total
 * height `h` (to the top of the lidar puck), in metres.
 */
function buildRobot(THREE, r, h, full, mats, add) {
  const robot = new THREE.Group();
  robot.name = 'robot';
  const bodyH = h * 0.8;                     // body top; the puck rises above it
  const seg = full ? 16 : 8;
  const side = full ? r * 0.985 : r;         // full: the bumper is the outermost ring
  const profile = full
    ? [[0, 0], [r * 0.94, 0], [side, bodyH * 0.12], [side, bodyH * 0.78], [r * 0.88, bodyH], [0, bodyH]]
    : [[0, 0], [r, 0], [r, bodyH], [0, bodyH]];
  const body = new THREE.LatheGeometry(profile.map(p => new THREE.Vector2(p[0], p[1])), seg);
  add(robot, body, mats.body, 'robot-body', 0, 0, 0);

  if (full) {
    // darker bumper band round the lower side
    const bh = bodyH * 0.3;
    const bumper = new THREE.CylinderGeometry(r, r, bh, seg, 1, true);
    add(robot, bumper, mats.bumper, 'robot-bumper', 0, bodyH * 0.2 + bh / 2, 0);
  }

  // lidar puck, slightly toward the rear, its top at h
  const pr = r * 0.28, ph = h - bodyH;
  const puck = new THREE.CylinderGeometry(pr, pr, ph, full ? 10 : 6, 1, false);
  add(robot, puck, mats.puck, 'robot-puck', 0, bodyH + ph / 2, -r * 0.15);

  // small status LED on the flat top, forward of the puck
  const ledH = Math.min(0.003, ph * 0.5);
  const led = new THREE.BoxGeometry(Math.min(0.014, r * 0.2), ledH, Math.min(0.006, r * 0.1));
  add(robot, led, mats.led, 'robot-led', 0, bodyH + ledH / 2, r * 0.5);
  return robot;
}

/**
 * Build the robot vacuum (with or without its dock).
 * @param {Object} THREE
 * @param {Object} [params]  overrides for DEFAULTS
 * @param {{detail?: 'full'|'low'}} [opts]  'low' drops the bumper band and the
 *   robot's chamfer, halves the lathe segments and draws the tower as plain boxes
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
    // The robot alone, filling the envelope: a unit-radius robot scaled to
    // W x D in plan (a circle whenever W == D, the intended use).
    const r = 0.5;
    const robot = buildRobot(THREE, r, H * CM, full, mats, add);
    robot.scale.set(W * CM, 1, D * CM);
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
    add(group, new THREE.BoxGeometry(W * CM, plateT * CM, plateD * CM), mats.plate, 'dock-plate',
      0, plateT * CM / 2, plateD * CM / 2);
    add(group, rampGeometry(THREE, W * CM, plateT * CM, rampLen * CM), mats.plate, 'dock-ramp',
      0, 0, plateD * CM);

    // ---- tower -----------------------------------------------------------
    // Below alcoveTop only a back block stands (the robot's rear slides in
    // under the tower's front); above it the full-depth tower: white lower
    // part, champagne band, white lid.
    const bodyH = H - alcoveTop;
    const lowerH = bodyH * 0.18, bandH = bodyH * 0.3, lidH = bodyH - lowerH - bandH;
    const inset = Math.min(0.4, tW * 0.02, tD * 0.02);        // band sits a hair inside
    const rad = Math.min(3, tW * 0.12, tD * 0.12);
    const prism = (w, d, h) => full
      ? roundedPrism(THREE, w * CM, d * CM, h * CM, rad * CM, 3)
      : new THREE.BoxGeometry(w * CM, h * CM, d * CM).translate(0, h * CM / 2, 0);
    const towerPart = (name, mat, w, d, y0, h) =>
      add(group, prism(w, d, h), mat, name, 0, y0 * CM, d * CM / 2);
    towerPart('dock-tower-back', mats.body, tW, backD, plateT, alcoveTop - plateT);
    towerPart('dock-tower-lower', mats.body, tW, tD, alcoveTop, lowerH);
    towerPart('dock-tower-band', mats.band, tW - 2 * inset, tD - 2 * inset, alcoveTop + lowerH, bandH);
    towerPart('dock-tower-lid', mats.body, tW, tD, alcoveTop + lowerH + bandH, lidH);

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
