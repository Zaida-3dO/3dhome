#!/usr/bin/env node
/**
 * robot-vacuum.js: the decisions the generic contract test cannot pin.
 * No framework, no install: `node scripts/test-robot-vacuum.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract at DEFAULTS for every registered type. This file adds:
 *
 *   1. The envelope holds at DEFAULTS, with the dock off (35 x 35 x 10) and
 *      at awkward params (parts bigger than the envelope are clamped).
 *   2. The robot's front is at z = depth, and its rear is tucked under the
 *      tower's front (the robot starts before the tower ends).
 *   3. The status LED is emissive AND kept.
 *   4. dock: false has no dock meshes at all.
 *   5. Triangle caps: full <= 2800, low <= 600, low <= 0.3 x full.
 *   8. The robot is a TRUE circle: every side vertex of the body at one
 *      radius, on >= 64 radial segments at full and >= 32 at low; a rounded
 *      top edge at full; the bumper round the FRONT only; a raised turret
 *      above the body; seams at full only; a bevelled dock lid at full.
 *   6. No THREE lights anywhere in the group.
 *   7. toFurnitureJSON emits only the non-default keys.
 *
 * Each check names the one-line mutation of robot-vacuum.js it catches.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const V = await imp('src/furniture/robot-vacuum.js');
const Fin = await imp('src/furniture/finishes.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

function bboxCm(obj) {
  obj.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(obj);
  return { minX: b.min.x * 100, maxX: b.max.x * 100, minY: b.min.y * 100, maxY: b.max.y * 100, minZ: b.min.z * 100, maxZ: b.max.z * 100 };
}
function triangles(group) {
  let n = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return n;
}
function meshes(group, pred) {
  const out = [];
  group.traverse(o => { if (o.isMesh && (!pred || pred(o))) out.push(o); });
  return out;
}
const byName = (group, name) => meshes(group, m => m.name === name)[0];

function envelope(tag, params) {
  const p = Object.assign({}, V.DEFAULTS, params);
  for (const detail of ['full', 'low']) {
    const b = bboxCm(V.build(THREE, params, { detail }));
    const t = tag + ' (' + detail + ')';
    // Mutation: plate width W * CM * 0.9 -> width fails.
    check(t + ': width == params', Math.abs(b.maxX - b.minX - p.width) <= 0.5, { b, w: p.width });
    check(t + ': x centred', Math.abs(b.maxX + b.minX) <= 1, b);
    // Mutation: robot placed at y = plateT * CM + 0.01 below... / tower lid
    // height lidH + 1 -> height fails.
    check(t + ': height == params, bottom at 0', Math.abs(b.minY) <= 0.5 && Math.abs(b.maxY - p.height) <= 0.5, { b, h: p.height });
    // Mutation: robot centre z = (D - rD / 2 + 2) -> depth fails.
    check(t + ': depth == params, back at 0', Math.abs(b.minZ) <= 0.5 && Math.abs(b.maxZ - p.depth) <= 0.5, { b, d: p.depth });
  }
}

// ---- 1. envelope ---------------------------------------------------------------
{
  check('TYPE is robot-vacuum', V.TYPE === 'robot-vacuum');
  check('DEFAULTS frozen', Object.isFrozen(V.DEFAULTS));
  envelope('DEFAULTS', {});
  envelope('dock off, 35 x 35 x 10', { dock: false, width: 35, depth: 35, height: 10 });
  // Every part oversized: the clamps must hold the envelope.
  envelope('oversized parts clamped', { width: 30, depth: 40, height: 45, robotDiameter: 50, robotHeight: 60, towerWidth: 80, towerDepth: 90 });
  // Mutation: clamp the robot to W only (not min(W, D)) -> a robot deeper
  // than the envelope pushes its rear past z = 0 -> back-at-0 fails.
  envelope('shallow: depth below the robot diameter', { width: 50, depth: 30, height: 40, robotDiameter: 45 });
  envelope('small parts inside a big envelope', { width: 60, depth: 70, height: 80, robotDiameter: 20, towerWidth: 20, towerDepth: 15 });
}

// ---- 2. robot front at z = depth, rear under the tower -------------------------
{
  const g = V.build(THREE, {}, { detail: 'full' });
  const robot = g.getObjectByName('robot');
  check('a robot group exists', !!robot);
  const rb = bboxCm(robot);
  // Mutation: robot.position z = (D - rD / 2 - 3) * CM -> front fails.
  check('robot front at z = depth', Math.abs(rb.maxZ - V.DEFAULTS.depth) <= 0.5, rb);
  check('robot diameter == robotDiameter', Math.abs(rb.maxZ - rb.minZ - V.DEFAULTS.robotDiameter) <= 0.5, rb);
  const lid = bboxCm(byName(g, 'dock-tower-lid'));
  // Mutation: robot centred at z = D + ... or a tower pushed forward past the
  // robot's rear / towerDepth ignored -> fails.
  check('robot rear is tucked under the tower front', rb.minZ < lid.maxZ - 5, { robotRear: rb.minZ, towerFront: lid.maxZ });
  check('tower depth == towerDepth', Math.abs(lid.maxZ - lid.minZ - V.DEFAULTS.towerDepth) <= 0.5, lid);
  // The alcove: the part of the tower below the robot's top stops short of
  // the robot's rear, so the two do not interpenetrate.
  // Mutation: backD = tD -> fails.
  const back = bboxCm(byName(g, 'dock-tower-back'));
  check('tower back block stops at the robot rear', back.maxZ <= rb.minZ + 0.01, { back: back.maxZ, robotRear: rb.minZ });
  const band = byName(g, 'dock-tower-band');
  // A light champagne GLOSS band, not metal: metal rendered any champagne as
  // dark bronze (item 9a0d3553). Mutations: band finish back to 'metal', or
  // the default back to the dark #b9a88a -> fails.
  check('tower band is gloss (metalness 0), not metal', band && band.material.userData.finish === 'gloss' &&
    band.material.metalness === 0 &&
    band.material.color.getHex() === parseInt(V.DEFAULTS.bandColor.slice(1), 16), band && band.material.userData);
  check('band default is the light champagne #c9b48a', V.DEFAULTS.bandColor === '#c9b48a', V.DEFAULTS.bandColor);
  const bb = bboxCm(band);
  check('band sits between the lower part and the lid', bb.minY > back.maxY - 0.01 && bb.maxY <= lid.minY + 0.01, { band: bb, lid });
}

// ---- 3. LED emissive and kept --------------------------------------------------
{
  for (const dock of [true, false]) for (const detail of ['full', 'low']) {
    const g = V.build(THREE, { dock }, { detail });
    const led = byName(g, 'robot-led');
    const tag = 'dock ' + dock + ' ' + detail;
    // Mutation: mats.led finish 'matte' -> fails.
    check(tag + ': LED is emissive', !!led && Fin.partFinish(led).finish === 'emissive', led && led.material.userData);
    // Mutation: drop the `mesh.userData.keep = true` line -> fails.
    check(tag + ': LED is kept', !!led && Fin.partKeep(led).keep === true, led && led.userData);
    check(tag + ': LED colour is ledColor', !!led && led.material.emissive.getHex() === parseInt(V.DEFAULTS.ledColor.slice(1), 16));
  }
}

// ---- 4. dock:false has no dock -------------------------------------------------
{
  const g = V.build(THREE, { dock: false, width: 35, depth: 35, height: 10 }, { detail: 'full' });
  const dockParts = meshes(g, m => /^dock-/.test(m.name));
  // Mutation: `if (p.dock === false)` -> `if (p.dock === 'no')` -> fails.
  check('dock:false: no dock meshes', dockParts.length === 0, dockParts.map(m => m.name));
  check('dock:false: robot body present', !!byName(g, 'robot-body'));
  const withDock = V.build(THREE, {}, { detail: 'full' });
  check('dock:true: tower, band, lid, plate and ramp present',
    ['dock-plate', 'dock-ramp', 'dock-tower-back', 'dock-tower-lower', 'dock-tower-band', 'dock-tower-lid'].every(n => !!byName(withDock, n)));
}

// ---- 5. triangle caps ----------------------------------------------------------
{
  for (const [tag, p] of [['dock', {}], ['robot alone', { dock: false, width: 35, depth: 35, height: 10 }]]) {
    const tf = triangles(V.build(THREE, p, { detail: 'full' }));
    const tl = triangles(V.build(THREE, p, { detail: 'low' }));
    // Mutation: ROBOT_SEGMENTS.full 64 -> 128 -> full cap fails; low 32 -> 64
    // (or the full-detail seams kept at low) -> a low cap fails.
    check(tag + ': full <= 2800 triangles', tf <= 2800, tf);
    check(tag + ': low <= 600 triangles', tl <= 600, tl);
    check(tag + ': low <= 0.3 x full', tl <= 0.3 * tf, { tf, tl });
    console.log('robot-vacuum ' + tag + ': full ' + tf + ' / low ' + tl + ' triangles');
  }
}

// ---- 6. no lights ------------------------------------------------------------
{
  for (const dock of [true, false]) {
    const g = V.build(THREE, { dock }, { detail: 'full' });
    const lights = [];
    g.traverse(o => { if (o.isLight) lights.push(o.type); });
    // Mutation: robot.add(new THREE.PointLight()) -> fails.
    check('dock ' + dock + ': no lights', lights.length === 0, lights);
  }
}

// ---- 7. toFurnitureJSON ------------------------------------------------------
{
  const j = V.toFurnitureJSON(Object.assign({}, V.DEFAULTS, { dock: false, width: 35, depth: 35, height: 10 }));
  // Mutation: drop the `!== DEFAULTS[k]` test -> every key emitted -> fails.
  check('toFurnitureJSON: type', j.type === 'robot-vacuum');
  check('toFurnitureJSON: only non-default keys', JSON.stringify(j.params) === JSON.stringify({ depth: 35, height: 10, dock: false }), j.params);
  check('toFurnitureJSON: DEFAULTS -> empty params', Object.keys(V.toFurnitureJSON(V.DEFAULTS).params).length === 0);
}

// ---- 8. a true circle, a rounded top edge, bumper, turret, seams, bevel ------
{
  const P = V.DEFAULTS;
  for (const detail of ['full', 'low']) {
    const g = V.build(THREE, { dock: false, width: 35, depth: 35, height: 10 }, { detail });
    const body = byName(g, 'robot-body');
    const pos = body.geometry.attributes.position;
    // The side: every vertex at the body's widest radius. All of them at ONE
    // radius (a circle, not an ellipse or a polygon's corners-vs-edges), and
    // at enough distinct angles.
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getZ(i)));
    const angles = new Set();
    let off = 0;
    for (let i = 0; i < pos.count; i++) {
      const rr = Math.hypot(pos.getX(i), pos.getZ(i));
      if (rr < maxR * 0.999) continue;
      if (Math.abs(rr - maxR) > 1e-6) off++;
      angles.add(Math.round(Math.atan2(pos.getX(i), pos.getZ(i)) * 1e4));
    }
    const want = V.ROBOT_SEGMENTS[detail];
    // Mutation: ROBOT_SEGMENTS.full 64 -> 16 (the old look) -> fails.
    check(detail + ': body is round on >= ' + want + ' segments', want >= (detail === 'full' ? 64 : 32) && angles.size >= want, { angles: angles.size, want });
    check(detail + ': side vertices all at one radius', off === 0, off);
    const bb = bboxCm(g);
    // The bumper is ~1.4 mm proud of the body and wraps the front only, so
    // the plan may differ by that much front-to-back -- and no more.
    // Mutation: robot.scale.set(W / m * 1.1, ...) -> the plan is an ellipse -> fails.
    check(detail + ': plan is a circle (width == depth)', Math.abs((bb.maxX - bb.minX) - (bb.maxZ - bb.minZ)) < 0.2, bb);

    // Bumper: round the FRONT. Its bbox reaches the robot's front (+z) and
    // stops well short of the rear.
    const bump = bboxCm(byName(g, 'robot-bumper'));
    const rob = bboxCm(g.getObjectByName('robot'));
    // Mutation: phiStart -arcLen / 2 -> Math.PI - arcLen / 2 (bumper at the back) -> fails.
    check(detail + ': bumper at the front', Math.abs(bump.maxZ - rob.maxZ) < 0.05 && bump.minZ > rob.minZ + 5, { bump, rob });

    // Turret: rises above the body top to the full height.
    const tur = bboxCm(byName(g, 'robot-turret'));
    const bod = bboxCm(body);
    // Mutation: turret placed at y = 0 -> fails.
    check(detail + ': turret stands on the body and reaches the top', tur.minY >= bod.maxY - 0.01 && Math.abs(tur.maxY - 10) < 0.05, { tur, bod });

    const seams = meshes(g, m => /^robot-seam/.test(m.name));
    // Mutation: `if (full)` around the seams -> `if (true)` -> low fails.
    check(detail + ': seams at full only', detail === 'full' ? seams.length === 2 : seams.length === 0, seams.length);
  }
  // Rounded top edge (full): a vertex midway round the edge -- inside the
  // side radius AND below the top face. A plain chamfer has none that far in.
  {
    const g = V.build(THREE, { dock: false, width: 35, depth: 35, height: 10 }, { detail: 'full' });
    const pos = byName(g, 'robot-body').geometry.attributes.position;
    let top = 0, maxR = 0;
    for (let i = 0; i < pos.count; i++) { top = Math.max(top, pos.getY(i)); maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getZ(i))); }
    // The edge radius the builder uses: min(bodyH * 0.3, r * 0.2), bodyH =
    // 0.8 x height -> 2.4 cm for a 10 cm robot of 35 cm.
    const e = Math.min(0.08 * 0.3, 0.175 * 0.2);
    let mid = 0;
    for (let i = 0; i < pos.count; i++) {
      const rr = Math.hypot(pos.getX(i), pos.getZ(i)), y = pos.getY(i);
      if (rr > maxR - e * 0.99 && rr < maxR - 1e-4 && y > top - e * 0.99 && y < top - 1e-4) mid++;
    }
    // Mutation: arc(side - e, bodyH - e, e, 3) -> arc(..., 1) (a chamfer) -> fails.
    check('full: the top edge is rounded (arc points between side and top)', mid >= 2 * V.ROBOT_SEGMENTS.full, mid);
  }
  // Dock lid (full): bevelled -- its top cap is inset from its sides.
  {
    const g = V.build(THREE, {}, { detail: 'full' });
    const lid = byName(g, 'dock-tower-lid');
    const pos = lid.geometry.attributes.position;
    let maxY = -Infinity, sideX = 0, capX = 0;
    for (let i = 0; i < pos.count; i++) maxY = Math.max(maxY, pos.getY(i));
    for (let i = 0; i < pos.count; i++) {
      const x = Math.abs(pos.getX(i));
      sideX = Math.max(sideX, x);
      if (pos.getY(i) > maxY - 1e-6) capX = Math.max(capX, x);
    }
    // Mutation: towerPart('dock-tower-lid', ..., true) -> false -> fails.
    check('full: dock lid top edge is bevelled', sideX * 100 - capX * 100 > 0.5, { sideX, capX });
    check('full: dock lid side is still the tower width', Math.abs(sideX * 200 - P.towerWidth) < 0.05, sideX);
  }
}

console.log(failures ? 'FAILED -- ' + failures + ' failed, ' + passes + ' passed' : 'ok -- ' + passes + ' passed, 0 failed');
process.exit(failures ? 1 : 0);
