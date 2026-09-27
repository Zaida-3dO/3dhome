#!/usr/bin/env node
/**
 * Furniture data layer: placement, the loader's compileFurniture, the finish
 * palette, the box builder and the registry. No framework, no install:
 * `node scripts/test-furniture-core.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. Wall anchors in all four wall orientations: the back lands on the
 *      room face (+ offset) and the front faces into the room. A sign error
 *      here puts every wall item backwards, and in a house nobody looks at
 *      from behind the wall it would survive review.
 *   2. Free anchors: `rotation` is CLOCKWISE in plan, 0 = front faces south
 *      (+y). 90 faces WEST, 270 EAST, 180 NORTH -- the Sweet Home 3D
 *      convention. `at` is the footprint CENTRE, so the back is
 *      at - front * depth / 2.
 *   3. Every malformed entry is skipped with a warning, never thrown.
 *   4. The finish palette stamps userData.finish; the box meets the builder
 *      contract (bbox == params, back at z = 0, bottom at y = 0).
 *   5. The registry: lazy load, missing module = warn + skip, multi-type
 *      modules, and the ?v= cache-bust on every builder URL.
 *
 * Builds real three.js geometry from the vendored module (no DOM needed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = rel => pathToFileURL(path.join(root, rel)).href;
const imp = rel => import(url(rel));
const { HouseLoader } = await imp('src/house-loader.js');
const THREE = await imp('vendor/three-r160/three.module.min.js');
const P = await imp('src/furniture/place.js');
const Fin = await imp('src/furniture/finishes.js');
const Box = await imp('src/furniture/box.js');
const R = await imp('src/furniture/registry.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearPt = (p, q, eps = 1e-6) => near(p[0], q[0], eps) && near(p[1], q[1], eps);
function quietly(fn) {
  const warnings = [];
  const w = console.warn;
  console.warn = m => warnings.push(String(m));
  try { return { value: fn(), warnings: warnings }; } finally { console.warn = w; }
}
async function quietlyAsync(fn) {
  const warnings = [];
  const w = console.warn;
  console.warn = m => warnings.push(String(m));
  try { return { value: await fn(), warnings: warnings }; } finally { console.warn = w; }
}

// A plain 400 x 300 room (x 100..500, y 100..400) inside four 10 cm walls.
function house(furniture) {
  return {
    kind: 'geometry', schemaVersion: '1.2', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      { id: 1, start: [95, 95], end: [505, 95], exterior: true },   // north, room south of it
      { id: 2, start: [95, 405], end: [505, 405], exterior: true }, // south, room north of it
      { id: 3, start: [95, 95], end: [95, 405] },                   // west, room east of it
      { id: 4, start: [505, 95], end: [505, 405] },                 // east, room west of it
      { id: 9, start: [0, 0], end: [50, 60] }                        // diagonal
    ] },
    rooms: [{ id: 'r', label: 'R', polygon: [[100, 100], [500, 100], [500, 400], [100, 400]] }],
    furniture: furniture
  };
}
const compileF = furniture => quietly(() => HouseLoader.compile(house(furniture), ''));

// ---- 1. wall anchors, all four orientations ---------------------------------
{
  const { value: h, warnings } = compileF([
    { id: 'n', room: 'r', type: 'box', wall: 1, centre: 200, offset: 3, elevation: 17 },
    { id: 's', room: 'r', type: 'box', wall: 2, centre: 250 },
    { id: 'w', room: 'r', type: 'box', wall: 3, centre: 150, offset: 2 },
    { id: 'e', room: 'r', type: 'box', wall: 4, centre: 350 }
  ]);
  const f = id => h.furniture.find(x => x.id === id);
  check('wall anchors: all four compile', h.furniture.length === 4, warnings);
  check('north wall: back at room face + offset', f('n').x === 200 && f('n').y === 103, f('n'));
  check('north wall: faces south (0)', f('n').rotationDeg === 0, f('n'));
  check('north wall: origin back, host wall and exterior recorded',
    f('n').origin === 'back' && f('n').hostWallId === 1 && f('n').exterior === true, f('n'));
  check('elevation passes through', f('n').elevation === 17, f('n'));
  check('south wall: back on room face', f('s').x === 250 && f('s').y === 400, f('s'));
  check('south wall: faces north (180)', f('s').rotationDeg === 180, f('s'));
  check('west wall: back at room face + offset', f('w').x === 102 && f('w').y === 150, f('w'));
  check('west wall: faces east (270)', f('w').rotationDeg === 270, f('w'));
  check('west wall: interior host is not exterior', f('w').exterior === false, f('w'));
  check('east wall: back on room face', f('e').x === 500 && f('e').y === 350, f('e'));
  check('east wall: faces west (90)', f('e').rotationDeg === 90, f('e'));
  // The front of each wall item must point at the room's centre (300, 250).
  ['n', 's', 'w', 'e'].forEach(id => {
    const it = f(id), fr = P.frontVector(it.rotationDeg);
    const toCentre = [300 - it.x, 250 - it.y];
    check(id + ' wall: front points into the room', fr[0] * toCentre[0] + fr[1] * toCentre[1] > 0, { fr, toCentre });
  });
  // resolvePlacement leaves a wall-anchored back where the loader put it.
  const rp = P.resolvePlacement(f('n'), { depth: 60 });
  check('resolvePlacement: wall anchor back unchanged by depth', rp.x === 200 && rp.y === 103, rp);
}

// ---- 2. free anchors ---------------------------------------------------------
{
  const { value: h, warnings } = compileF([
    { id: 'r0', room: 'r', type: 'box', at: [300, 250] },
    { id: 'r90', room: 'r', type: 'box', at: [300, 250], rotation: 90 },
    { id: 'r180', room: 'r', type: 'box', at: [300, 250], rotation: 180 },
    { id: 'r270', room: 'r', type: 'box', at: [300, 250], rotation: 270 },
    { id: 'neg', room: 'r', type: 'box', at: [300, 250], rotation: -90 },
    { id: 'big', room: 'r', type: 'box', at: [300, 250], rotation: 450 }
  ]);
  const f = id => h.furniture.find(x => x.id === id);
  check('free anchors: all compile', h.furniture.length === 6, warnings);
  check('free: origin centre, x/y = at', f('r0').origin === 'centre' && f('r0').x === 300 && f('r0').y === 250, f('r0'));
  check('free: no host wall', f('r0').hostWallId === null && f('r0').exterior === false, f('r0'));
  check('free: rotation defaults to 0', f('r0').rotationDeg === 0, f('r0'));
  check('free: -90 normalises to 270', f('neg').rotationDeg === 270, f('neg'));
  check('free: 450 normalises to 90', f('big').rotationDeg === 90, f('big'));

  check('rotation 0 faces south (+y)', nearPt(P.frontVector(0), [0, 1]), P.frontVector(0));
  check('rotation 90 faces WEST', nearPt(P.frontVector(90), [-1, 0]), P.frontVector(90));
  check('rotation 180 faces NORTH', nearPt(P.frontVector(180), [0, -1]), P.frontVector(180));
  check('rotation 270 faces EAST', nearPt(P.frontVector(270), [1, 0]), P.frontVector(270));

  // back = at - front * depth / 2
  const d = 60;
  const b0 = P.resolvePlacement(f('r0'), { depth: d });
  check('resolvePlacement 0: back is north of centre', near(b0.x, 300) && near(b0.y, 220), b0);
  const b90 = P.resolvePlacement(f('r90'), { depth: d });
  check('resolvePlacement 90 (faces west): back is EAST of centre', near(b90.x, 330) && near(b90.y, 250), b90);
  const b180 = P.resolvePlacement(f('r180'), { depth: d });
  check('resolvePlacement 180: back is south of centre', near(b180.x, 300) && near(b180.y, 280), b180);
  const b270 = P.resolvePlacement(f('r270'), { depth: d });
  check('resolvePlacement 270 (faces east): back is WEST of centre', near(b270.x, 270) && near(b270.y, 250), b270);

  // The footprint of a free item is centred on `at`.
  const fp = P.footprintRect(b90.x, b90.y, 90, 100, d);
  const cx = fp.reduce((s, p) => s + p[0], 0) / 4, cy = fp.reduce((s, p) => s + p[1], 0) / 4;
  check('footprint of a free item is centred on at', near(cx, 300) && near(cy, 250), { cx, cy });
  check('footprint at 90: width runs along y, depth along x',
    near(Math.max(...fp.map(p => p[1])) - Math.min(...fp.map(p => p[1])), 100) &&
    near(Math.max(...fp.map(p => p[0])) - Math.min(...fp.map(p => p[0])), d), fp);
  const fp0 = P.footprintRect(200, 103, 0, 80, 40);
  check('footprint at 0: BL, BR, FR, FL', nearPt(fp0[0], [160, 103]) && nearPt(fp0[1], [240, 103]) &&
    nearPt(fp0[2], [240, 143]) && nearPt(fp0[3], [160, 143]), fp0);
}

// ---- 3. rejections: warn and skip, never throw -------------------------------
{
  const cases = [
    [{ id: 'both', room: 'r', type: 'box', at: [300, 250], wall: 1, centre: 200 }, /both `at` and `wall`/],
    [{ id: 'none', room: 'r', type: 'box' }, /neither `at` nor `wall`/],
    [{ id: 'rotwall', room: 'r', type: 'box', wall: 1, centre: 200, rotation: 90 }, /`rotation` with a wall anchor/],
    [{ id: 'noroom', room: 'attic', type: 'box', at: [1, 1] }, /room "attic"/],
    [{ id: 'nowall', room: 'r', type: 'box', wall: 77, centre: 1 }, /wall 77, which does not exist/],
    [{ id: 'diag', room: 'r', type: 'box', wall: 9, centre: 10 }, /not axis-aligned/],
    [{ id: 'badfade', room: 'r', type: 'box', at: [300, 250], fade: { wall: 77 } }, /fade.wall names wall 77/],
    [{ id: 'fadestr', room: 'r', type: 'box', at: [300, 250], fade: 'sometimes' }, /is not "auto", "never"/],
    [{ id: 'badtype', room: 'r', type: 'Box!', at: [300, 250] }, /no valid type/],
    [{ id: 'badat', room: 'r', type: 'box', at: [1] }, /`at` is not \[x, y\]/],
    [{ id: 'nocentre', room: 'r', type: 'box', wall: 1 }, /no numeric `centre`/],
    [{ id: 'offspan', room: 'r', type: 'box', wall: 1, centre: 600 }, /centre 600 is outside wall 1.s span \(95\.\.505\)/]
  ];
  cases.forEach(([item, re]) => {
    let out;
    try { out = compileF([item]); } catch (e) { check(item.id + ': does not throw', false, String(e)); return; }
    check(item.id + ': skipped', out.value.furniture.length === 0, out.value.furniture);
    check(item.id + ': warns ' + re, out.warnings.some(w => re.test(w)), out.warnings);
  });
  const { value: h, warnings } = compileF([
    { id: 'dup', room: 'r', type: 'box', at: [300, 250] },
    { id: 'dup', room: 'r', type: 'box', at: [200, 200] }
  ]);
  check('duplicate id: keeps the first', h.furniture.length === 1 && h.furniture[0].x === 300, h.furniture);
  check('duplicate id: warns', warnings.some(w => /duplicate id/.test(w)), warnings);

  const { value: none } = compileF(undefined);
  check('no furniture key -> []', Array.isArray(none.furniture) && none.furniture.length === 0);
}

// ---- 4. pass-through: fade, priority, params ---------------------------------
{
  const params = { width: 80, color: '#112233' };
  const { value: h } = compileF([
    { id: 'a', room: 'r', type: 'box', at: [300, 250], fade: { wall: 2 }, priority: 'minor', params: params, label: 'A' },
    { id: 'b', room: 'r', type: 'box', at: [300, 250], fade: 'never' },
    { id: 'c', room: 'r', type: 'box', at: [300, 250] }
  ]);
  const f = id => h.furniture.find(x => x.id === id);
  check('fade {wall} passes through', f('a').fade && f('a').fade.wall === 2, f('a').fade);
  check('fade never passes through', f('b').fade === 'never');
  check('fade defaults to auto', f('c').fade === 'auto');
  check('priority minor passes through; default normal', f('a').priority === 'minor' && f('c').priority === 'normal');
  check('params copied, not aliased', f('a').params.width === 80 && f('a').params !== params);
  check('params default to {}', f('c').params && Object.keys(f('c').params).length === 0);
}

// ---- 5. pickFadeWall ----------------------------------------------------------
{
  const walls = [
    { id: 1, x1: 95, y1: 95, x2: 505, y2: 95, thickness: 10, outer: 1 },
    { id: 3, x1: 95, y1: 95, x2: 95, y2: 405, thickness: 10, outer: 0 },
    { id: 5, x1: 600, y1: 0, x2: 600, y2: 400, thickness: 10, outer: 1 }
  ];
  // A fridge 10 cm off the north exterior wall.
  const near1 = P.footprintRect(300, 110, 0, 60, 65);
  check('pickFadeWall: exterior wall within 30 cm', P.pickFadeWall(near1, walls) === 1, near1);
  const far1 = P.footprintRect(300, 140, 0, 60, 65);
  check('pickFadeWall: 40 cm away -> null', P.pickFadeWall(far1, walls) === null);
  // Against the interior west wall only: interior walls never fade.
  const byInterior = P.footprintRect(110, 250, 270, 60, 65);
  check('pickFadeWall: interior wall ignored', P.pickFadeWall(byInterior, walls) === null);
  // Nearest wins: 5 cm from wall 5 (x 595 face) and 20 cm from wall 1.
  const corner = [[520, 120], [590, 120], [590, 200], [520, 200]];
  const walls2 = walls.concat([{ id: 6, x1: 500, y1: 95, x2: 700, y2: 95, thickness: 10, outer: 1 }]);
  check('pickFadeWall: nearest face wins', P.pickFadeWall(corner, walls2) === 5, P.pickFadeWall(corner, walls2));
  // A rotated (non-axis) footprint has no parallel edge.
  check('pickFadeWall: rotated footprint -> null', P.pickFadeWall(P.footprintRect(300, 110, 30, 60, 65), walls) === null);
  // Tie on distance: the longer overlap wins.
  const tieWalls = [
    { id: 7, x1: 0, y1: 0, x2: 110, y2: 0, thickness: 10, outer: 1 },
    { id: 8, x1: 110, y1: 0, x2: 400, y2: 0, thickness: 10, outer: 1 }
  ];
  check('pickFadeWall: tie goes to the longer overlap',
    P.pickFadeWall([[100, 10], [200, 10], [200, 50], [100, 50]], tieWalls) === 8);
}

// ---- 6. finishes ---------------------------------------------------------------
{
  Fin.FINISHES.forEach(name => {
    const m = Fin.makeFinish(THREE, name, '#336699');
    check('finish ' + name + ': stamped', m.userData.finish === name, m.userData);
    check('finish ' + name + ': MeshStandardMaterial', m.isMeshStandardMaterial === true);
  });
  check('palette is the seven finishes', JSON.stringify(Fin.FINISHES) ===
    JSON.stringify(['matte', 'gloss', 'satin', 'metal', 'glass', 'mirror', 'emissive']), Fin.FINISHES);
  const matte = Fin.makeFinish(THREE, 'matte', '#336699');
  check('matte: roughness 0.8, metalness 0', matte.roughness === 0.8 && matte.metalness === 0);
  check('colour from hex string', matte.color.getHex() === 0x336699, matte.color.getHex());
  const gloss = Fin.makeFinish(THREE, 'gloss', 0x112233);
  check('gloss: roughness 0.25; colour from int', gloss.roughness === 0.25 && gloss.color.getHex() === 0x112233);
  const satin = Fin.makeFinish(THREE, 'satin', '#445566');
  check('satin: roughness 0.6, metalness 0', satin.roughness === 0.6 && satin.metalness === 0);
  const metal = Fin.makeFinish(THREE, 'metal');
  check('metal: roughness 0.35, metalness 0.9', metal.roughness === 0.35 && metal.metalness === 0.9);
  const glass = Fin.makeFinish(THREE, 'glass', '#ffffff');
  check('glass: transparent, opacity 0.25, no depthWrite, roughness 0.05',
    glass.transparent === true && glass.opacity === 0.25 && glass.depthWrite === false && glass.roughness === 0.05);
  const mirror = Fin.makeFinish(THREE, 'mirror', '#000000');
  check('mirror: roughness 0.02, metalness 1, light grey whatever colour is asked',
    mirror.roughness === 0.02 && mirror.metalness === 1 && mirror.color.getHex() !== 0);
  const em = Fin.makeFinish(THREE, 'emissive', '#ff8800');
  check('emissive: emissive equals the colour', em.emissive.getHex() === 0xff8800, em.emissive.getHex());
  check('matte is not emissive', matte.emissive.getHex() === 0);
  const { value: bad, warnings } = quietly(() => Fin.makeFinish(THREE, 'shiny', '#123456'));
  check('unknown finish falls back to matte, stamped matte', bad.userData.finish === 'matte' && bad.roughness === 0.8);
  check('unknown finish warns', warnings.some(w => /unknown finish "shiny"/.test(w)), warnings);
  check('kept finishes: glass, mirror, emissive', ['glass', 'mirror', 'emissive'].every(Fin.isKeptFinish) &&
    !['matte', 'gloss', 'satin', 'metal'].some(Fin.isKeptFinish));
}

// ---- 6b. the tag readers: mesh OR material, agreeing when both ---------------
{
  const plainMat = () => new THREE.MeshStandardMaterial();
  const mk = (meshTags, matTags) => {
    const mat = plainMat();
    Object.assign(mat.userData, matTags || {});
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    Object.assign(m.userData, meshTags || {});
    return m;
  };
  check('partFinish: tag on the material only', Fin.partFinish(mk(null, { finish: 'metal' })).finish === 'metal');
  check('partFinish: tag on the mesh only', Fin.partFinish(mk({ finish: 'gloss' }, null)).finish === 'gloss');
  check('partFinish: both, agreeing', Fin.partFinish(mk({ finish: 'glass' }, { finish: 'glass' })).finish === 'glass');
  const dis = Fin.partFinish(mk({ finish: 'glass' }, { finish: 'matte' }));
  check('partFinish: both, disagreeing -> error', dis.finish === null && /mesh says "glass" but its material says "matte"/.test(dis.error), dis);
  const none = Fin.partFinish(mk(null, null));
  check('partFinish: neither -> error', none.finish === null && /no userData.finish/.test(none.error), none);
  const off = Fin.partFinish(mk({ finish: 'velvet' }, null));
  check('partFinish: off-palette on the mesh -> error', off.finish === null && /not in the palette/.test(off.error), off);
  check('partFinish: makeFinish material passes', Fin.partFinish(new THREE.Mesh(new THREE.BoxGeometry(), Fin.makeFinish(THREE, 'mirror'))).finish === 'mirror');
  const multi = new THREE.Mesh(new THREE.BoxGeometry(), [Fin.makeFinish(THREE, 'matte'), Fin.makeFinish(THREE, 'glass')]);
  check('partFinish: per material of a multi-material mesh', Fin.partFinish(multi, multi.material[1]).finish === 'glass');

  check('partKeep: on the mesh', Fin.partKeep(mk({ keep: true }, null)).keep === true);
  check('partKeep: on the material', Fin.partKeep(mk(null, { keep: true })).keep === true);
  check('partKeep: neither -> undefined', Fin.partKeep(mk(null, null)).keep === undefined);
  const kd = Fin.partKeep(mk({ keep: true }, { keep: false }));
  check('partKeep: both, disagreeing -> error', kd.error && /keep=true but its material keep=false/.test(kd.error), kd);
  check('partKeep: both, agreeing', Fin.partKeep(mk({ keep: true }, { keep: true })).keep === true);
}

// A builder that tags MESHES (not materials) -- as the spec crews were told
// to -- must pass the contract checks below exactly as makeFinish() output does.
function meshTaggedBuild(T, p) {
  const g = new T.Group();
  const body = new T.Mesh(new T.BoxGeometry(p.width / 100, p.height / 100, p.depth / 100), new T.MeshStandardMaterial());
  body.geometry.translate(0, p.height / 200, p.depth / 200);
  body.userData.finish = 'matte';
  const screen = new T.Mesh(new T.PlaneGeometry(p.width / 200, p.height / 200), new T.MeshStandardMaterial());
  screen.position.set(0, p.height / 200, p.depth / 100);
  screen.userData.finish = 'emissive';
  screen.userData.keep = true;
  g.add(body, screen);
  return g;
}

// ---- 7. every built type meets the builder contract ---------------------------
// This is the gate for every builder that lands in src/furniture/, not just
// the box: it loops over each registry type whose module EXISTS (a
// multi-type module through its TYPES[key]) and builds it at its DEFAULTS.
//   - build() returns a THREE.Group
//   - bbox == DEFAULTS width/depth/height within 0.5 cm, x centred on 0
//   - bottom at y = 0, back at z = 0 (front toward +z)
//   - every material's userData.finish is in the palette
//   - every glass / mirror / emissive part is marked userData.keep
//   - detail 'low' has no more triangles than 'full'
function bboxCm(group) {
  group.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(group);
  return { minX: b.min.x * 100, maxX: b.max.x * 100, minY: b.min.y * 100, maxY: b.max.y * 100, minZ: b.min.z * 100, maxZ: b.max.z * 100 };
}
function triangles(group) {
  let n = 0;
  group.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const count = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    n += (count / 3) * (o.isInstancedMesh ? o.count : 1);
  });
  return n;
}
function meshParts(group) {
  const parts = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => parts.push({ mesh: o, material: m }));
  });
  return parts;
}
/** Every contract check on one built group. `tag` names it; `p` is the resolved params. */
function checkContract(tag, build, p) {
  let full, low;
  try {
    full = build(THREE, p, { detail: 'full' });
    low = build(THREE, p, { detail: 'low' });
  } catch (e) {
    check(tag + ': builds without throwing', false, String(e && e.stack || e));
    return;
  }
  check(tag + ': build() returns a THREE.Group', !!full && full.isGroup === true);
  if (!full || !full.isObject3D) return;
  const b = bboxCm(full);
  check(tag + ': width == params within 0.5 cm', Math.abs((b.maxX - b.minX) - p.width) <= 0.5, { bbox: b, width: p.width });
  check(tag + ': centred on x', Math.abs((b.maxX + b.minX) / 2) <= 0.5, b);
  check(tag + ': bottom at y = 0', Math.abs(b.minY) <= 0.5, b);
  check(tag + ': height == params within 0.5 cm', Math.abs(b.maxY - b.minY - p.height) <= 0.5, { bbox: b, height: p.height });
  check(tag + ': back at z = 0', Math.abs(b.minZ) <= 0.5, b);
  check(tag + ': depth == params within 0.5 cm, toward +z', Math.abs(b.maxZ - b.minZ - p.depth) <= 0.5, { bbox: b, depth: p.depth });
  const parts = meshParts(full);
  check(tag + ': has meshes', parts.length > 0);
  // Tags are read through partFinish/partKeep ONLY -- the same reader the
  // merge uses: mesh OR material may carry them, and if both do they agree.
  const named = x => (x.mesh.name || x.mesh.type);
  const badFinish = parts.map(x => ({ x, r: Fin.partFinish(x.mesh, x.material) })).filter(o => o.r.error);
  check(tag + ': every part has a palette userData.finish (mesh or material)', badFinish.length === 0,
    badFinish.map(o => named(o.x) + ': ' + o.r.error));
  const badKeep = parts.map(x => ({ x, r: Fin.partKeep(x.mesh, x.material) })).filter(o => o.r.error);
  check(tag + ': mesh and material keep flags agree where both are set', badKeep.length === 0,
    badKeep.map(o => named(o.x) + ': ' + o.r.error));
  const unkept = parts.filter(x => {
    const f = Fin.partFinish(x.mesh, x.material).finish;
    return f && Fin.isKeptFinish(f) && Fin.partKeep(x.mesh, x.material).keep !== true;
  });
  check(tag + ': glass/mirror/emissive parts are marked keep (mesh or material)', unkept.length === 0,
    unkept.map(x => named(x) + ':' + Fin.partFinish(x.mesh, x.material).finish));
  if (low && low.isObject3D) {
    const tf = triangles(full), tl = triangles(low);
    check(tag + ': detail low has no more triangles than full', tl <= tf, { full: tf, low: tl });
  } else {
    check(tag + ": detail 'low' returns a Group", false);
  }
}
{
  check('box: TYPE', Box.TYPE === 'box');
  check('box: DEFAULTS frozen with width/depth/height', Object.isFrozen(Box.DEFAULTS) &&
    ['width', 'depth', 'height'].every(k => typeof Box.DEFAULTS[k] === 'number'));

  const covered = [];
  for (const [t, entry] of Object.entries(R.REGISTRY)) {
    if (!fs.existsSync(path.join(root, 'src/furniture', entry.path))) continue;
    let impl;
    try {
      const mod = await imp('src/furniture/' + entry.path);
      impl = entry.key ? (mod.TYPES && mod.TYPES[entry.key]) : mod;
    } catch (e) {
      check(t + ': module loads', false, String(e));
      continue;
    }
    const ok = !!impl && !!impl.DEFAULTS && typeof impl.build === 'function' &&
      ['width', 'depth', 'height'].every(k => typeof impl.DEFAULTS[k] === 'number');
    check(t + ': exports DEFAULTS (with numeric width/depth/height) and build()', ok,
      impl && impl.DEFAULTS && { width: impl.DEFAULTS.width, depth: impl.DEFAULTS.depth, height: impl.DEFAULTS.height });
    if (!ok) continue;
    covered.push(t);
    if (typeof impl.prepare === 'function') {
      // A type with async assets (model.js): its DEFAULTS name no file, so
      // prepare it with a stand-in (a lopsided box, off-centre, so the fit
      // is exercised) and hold build() to the same contract as every other.
      const src = 'contract/' + t + '.glb';
      await impl.prepare([{ params: { src }, assetBase: '' }], { loadGltf: async () => {
        const scene = new THREE.Group();
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.3), new THREE.MeshStandardMaterial());
        m.position.set(0.5, 0.3, -0.2);
        scene.add(m);
        return { scene };
      } });
      checkContract(t + ' (defaults, prepared)', (T, p, o) => impl.build(T, p, Object.assign({ assetBase: '' }, o)),
        Object.assign({}, impl.DEFAULTS, { src }));
      continue;
    }
    checkContract(t + ' (defaults)', impl.build, Object.assign({}, impl.DEFAULTS));
  }
  check('contract loop covers box', covered.includes('box'), covered);
  console.log('builder contract checked for: ' + covered.join(', '));

  // The box also at other sizes, and with a kept finish.
  [{ width: 120, depth: 35, height: 75 }, { width: 13, depth: 90, height: 201.5, finish: 'glass' }].forEach(params => {
    checkContract('box ' + JSON.stringify(params), Box.build, Object.assign({}, Box.DEFAULTS, params));
  });
  checkContract('mesh-tagged builder', meshTaggedBuild, { width: 60, depth: 20, height: 40 });

  let glassKept = false;
  Box.build(THREE, { finish: 'glass' }).traverse(o => { if (o.isMesh) glassKept = o.userData.keep === true; });
  check('box: a glass box is flagged keep', glassKept);

  // The checker itself must be able to fail: a deliberately broken builder
  // (back at the middle, emissive part not kept, low detail heavier) trips it.
  const before = failures;
  const brokenBuild = (T, p, o) => {
    const g = new T.Group();
    const segs = o && o.detail === 'low' ? 16 : 1;
    const m = new T.Mesh(new T.BoxGeometry(p.width / 100, p.height / 100, p.depth / 100, segs, segs, segs),
      Fin.makeFinish(T, 'emissive', '#ffffff'));
    m.position.y = p.height / 200;   // back NOT moved to z = 0
    g.add(m);
    return g;
  };
  const savedError = console.error;
  const caught = [];
  console.error = m => caught.push(String(m));
  checkContract('broken probe', brokenBuild, { width: 50, depth: 40, height: 30 });
  console.error = savedError;
  const tripped = failures - before;
  failures = before;                     // the probe's failures are expected
  check('contract checker trips on a broken builder (back, keep, low detail)',
    tripped === 3 && caught.some(m => /back at z = 0/.test(m)) && caught.some(m => /marked keep/.test(m)) &&
    caught.some(m => /no more triangles/.test(m)), caught);
}

