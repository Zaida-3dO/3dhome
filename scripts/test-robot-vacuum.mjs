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
 *   5. Triangle caps: full <= 600, low <= 200, low <= 0.6 x full.
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
    // Mutation: lathe segments 16 -> 32 -> full cap fails; low seg 8 -> 16 -> low caps fail.
    check(tag + ': full <= 600 triangles', tf <= 600, tf);
    check(tag + ': low <= 200 triangles', tl <= 200, tl);
    check(tag + ': low <= 0.6 x full', tl <= 0.6 * tf, { tf, tl });
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

console.log(failures ? 'FAILED -- ' + failures + ' failed, ' + passes + ' passed' : 'ok -- ' + passes + ' passed, 0 failed');
process.exit(failures ? 1 : 0);