// ---- 8. the registry -------------------------------------------------------------
{
  const types = Object.keys(R.REGISTRY);
  check('registry is alphabetical', JSON.stringify(types) === JSON.stringify(types.slice().sort()), types);
  types.forEach(t => {
    const e = R.REGISTRY[t];
    check('registry ' + t + ': path is a .js file in this directory', typeof e.path === 'string' && /^[a-z][a-z0-9-]*\.js$/.test(e.path), e);
    check('registry ' + t + ': key is null or a string', e.key === null || typeof e.key === 'string', e);
    check('registry ' + t + ': spec is null or a Spec page name', e.spec === null || /^[A-Z][A-Za-z]*Spec$/.test(e.spec), e);
  });
  check('registry: box is registered', R.registryEntry('box') && R.registryEntry('box').path === 'box.js');
  check('registry: unknown type -> null', R.registryEntry('spaceship') === null);
  check('registry: no prototype leaks', R.registryEntry('toString') === null);

  // The ?v= cache-bust.
  const u1 = R.moduleUrl('radiator', { version: '1.4.2' });
  check('moduleUrl: carries the explicit version', /\/src\/furniture\/radiator\.js\?v=1\.4\.2$/.test(u1), u1);
  const u2 = R.moduleUrl('speaker', { version: '9' });
  check('moduleUrl: a multi-type entry resolves to its module file', /\/small-items\.js\?v=9$/.test(u2), u2);
  delete globalThis.HOME3D_CONFIG;
  check('moduleUrl: no version anywhere -> no ?v=', !/\?v=/.test(R.moduleUrl('box')), R.moduleUrl('box'));
  globalThis.HOME3D_CONFIG = { version: '2.0.1' };
  check('moduleUrl: falls back to HOME3D_CONFIG.version', /box\.js\?v=2\.0\.1$/.test(R.moduleUrl('box')), R.moduleUrl('box'));
  globalThis.HOME3D_CONFIG = { version: '__' + 'VERSION' + '__' };
  check('moduleUrl: an unstamped placeholder is not a version', !/\?v=/.test(R.moduleUrl('box')), R.moduleUrl('box'));
  delete globalThis.HOME3D_CONFIG;
  // Imported the way index.html imports everything -- with ?v= on the URL --
  // the registry passes its own version on to the builders it loads.
  const Rv = await import(url('src/furniture/registry.js') + '?v=7.7.7');
  const u3 = Rv.moduleUrl('sofa');
  check('moduleUrl: inherits the ?v= the registry was imported with', /\/sofa\.js\?v=7\.7\.7$/.test(u3), u3);
  check('moduleUrl: explicit version beats the inherited one', /\?v=8$/.test(Rv.moduleUrl('sofa', { version: '8' })));
  check('moduleUrl: unregistered type -> null', R.moduleUrl('spaceship') === null);

  // Loading.
  const warnings = [];
  const box = await R.loadBuilder('box', { warnings });
  check('loadBuilder box: loads the real module', box && box.type === 'box' && typeof box.build === 'function' &&
    box.DEFAULTS === Box.DEFAULTS, box);
  const missingW = [];
  const { value: missing } = await quietlyAsync(() => R.loadBuilder('bed', {
    warnings: missingW, registry: { bed: { path: 'no-such-module-here.js', key: null, spec: null } }
  }));
  check('loadBuilder: a module that does not exist -> null, no throw', missing === null);
  check('loadBuilder: ... and warns', missingW.some(w => /"bed" has no builder yet/.test(w)), missingW);
  const unregW = [];
  const { value: unreg } = await quietlyAsync(() => R.loadBuilder('spaceship', { warnings: unregW }));
  check('loadBuilder: unregistered -> null', unreg === null && unregW.some(w => /not registered/.test(w)), unregW);

  // Multi-type modules: TYPES[key].
  const fakeKitchen = {
    TYPES: {
      'kitchen-base-run': { DEFAULTS: { width: 1, depth: 2, height: 3 }, build: () => 'base' },
      'fridge-freezer': { DEFAULTS: { width: 4, depth: 5, height: 6 }, build: () => 'fridge' }
    }
  };
  const seen = [];
  const importer = u => { seen.push(u); return Promise.resolve(fakeKitchen); };
  const base = await R.loadBuilder('kitchen-base-run', { importer, version: '3' });
  const fridge = await R.loadBuilder('fridge-freezer', { importer, version: '3' });
  check('multi-type: picks TYPES[key]', base && base.build() === 'base' && base.DEFAULTS.width === 1, base);
  check('multi-type: another key from the same module', fridge && fridge.build() === 'fridge', fridge);
  check('multi-type: imported from kitchen.js with ?v=', seen.length === 2 && seen.every(u => /\/kitchen\.js\?v=3$/.test(u)), seen);
  const wrongW = [];
  const { value: wrong } = await quietlyAsync(() => R.loadBuilder('kitchen-wall-run', { importer, warnings: wrongW }));
  check('multi-type: a key the module lacks -> null + warning',
    wrong === null && wrongW.some(w => /TYPES\["kitchen-wall-run"\]/.test(w)), wrongW);
  const flatW = [];
  const { value: flat } = await quietlyAsync(() => R.loadBuilder('sofa', { importer: () => Promise.resolve({ TYPE: 'sofa' }), warnings: flatW }));
  check('single-type: a module without build/DEFAULTS -> null + warning',
    flat === null && flatW.some(w => /does not export DEFAULTS and build/.test(w)), flatW);

  const { value: many } = await quietlyAsync(() => R.loadBuilders(['box', 'box', 'spaceship']));
  check('loadBuilders: dedupes and keeps only what loaded', many.size === 1 && many.has('box'), [...many.keys()]);
}

// ---- 8b. every declared KIND through the house path ---------------------------------
// A type with several kinds whose envelopes differ (wall-clock 'diy-words',
// wall-sconce 'up-down') used to be merged onto the module's generic DEFAULTS
// by furniture.js, so a house item giving only `{ kind }` declared the
// DEFAULT kind's envelope while build() drew its own (item 7c056b3e:
// diy-words declared 30 x 30, built 49.8 x 39, bottom 4.5 cm below y = 0).
// Every kind enumerated from houses/schema.json -- each furnitureParams_*
// block with a `kind` enum -- is built through buildFurnitureSync with ONLY
// `{ kind }`, and the group build() returns must fill exactly the params
// furniture.js handed it, bottom at y = 0.
//
// KNOWN_KIND_EXCEPTIONS: a kind listed here is a KNOWN mismatch owned by
// territory this test's PR may not edit. Each entry must carry a follow-up
// item id; an entry whose kind now PASSES fails the test, so the list cannot
// quietly outlive the bug it excuses. Empty today: every kind passes.
const KNOWN_KIND_EXCEPTIONS = {
  // 'type:kind': 'follow-up item id -- why',
};
{
  const F = await imp('src/furniture.js');
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'houses/schema.json'), 'utf8'));
  const defs = schema.$defs || schema.definitions || {};
  const kinds = [];
  Object.keys(defs).forEach(k => {
    if (!k.startsWith('furnitureParams_')) return;
    const kp = (defs[k].properties || {}).kind;
    if (kp && Array.isArray(kp.enum)) kp.enum.forEach(kind => kinds.push({ type: k.slice('furnitureParams_'.length), kind }));
  });
  // Guard the enumeration itself: if the schema shape moved, this section
  // must not pass by checking nothing.
  ['wall-clock:diy-words', 'wall-sconce:up-down', 'wall-clock:framed'].forEach(tk =>
    check('kind sweep: schema enumerates ' + tk, kinds.some(x => x.type + ':' + x.kind === tk), kinds.length));
  const seenExceptions = new Set();
  for (const { type, kind } of kinds) {
    const tag = 'house path ' + type + ' {kind: ' + kind + '}';
    const real = (await quietlyAsync(() => R.loadBuilder(type))).value;
    check(tag + ': builder loads', !!real);
    if (!real) continue;
    let rec = null;
    const spy = Object.assign({}, real, {
      build: (T, p, o) => {
        const g = real.build(T, p, o);
        rec = { p: Object.assign({}, p), b: bboxCm(g) };
        return g;
      }
    });
    const item = { id: 'k', room: 'r', type, x: 0, y: 0, rotationDeg: 0, origin: 'centre', elevation: 0, params: { kind } };
    quietly(() => F.buildFurnitureSync(THREE, [item], new Map([[type, spy]]),
      { tx: x => x / 100, tz: y => y / 100, quality: { tier: 'high' }, walls: [] }));
    check(tag + ': build() was called', !!rec);
    if (!rec) continue;
    const { p, b } = rec;
    const fails = [];
    if (p.kind !== kind) fails.push('params.kind ' + p.kind);
    if (Math.abs((b.maxX - b.minX) - p.width) > 0.5) fails.push('width built ' + (b.maxX - b.minX).toFixed(2) + ' vs declared ' + p.width);
    if (Math.abs((b.maxY - b.minY) - p.height) > 0.5) fails.push('height built ' + (b.maxY - b.minY).toFixed(2) + ' vs declared ' + p.height);
    if (Math.abs((b.maxZ - b.minZ) - p.depth) > 0.5) fails.push('depth built ' + (b.maxZ - b.minZ).toFixed(2) + ' vs declared ' + p.depth);
    if (Math.abs(b.minY) > 0.5) fails.push('bottom at y = ' + b.minY.toFixed(2));
    const key = type + ':' + kind;
    if (Object.prototype.hasOwnProperty.call(KNOWN_KIND_EXCEPTIONS, key)) {
      seenExceptions.add(key);
      check(tag + ': listed as a known exception but now passes -- remove it from KNOWN_KIND_EXCEPTIONS',
        fails.length > 0, KNOWN_KIND_EXCEPTIONS[key]);
      continue;
    }
    check(tag + ': built envelope == declared params, bottom at y = 0', fails.length === 0, fails);
  }
  Object.keys(KNOWN_KIND_EXCEPTIONS).forEach(key =>
    check('known kind exception ' + key + ' still names a schema kind', seenExceptions.has(key)));

  // The registry carries defaultsFor through, and refuses a non-function.
  const clock = await R.loadBuilder('wall-clock');
  check('loadBuilder wall-clock: copies defaultsFor', clock && typeof clock.defaultsFor === 'function' &&
    clock.defaultsFor({ kind: 'diy-words' }).width === 49.8 && clock.defaultsFor({}) === clock.DEFAULTS, clock && clock.defaultsFor);
  const sconce = await R.loadBuilder('wall-sconce');
  check('loadBuilder wall-sconce: copies defaultsFor', sconce && typeof sconce.defaultsFor === 'function' &&
    sconce.defaultsFor({ kind: 'up-down' }).depth === 6 && sconce.defaultsFor({ kind: 'swing-arm-globe' }) === sconce.DEFAULTS);
  const badW = [];
  const { value: bad } = await quietlyAsync(() => R.loadBuilder('box', { warnings: badW,
    importer: () => Promise.resolve({ DEFAULTS: { width: 1, depth: 1, height: 1 }, build: () => null, defaultsFor: { width: 9 } }) }));
  check('loadBuilder: a non-function defaultsFor is dropped with a warning',
    bad && bad.defaultsFor === undefined && badW.some(w => /defaultsFor but it is not a function/.test(w)), badW);
}

// ---- 9. no file in src/furniture imports three ------------------------------------
// THREE is injected. A builder that imports it itself -- by the bare
// specifier, by a path into vendor/, or dynamically -- gets a SECOND copy of
// three in the page (different class identities, so instanceof checks and
// the merge break) and cannot load from the spec pages' import map at all.
//
// Comments are stripped first, so a doc comment saying "no `import 'three'`"
// is not a hit. A dynamic import() whose argument is not a string literal is
// refused in builders outright: it cannot be checked, and a builder has no
// reason to load anything at runtime. registry.js is the one module whose job
// is exactly that.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}
const isThreeSpecifier = s =>
  s === 'three' || /^three\//.test(s) || /(^|\/)vendor\/three/.test(s) ||
  /(^|\/)three(-r\d+)?(\/|$)/.test(s) || /(^|\/)three(\.module)?(\.min)?\.(m?js)(\?|$)/.test(s);
function threeImportProblems(src, allowDynamic) {
  const code = stripComments(src);
  const problems = [];
  const specRes = [
    /\bimport\s+(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,   // import x from '...'; import '...'
    /\bexport\s+[\w$*{}\s,]*?\s*from\s*['"]([^'"]+)['"]/g,         // export ... from '...'
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,                   // import('...')
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g                   // require('...')
  ];
  specRes.forEach(re => {
    let m;
    while ((m = re.exec(code))) if (isThreeSpecifier(m[1])) problems.push(m[0]);
  });
  if (!allowDynamic) {
    const dyn = /\bimport\s*\(\s*(?!['"`][^'"`]*['"`]\s*\))/g;
    let m;
    while ((m = dyn.exec(code))) problems.push('non-literal ' + m[0].trim());
  }
  return problems;
}
{
  // The detector itself, on the shapes that must and must not trip it.
  const bad = [
    "import * as THREE from 'three';",
    "import 'three';",
    "import { Mesh } from \"three\";",
    "import * as T from '../../vendor/three-r160/three.module.min.js';",
    "import * as T from '../../vendor/three-r160/three.module.min.js?v=1';",
    "const T = await import('three');",
    "const T = await import('../../vendor/three-r160/three.module.min.js');",
    "import('three').then(t => t);",
    "export { Mesh } from 'three';",
    "const t = require('three');",
    "const u = 'x'; const T = await import(u);"
  ];
  const good = [
    "/** no `import 'three'` here */ export const TYPE = 'x';",
    "// import * as THREE from 'three';\nexport const a = 1;",
    "import { makeFinish } from './finishes.js';",
    "export function build(THREE, params) { return new THREE.Group(); }",
    "const url = 'https://example.com/three';"
  ];
  bad.forEach(src => check('no-three detector catches: ' + src, threeImportProblems(src, false).length > 0));
  good.forEach(src => check('no-three detector allows: ' + src, threeImportProblems(src, false).length === 0,
    threeImportProblems(src, false)));

  const dir = path.join(root, 'src/furniture');
  fs.readdirSync(dir).filter(f => f.endsWith('.js')).forEach(f => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    let problems = threeImportProblems(src, f === 'registry.js');
    // The ONE exemption: model.js lazily imports the vendored GLTFLoader
    // (which itself imports three) -- by this exact literal path only. It
    // turns the parse into plain typed arrays at once and builds every
    // object from the INJECTED THREE, so nothing from the loader's three
    // instance reaches the scene (scripts/test-model.mjs).
    if (f === 'model.js') {
      problems = problems.filter(x => x !== "import('../../vendor/three-r160/addons/loaders/GLTFLoader.js')");
    }
    check(f + ': does not import three (THREE is injected)', problems.length === 0, problems);
  });
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
