#!/usr/bin/env node
/**
 * Radiator furniture module: the shared src/furniture/* builder contract
 * (as scripts/test-furniture-core.mjs enforces it), applied to
 * src/furniture/radiator.js, plus the radiator's own geometry. No framework,
 * no install -- `node scripts/test-furniture-radiator.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   0. Contract surface: TYPE, frozen DEFAULTS, build + alias, no dead
 *      params.elevation (item 2bc314c9) in DEFAULTS or the schema.
 *   1. ENVELOPE: width/height/depth are everything built EXCEPT the pipes.
 *      At 'full' with a snug body the bbox of every non-pipe part equals them
 *      (DEFAULTS, every preset, a width sweep over every cover and valve
 *      side); at 'low' it never exceeds them. The pipes -- the one documented
 *      exception -- end at exactly -pipeDrop, stay inside the envelope's
 *      width and depth, and pipeDrop never changes anything else.
 *      params.elevation is ignored (the placer owns elevation).
 *   2. The body is VERTICALLY ribbed (the real radiators), with no horizontal
 *      fins; low detail is one plain slab.
 *   3. Valves sit on the body's ENDS: the smart valve beyond the valve-side
 *      end, its axis along x, 5.9 across and 9.5 long; the lockshield beyond
 *      the other end, always at the BOTTOM -- asserted against
 *      hard-coded expectations, not against the module's own helpers.
 *      Pipes reach the envelope bottom.
 *   4. Shelf: a board strictly ABOVE the body with a RAISED front lip,
 *      overhanging the face, running shelfExtendLeft/Right past the ends,
 *      with clips.
 *   5. Box: a framed slatted cover; the body is strictly inside it; every ray
 *      through the slat panel hits a slat or the DARK backing, never the
 *      radiator; the kick-out is open; bodyElevation lifts the body.
 *   6. No z-fighting: no two box/plane meshes share an overlapping face plane
 *      facing the same way, on every preset and cover.
 *   7. Merge fidelity: palette finishes, no textures, no lights, nothing
 *      emissive.
 *   8. Perf caps (perf audit B3): full <= 800 and low <= 250 triangles, and
 *      low <= 60% of full when full > 300, at DEFAULTS and every preset.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const R = await imp('src/furniture/radiator.js');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'houses/schema.json'), 'utf8'));

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const CM = 0.01;
const TOL = 0.5; // cm, the contract's bbox tolerance
const EPS = 1e-3; // cm, float32 geometry noise

function boxOf(obj) {
  obj.updateWorldMatrix(true, true);
  const b = new THREE.Box3().setFromObject(obj);
  return { minX: b.min.x / CM, maxX: b.max.x / CM, minY: b.min.y / CM, maxY: b.max.y / CM, minZ: b.min.z / CM, maxZ: b.max.z / CM };
}
const size = b => ({ w: b.maxX - b.minX, h: b.maxY - b.minY, d: b.maxZ - b.minZ });
/** Union bbox (cm) of every mesh whose name matches `keep`. */
function unionOf(g, keep) {
  let b = null;
  g.updateWorldMatrix(true, true);
  g.traverse(o => {
    if (!o.isMesh || !keep(o.name)) return;
    const x = boxOf(o);
    b = b ? { minX: Math.min(b.minX, x.minX), maxX: Math.max(b.maxX, x.maxX), minY: Math.min(b.minY, x.minY),
      maxY: Math.max(b.maxY, x.maxY), minZ: Math.min(b.minZ, x.minZ), maxZ: Math.max(b.maxZ, x.maxZ) } : x;
  });
  return b;
}
const nonPipe = g => unionOf(g, n => n !== 'pipe');
function find(g, name) { let f = null; g.traverse(o => { if (!f && o.name === name) f = o; }); return f; }
function findAll(g, re) { const out = []; g.traverse(o => { if (re.test(o.name)) out.push(o); }); return out; }
function triangles(group) {
  let t = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const idx = o.geometry.getIndex();
    t += idx ? idx.count / 3 : o.geometry.attributes.position.count / 3;
  });
  return t;
}
const merged = p => Object.assign({}, R.DEFAULTS, p);

// ---- 0. contract surface ---------------------------------------------------
{
  check('TYPE === "radiator"', R.TYPE === 'radiator', R.TYPE);
  check('DEFAULTS is frozen', Object.isFrozen(R.DEFAULTS));
  check('DEFAULTS has numeric width/depth/height',
    ['width', 'depth', 'height'].every(k => typeof R.DEFAULTS[k] === 'number'), R.DEFAULTS);
  check('DEFAULTS envelope is an 80-wide body plus 18 cm of valve room', R.DEFAULTS.width === 98 &&
    R.DEFAULTS.height === 60 && R.DEFAULTS.depth === 12 && R.DEFAULTS.thickness === 10 && R.DEFAULTS.cover === 'none', R.DEFAULTS);
  check('valve reaches sum to 18 cm', Math.abs(R.TRV_REACH_CM + R.LOCKSHIELD_REACH_CM - 18) < 1e-9,
    [R.TRV_REACH_CM, R.LOCKSHIELD_REACH_CM]);
  check('DEFAULTS body is 80 x 60 x 12', (() => { const b = R.bodyEnvelope(R.DEFAULTS); return Math.abs(b.width - 80) < 1e-9 && b.height === 60 && b.depth === 12; })(),
    R.bodyEnvelope(R.DEFAULTS));
  check('default valve corner is bottom-right', R.DEFAULTS.valveCorner === 'bottom-right');
  check('new params default to 0', R.DEFAULTS.bodyElevation === 0 && R.DEFAULTS.shelfExtendLeft === 0 && R.DEFAULTS.shelfExtendRight === 0 && R.DEFAULTS.pipeDrop === 0);
  check('wallGapOf(12, 10) === 2', R.wallGapOf(12, 10) === 2);
  check('buildRadiator alias === build', typeof R.build === 'function' && R.buildRadiator === R.build);
  check('DEFAULTS has no elevation key (dead param, use the item-level field)',
    !Object.prototype.hasOwnProperty.call(R.DEFAULTS, 'elevation'));
  const rs = schema.$defs && schema.$defs.furnitureParams_radiator;
  check('schema furnitureParams_radiator has no elevation property',
    !!rs && !Object.prototype.hasOwnProperty.call(rs.properties || {}, 'elevation'));
  check('schema carries bodyElevation / shelfExtendLeft / shelfExtendRight / pipeDrop',
    !!rs && ['bodyElevation', 'shelfExtendLeft', 'shelfExtendRight', 'pipeDrop'].every(k => rs.properties[k]));

  // Presets: one per real room, generic names, every one the SAME key set
  // (switching presets never leaves a stale value), each told apart by value.
  check('PRESETS: 5 rooms', R.PRESETS.length === 5, R.PRESETS.map(p => p.name));
  const keys0 = Object.keys(R.PRESETS[0].params).sort().join();
  check('PRESETS all set the same key set', R.PRESETS.every(p => Object.keys(p.params).sort().join() === keys0));
  check('PRESETS are pairwise different', new Set(R.PRESETS.map(p => JSON.stringify(p.params))).size === R.PRESETS.length);
  check('PRESETS carry a preset-level elevation, never a params.elevation',
    R.PRESETS.every(p => typeof p.elevation === 'number' && !('elevation' in p.params)));
  check('no "120 wide" or "80 wide, full slatted" preset survives',
    !R.PRESETS.some(p => /120 wide|full slatted/.test(p.name)));
  const hall = R.PRESETS.find(p => p.params.cover === 'box');
  check('hallway preset: 75x92x19 box, body 17 up, placed on the floor',
    !!hall && hall.params.width === 75 && hall.params.height === 92 && hall.params.depth === 19 &&
    hall.params.bodyElevation === 17 && hall.elevation === 0, hall);
  check('every preset keeps its authored body size (no clamp shrinks it)', R.PRESETS.every(p => {
    const b = R.bodyEnvelope(p.params);
    return Math.abs(b.width - p.params.bodyWidth) < EPS && Math.abs(b.height - p.params.bodyHeight) < EPS &&
      Math.abs(b.depth - p.params.bodyDepth) < EPS;
  }), R.PRESETS.map(p => [p.name, R.bodyEnvelope(p.params)]));
}

// ---- 1. envelope -----------------------------------------------------------
{
  const cases = [{ tag: 'DEFAULTS', p: {} }]
    .concat(R.PRESETS.map(p => ({ tag: 'preset ' + p.name, p: p.params })));
  for (const cover of R.COVERS) {
    for (const valveCorner of R.VALVE_CORNERS) {
      for (const width of [60, 98, 140]) {
        cases.push({ tag: `sweep ${cover}/${valveCorner}/${width}`,
          p: { width, height: cover === 'box' ? 80 : 64, depth: cover === 'box' ? 18 : 14, cover, valveCorner } });
      }
    }
  }
  for (const { tag, p } of cases) {
    const m = merged(p);
    const gFull = R.build(THREE, p, { detail: 'full' });
    const fb = nonPipe(gFull);
    const full = size(fb);
    const pipes = findAll(gFull, /^pipe$/);
    check(`${tag}: two pipes at full detail`, pipes.length === 2, pipes.length);
    for (const pp of pipes) {
      const pb = boxOf(pp);
      check(`${tag}: pipe ends at exactly -pipeDrop (${m.pipeDrop})`, Math.abs(pb.minY + m.pipeDrop) <= TOL, pb);
      check(`${tag}: pipe stays inside the envelope's width and depth`,
        pb.minX >= -m.width / 2 - EPS && pb.maxX <= m.width / 2 + EPS && pb.minZ >= -EPS && pb.maxZ <= m.depth + EPS, pb);
    }
    check(`${tag}: full bbox == width`, Math.abs(full.w - m.width) <= TOL, { full, width: m.width });
    check(`${tag}: full bbox == height`, Math.abs(full.h - m.height) <= TOL, { full, height: m.height });
    check(`${tag}: full bbox == depth`, Math.abs(full.d - m.depth) <= TOL, { full, depth: m.depth });
    check(`${tag}: centred on x, bottom at 0, back at 0`,
      Math.abs(fb.minX + m.width / 2) <= TOL && Math.abs(fb.maxX - m.width / 2) <= TOL &&
      Math.abs(fb.minY) <= TOL && fb.minZ >= -EPS && fb.minZ <= TOL, fb);
    const lb = boxOf(R.build(THREE, p, { detail: 'low' }));
    check(`${tag}: low bbox never leaves the envelope`,
      lb.minX >= -m.width / 2 - EPS && lb.maxX <= m.width / 2 + EPS && lb.minY >= -EPS &&
      lb.maxY <= m.height + EPS && lb.minZ >= -EPS && lb.maxZ <= m.depth + EPS, lb);
  }
  // an oversized body is clamped, never bigger than the envelope
  const over = size(boxOf(R.build(THREE, { bodyWidth: 500, bodyHeight: 500, bodyDepth: 500 }, {})));
  check('oversized body params are clamped to the envelope', Math.abs(over.w - 98) <= TOL && Math.abs(over.h - 60) <= TOL && Math.abs(over.d - 12) <= TOL, over);
  // wall gap: derived from bodyDepth - thickness; brackets bridge 0..gap only
  const panelBack = p => boxOf(find(R.build(THREE, p, {}), 'radiatorPanel')).minZ;
  check('body back sits at the wall gap (2 cm)', Math.abs(panelBack({}) - 2) < 0.01, panelBack({}));
  check('thinner slab, same bodyDepth -> bigger gap', panelBack({ depth: 20, bodyDepth: 12, thickness: 6 }) > panelBack({}) + 3);
  const tight = R.build(THREE, { bodyDepth: 12, thickness: 12 }, {});
  check('brackets never reach past the body back, even at wallGap 0',
    boxOf(find(tight, 'radiatorBracket_L')).maxZ <= boxOf(find(tight, 'radiatorPanel')).minZ + 0.02);
}

// ---- 1b. params.elevation is ignored; pipeDrop moves only the pipes --------
{
  const a = JSON.stringify(boxOf(R.build(THREE, {}, {})));
  check('params.elevation is ignored (the placer applies the item elevation)',
    JSON.stringify(boxOf(R.build(THREE, { elevation: 17 }, {}))) === a);
  const g0 = R.build(THREE, {}, {}), g17 = R.build(THREE, { pipeDrop: 17 }, {});
  check('pipeDrop leaves every non-pipe part where it was', JSON.stringify(nonPipe(g0)) === JSON.stringify(nonPipe(g17)));
  check('pipeDrop 17 takes both pipes to y = -17', findAll(g17, /^pipe$/).every(p => Math.abs(boxOf(p).minY + 17) < 0.01));
  const hall = R.PRESETS.find(p => p.params.cover === 'box');
  check('every preset: pipeDrop equals the item elevation it is placed at', R.PRESETS.every(p => p.params.pipeDrop === p.elevation),
    R.PRESETS.map(p => [p.params.pipeDrop, p.elevation]));
  check('hallway box pipes stop at the floor it stands on', hall.params.pipeDrop === 0);
}

// ---- 2. vertical ribs, no fins; low detail is one slab ----------------------
{
  const g = R.build(THREE, {}, { detail: 'full' });
  const ribs = findAll(g, /^radiatorRib_/);
  check('no horizontal fin meshes remain', findAll(g, /Fin/).length === 0);
  check('about 16 ribs on an 80-wide body (5 cm pitch)', ribs.length >= 14 && ribs.length <= 17, ribs.length);
  check('every rib is VERTICAL (much taller than wide)', ribs.every(r => { const s = size(boxOf(r)); return s.h > 8 * s.w; }),
    ribs.slice(0, 2).map(r => size(boxOf(r))));
  const face = boxOf(find(g, 'radiatorPanel')).maxZ;
  check('ribs stand proud of the slab face', ribs.every(r => boxOf(r).maxZ > face + 0.3), { face, rib: boxOf(ribs[0]) });
  const xs = ribs.map(r => { const b = boxOf(r); return (b.minX + b.maxX) / 2; }).sort((a, b) => a - b);
  check('ribs are spread along the width at ~5 cm', xs.length > 2 && Math.abs((xs[1] - xs[0]) - 5) < 0.6, xs.slice(0, 3));
  check('top grille slot lines present', findAll(g, /^radiatorGrilleSlot_/).length === ribs.length);
  const plateTop = boxOf(find(g, 'radiatorTopPlate')).maxY;
  check('grille slot lines stand >= 0.05 cm above the top plate (no z-fight)',
    findAll(g, /^radiatorGrilleSlot_/).every(l => boxOf(l).minY - plateTop >= 0.05), { plateTop, line: boxOf(findAll(g, /^radiatorGrilleSlot_/)[0]) });
  check('closed end caps present', !!find(g, 'radiatorEndCap_L') && !!find(g, 'radiatorEndCap_R'));
  const low = R.build(THREE, {}, { detail: 'low' });
  const lowMeshes = []; low.traverse(o => { if (o.isMesh) lowMeshes.push(o.name); });
  check('low detail with no cover is ONE plain slab', lowMeshes.length === 1 && lowMeshes[0] === 'radiatorPanel', lowMeshes);
}

// ---- 3. valves on the ENDS ---------------------------------------------------
for (const corner of R.VALVE_CORNERS) {
  const p = { valveCorner: corner };
  const g = R.build(THREE, p, { detail: 'full' });
  const smart = find(g, 'radiatorValveSmart'), ls = find(g, 'radiatorValveLockshield');
  check(`${corner}: both valves present`, !!smart && !!ls);
  if (!smart || !ls) continue;
  const body = boxOf(find(g, 'radiatorPanel')); // slab between the end caps
  const bodyX0 = boxOf(find(g, 'radiatorEndCap_L')).minX, bodyX1 = boxOf(find(g, 'radiatorEndCap_R')).maxX;
  const midY = (body.minY + body.maxY) / 2;
  const head = boxOf(find(smart, 'head'));
  const lsHead = boxOf(find(ls, 'head'));
  // hard-coded expectation per corner name (never derived from the module)
  const left = { 'bottom-left': true, 'top-left': true, 'bottom-right': false, 'top-right': false }[corner];
  const bottom = { 'bottom-left': true, 'bottom-right': true, 'top-left': false, 'top-right': false }[corner];
  check(`${corner}: smart head is BEYOND the ${left ? 'left' : 'right'} end, not on the face`,
    left ? head.maxX <= bodyX0 + EPS : head.minX >= bodyX1 - EPS, { head, bodyX0, bodyX1 });
  check(`${corner}: smart head is within the body's depth, not poking out of the front`,
    head.maxZ <= 12 + EPS && head.minZ >= 0, head);
  check(`${corner}: smart valve ${bottom ? 'low' : 'high'}`, bottom ? (head.minY + head.maxY) / 2 < midY : (head.minY + head.maxY) / 2 > midY, { head, midY });
  const hs = size(head);
  check(`${corner}: smart head axis along x, 9.5 long and 5.9 across`,
    Math.abs(hs.w - 9.5) < 0.2 && Math.abs(hs.h - 5.9) < 0.2 && Math.abs(hs.d - 5.9) < 0.2, hs);
  check(`${corner}: lockshield beyond the OTHER end`,
    left ? lsHead.minX >= bodyX1 - EPS : lsHead.maxX <= bodyX0 + EPS, { lsHead, bodyX0, bodyX1 });
  check(`${corner}: lockshield at the BOTTOM of the other end`, (lsHead.minY + lsHead.maxY) / 2 < midY, { lsHead, midY });
  // the display faces OUT along the wall (a back-facing plane is culled)
  const dispMesh = find(smart, 'display');
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(dispMesh.getWorldQuaternion(new THREE.Quaternion()));
  check(`${corner}: the display faces outward, away from the radiator`, left ? n.x < -0.99 : n.x > 0.99, n);
  // tiny decals must stand OFF the surface they sit on (no z-fight)
  const disp = boxOf(dispMesh);
  check(`${corner}: the display stands >= 0.05 cm off the head's end face`,
    left ? head.minX - disp.minX >= 0.05 : disp.maxX - head.maxX >= 0.05, { disp, head });
  // nothing the valves draw collides with anything else but its own group
  const vMeshes = []; smart.traverse(o => { if (o.isMesh) vMeshes.push(o); }); ls.traverse(o => { if (o.isMesh) vMeshes.push(o); });
  const hitsBody = vMeshes.filter(v => v.name !== 'pipe' && v.name !== 'valveBody').filter(v => {
    const a = boxOf(v); let hit = false;
    g.traverse(o => { if (o.isMesh && /^radiator(Panel|EndCap|TopPlate|Rib)/.test(o.name)) { const c = boxOf(o);
      if (a.minX < c.maxX - EPS && a.maxX > c.minX + EPS && a.minY < c.maxY - EPS && a.maxY > c.minY + EPS && a.minZ < c.maxZ - EPS && a.maxZ > c.minZ + EPS) hit = true; } });
    return hit;
  });
  check(`${corner}: valve heads and display clear the radiator body`, hitsBody.length === 0, hitsBody.map(v => v.name));
  check(`${corner}: lockshield cap is 3 across and 4 long`, Math.abs(size(lsHead).w - 4) < 0.2 && Math.abs(size(lsHead).h - 3) < 0.2, size(lsHead));
  for (const v of [smart, ls]) {
    const pipe = find(v, 'pipe');
    check(`${corner}: ${v.name} pipe runs down to the envelope bottom`, !!pipe && Math.abs(boxOf(pipe).minY) < 0.01, pipe && boxOf(pipe));
    check(`${corner}: ${v.name} pipe clears the body end`, !!pipe &&
      (boxOf(pipe).maxX <= bodyX0 + EPS || boxOf(pipe).minX >= bodyX1 - EPS), pipe && boxOf(pipe));
  }
  check(`${corner}: no LED / nothing emissive`, (() => { let e = false; g.traverse(o => { if (o.isMesh && (o.userData.finish === 'emissive' || (o.material.emissive && o.material.emissive.getHex() !== 0))) e = true; }); return !e; })());
}
{
  const a = find(R.build(THREE, { valveCorner: 'nonsense' }, {}), 'radiatorValveSmart');
  const b = find(R.build(THREE, {}, {}), 'radiatorValveSmart');
  check('invalid valveCorner falls back to the default', JSON.stringify(boxOf(find(a, 'head'))) === JSON.stringify(boxOf(find(b, 'head'))));
  for (const c of R.VALVE_CORNERS) check(`oppositeCorner is an involution (${c})`, R.oppositeCorner(R.oppositeCorner(c)) === c && R.oppositeCorner(c) !== c);
  const low = R.build(THREE, {}, { detail: 'low' });
  check('low detail drops the valves', findAll(low, /^radiatorValve/).length === 0);
}

// ---- 4. shelf ------------------------------------------------------------
{
  const bed = R.PRESETS.find(p => /Bedroom/.test(p.name)).params;
  const liv = R.PRESETS.find(p => /Living room/.test(p.name)).params;
  for (const [tag, p] of [['bedroom', bed], ['living room', liv], ['DEFAULTS+shelf', { cover: 'shelf' }]]) {
    for (const detail of ['full', 'low']) {
      const g = R.build(THREE, p, { detail });
      const board = find(g, 'coverShelf'), lip = find(g, 'coverShelfLip');
      check(`${tag} (${detail}): board and lip present`, !!board && !!lip);
      if (!board || !lip) continue;
      const bb = boxOf(board), lb = unionOf(g, n => /^coverShelfLip/.test(n));
      if (detail === 'full') {
        const round = find(g, 'coverShelfLipRound');
        check(`${tag}: the lip has a rounded top`, !!round && Math.abs(boxOf(round).maxY - lb.maxY) < EPS &&
          boxOf(round).minY > bb.maxY + 0.1, round && boxOf(round));
      }
      let bodyTop = -Infinity, bodyFront = -Infinity, bodyX0 = Infinity, bodyX1 = -Infinity;
      g.traverse(o => {
        if (o.isMesh && /^radiator/.test(o.name) && !/Valve|pipe|head|valveBody|display/.test(o.name) && !/^radiatorBracket/.test(o.name)) {
          const b = boxOf(o); bodyTop = Math.max(bodyTop, b.maxY); bodyFront = Math.max(bodyFront, b.maxZ);
          bodyX0 = Math.min(bodyX0, b.minX); bodyX1 = Math.max(bodyX1, b.maxX);
        }
      });
      check(`${tag} (${detail}): board sits STRICTLY above the body (no coplanar/through)`, bb.minY > bodyTop + EPS, { board: bb.minY, bodyTop });
      check(`${tag} (${detail}): board rests close on the body (within 0.5 cm)`, bb.minY - bodyTop <= 0.5, { board: bb.minY, bodyTop });
      check(`${tag} (${detail}): the lip is RAISED -- it stands on the board's top, not below it`,
        lb.minY >= bb.maxY - EPS && lb.maxY > bb.maxY + 1, { lip: lb, board: bb });
      check(`${tag} (${detail}): the lip runs along the FRONT edge`, Math.abs(lb.maxZ - bb.maxZ) < EPS && size(lb).d < 2, { lip: lb, board: bb });
      check(`${tag} (${detail}): the board overhangs the radiator face`, bb.maxZ > bodyFront + 0.9, { board: bb.maxZ, bodyFront });
      const m = merged(p);
      // (never less than 0.5, so the shelf always covers its clips)
      check(`${tag} (${detail}): shelf runs shelfExtendLeft/Right past the body ends`,
        Math.abs((bodyX0 - bb.minX) - Math.max(0.5, m.shelfExtendLeft)) < 0.01 && Math.abs((bb.maxX - bodyX1) - Math.max(0.5, m.shelfExtendRight)) < 0.01,
        { left: bodyX0 - bb.minX, right: bb.maxX - bodyX1, m: [m.shelfExtendLeft, m.shelfExtendRight] });
      if (detail === 'full') {
        const clips = ['coverShelfClip_L', 'coverShelfClip_R'].map(n => find(g, n));
        check(`${tag}: a clip hooks over each end`, clips.every(Boolean));
        check(`${tag}: each clip hangs from the shelf (under the board, inside its span)`, clips.every(c => {
          const cb = boxOf(c); return cb.minX >= bb.minX - EPS && cb.maxX <= bb.maxX + EPS && Math.abs(cb.maxY - bb.minY) < 0.01;
        }), clips.map(c => c && boxOf(c)));
        const valveMeshes = []; g.traverse(o => { if (o.isMesh && /^(head|valveBody|pipe|display)$/.test(o.name)) valveMeshes.push(boxOf(o)); });
        check(`${tag}: clips clear every valve part and pipe`, clips.every(c => { const a = boxOf(c); return valveMeshes.every(v =>
          !(a.minX < v.maxX && a.maxX > v.minX && a.minY < v.maxY && a.maxY > v.minY && a.minZ < v.maxZ && a.maxZ > v.minZ)); }));
      }
      check(`${tag} (${detail}): the shelf is not an enclosure`, findAll(g, /^coverSide|^coverSlat|^coverStile/).length === 0);
    }
  }
  // living room: the shelf reaches out over the valve end
  const g = R.build(THREE, liv, {});
  const trv = boxOf(find(find(g, 'radiatorValveSmart'), 'head')), board = boxOf(find(g, 'coverShelf'));
  check('living room: the shelf overhangs the valve end (valve under the shelf)', board.minX < trv.maxX - 5 && trv.maxY < board.minY, { trv, board });
  // an explicit oversized bodyHeight still stays under the board
  const gh = R.build(THREE, { cover: 'shelf', bodyHeight: 500 }, {});
  check('explicit oversized bodyHeight on a shelf is clamped under the board',
    boxOf(find(gh, 'radiatorTopPlate')).maxY < boxOf(find(gh, 'coverShelf')).minY);
}

// ---- 5. box ---------------------------------------------------------------
function bodyBoxOf(g) {
  let b = null;
  g.traverse(o => {
    if (!o.isMesh || !/^radiator|^valveBody$|^head$|^display$/.test(o.name)) return;
    const x = boxOf(o);
    b = b ? { minX: Math.min(b.minX, x.minX), maxX: Math.max(b.maxX, x.maxX), minY: Math.min(b.minY, x.minY),
      maxY: Math.max(b.maxY, x.maxY), minZ: Math.min(b.minZ, x.minZ), maxZ: Math.max(b.maxZ, x.maxZ) } : x;
  });
  return b;
}
function sweepSlatPanel(g, p) {
  // rays straight in, every 2 mm across the slat panel at three heights
  const m = merged(p);
  const rc = new THREE.Raycaster();
  g.updateMatrixWorld(true);
  const res = { rays: 0, radiator: 0, backing: 0, slat: 0, other: [] };
  const slats = findAll(g, /^coverSlat_/).map(boxOf);
  const y0 = Math.min(...slats.map(s => s.minY)), y1 = Math.max(...slats.map(s => s.maxY));
  const x0 = Math.min(...slats.map(s => s.minX)), x1 = Math.max(...slats.map(s => s.maxX));
  for (const fy of [0.25, 0.5, 0.75]) {
    for (let x = x0 + 0.05; x < x1; x += 0.2) {
      rc.set(new THREE.Vector3(x * CM, (y0 + (y1 - y0) * fy) * CM, (m.depth + 5) * CM), new THREE.Vector3(0, 0, -1));
      const hits = rc.intersectObject(g, true);
      res.rays++;
      if (!hits.length) { res.other.push('nothing'); continue; }
      const n = hits[0].object.name;
      if (n === 'coverBacking') res.backing++;
      else if (/^coverSlat_/.test(n)) res.slat++;
      else if (/^radiator|^head$|^valveBody$|^pipe$|^display$/.test(n)) res.radiator++;
      else res.other.push(n);
    }
  }
  return res;
}
{
  const boxCases = [
    { tag: 'hallway preset', p: R.PRESETS.find(p => p.params.cover === 'box').params },
    { tag: 'DEFAULTS+box', p: { cover: 'box', height: 70, depth: 18 } },
    { tag: 'wide short box', p: { cover: 'box', width: 120, height: 60, depth: 17, valveCorner: 'bottom-left' } },
    { tag: 'tight box (depth == bodyDepth asked)', p: { cover: 'box', width: 80, height: 60, depth: 12, bodyDepth: 12 } },
  ];
  for (const { tag, p } of boxCases) {
    for (const detail of ['full', 'low']) {
      const g = R.build(THREE, p, { detail });
      const need = ['coverTop', 'coverSide_L', 'coverSide_R', 'coverStile_L', 'coverStile_R', 'coverRail_top', 'coverRail_bottom', 'coverBacking'];
      check(`${tag} (${detail}): framed cover parts all present`, need.every(n => find(g, n)), need.filter(n => !find(g, n)));
      const body = bodyBoxOf(g);
      const top = boxOf(find(g, 'coverTop')), sl = boxOf(find(g, 'coverSide_L')), sr = boxOf(find(g, 'coverSide_R'));
      const back = boxOf(find(g, 'coverBacking'));
      check(`${tag} (${detail}): body (valves included) strictly inside the side panels`, body.minX > sl.maxX && body.maxX < sr.minX, { body, sl: sl.maxX, sr: sr.minX });
      check(`${tag} (${detail}): body strictly under the top board`, body.maxY < top.minY, { body: body.maxY, top: top.minY });
      check(`${tag} (${detail}): body front >= 2.5 cm behind the backing`, back.minZ - body.maxZ >= 2.5, { body: body.maxZ, backing: back.minZ });
      const s = sweepSlatPanel(g, p);
      check(`${tag} (${detail}): no ray through the slat panel reaches the radiator`, s.radiator === 0, s);
      check(`${tag} (${detail}): every ray hits a slat or the backing`, s.other.length === 0, s.other.slice(0, 5));
      check(`${tag} (${detail}): the gaps show the backing (gaps exist)`, s.backing > s.rays * 0.2, s);
      // backing is DARK, so the gaps read dark like the real cover
      const c = find(g, 'coverBacking').material.color;
      check(`${tag} (${detail}): the backing is dark`, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 0.1, c.getHexString());
      const slatC = find(g, 'coverSlat_0').material.color;
      check(`${tag} (${detail}): the slats are light`, 0.2126 * slatC.r + 0.7152 * slatC.g + 0.0722 * slatC.b > 0.6);
      // kick-out: open between the legs
      const rc = new THREE.Raycaster();
      g.updateMatrixWorld(true);
      rc.set(new THREE.Vector3(0, 0.03, (merged(p).depth + 5) * CM), new THREE.Vector3(0, 0, -1));
      const kick = rc.intersectObject(g, true).filter(h => /^cover/.test(h.object.name));
      check(`${tag} (${detail}): the kick-out under the bottom rail is open`, kick.length === 0, kick.map(h => h.object.name));
    }
  }
  const hall = R.PRESETS.find(p => p.params.cover === 'box');
  const g = R.build(THREE, hall.params, {});
  check('hallway: 11 slats on the 52-wide panel', findAll(g, /^coverSlat_/).length === 11, findAll(g, /^coverSlat_/).length);
  check('hallway: bodyElevation puts the body 17 up inside the box', Math.abs(boxOf(find(g, 'radiatorPanel')).minY - 17) < EPS, boxOf(find(g, 'radiatorPanel')));
  const g0 = R.build(THREE, Object.assign({}, hall.params, { bodyElevation: 0 }), {});
  check('bodyElevation 0 puts the body on the envelope bottom', Math.abs(boxOf(find(g0, 'radiatorPanel')).minY) < EPS);
  check('hallway: pipes run to the floor through the kick-out', findAll(g, /^pipe$/).every(p => Math.abs(boxOf(p).minY) < 0.01) && findAll(g, /^pipe$/).length === 2);
  const tb = unionOf(g, n => /^coverTop/.test(n)), st = boxOf(find(g, 'coverStile_L'));
  const nose = find(g, 'coverTopNosing');
  check('hallway: the top board has a rounded front edge', !!nose && Math.abs(boxOf(nose).maxZ - 19) < EPS &&
    Math.abs(size(boxOf(nose)).h - 2) < 0.05 && size(boxOf(nose)).d < 1.05, nose && boxOf(nose));
  const grooves = findAll(g, /^coverStileGroove_/);
  check('hallway: a routed groove down each stile', grooves.length === 2 && grooves.every(gr => {
    const b = boxOf(gr), stl = boxOf(find(g, /_L$/.test(gr.name) ? 'coverStile_L' : 'coverStile_R'));
    return b.minX > stl.minX && b.maxX < stl.maxX && b.minZ - stl.maxZ >= 0.04 && size(b).h > 50;
  }), grooves.map(boxOf));
  check('hallway: top board overhangs the carcass at the front and side by ~1.5', Math.abs((tb.maxZ - st.maxZ) - 1.5) < 0.01 && Math.abs((st.minX - tb.minX) - 1.5) < 0.01, { tb, st });
  check('hallway: stiles run to the floor as legs', Math.abs(st.minY) < EPS, st);
  // no-cover body elevation too
  const lifted = R.build(THREE, { height: 77, bodyElevation: 17 }, {});
  check('no cover: bodyElevation lifts the body and the pipes still reach y=0',
    Math.abs(boxOf(find(lifted, 'radiatorPanel')).minY - 17) < EPS && findAll(lifted, /^pipe$/).every(p => Math.abs(boxOf(p).minY) < 0.01));
}

// ---- 6. no z-fighting: no overlapping same-facing face planes ----------------
function zFights(g) {
  const faces = [];
  g.updateMatrixWorld(true);
  g.traverse(o => {
    if (!o.isMesh) return;
    const t = o.geometry.type;
    const b = new THREE.Box3().setFromObject(o);
    if (t === 'BoxGeometry') {
      for (const ax of ['x', 'y', 'z']) {
        faces.push({ o, ax, dir: -1, at: b.min[ax], b });
        faces.push({ o, ax, dir: 1, at: b.max[ax], b });
      }
    } else if (t === 'PlaneGeometry') {
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
      const ax = Math.abs(n.x) > 0.9 ? 'x' : Math.abs(n.y) > 0.9 ? 'y' : 'z';
      faces.push({ o, ax, dir: Math.sign(n[ax]), at: b.min[ax], b });
    }
  });
  const others = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] };
  const out = [];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const f = faces[i], h = faces[j];
      if (f.o === h.o || f.ax !== h.ax || f.dir !== h.dir || Math.abs(f.at - h.at) > 1e-6) continue;
      const [a1, a2] = others[f.ax];
      const o1 = Math.min(f.b.max[a1], h.b.max[a1]) - Math.max(f.b.min[a1], h.b.min[a1]);
      const o2 = Math.min(f.b.max[a2], h.b.max[a2]) - Math.max(f.b.min[a2], h.b.min[a2]);
      if (o1 > 1e-6 && o2 > 1e-6) out.push(`${f.o.name}~${h.o.name}@${f.ax}${f.dir > 0 ? '+' : '-'}`);
    }
  }
  return out;
}
{
  const cases = [{ tag: 'DEFAULTS', p: {} }].concat(R.PRESETS.map(p => ({ tag: p.name, p: p.params })));
  for (const c of R.COVERS) for (const v of R.VALVE_CORNERS) cases.push({ tag: `${c}/${v}`, p: { cover: c, valveCorner: v, height: 80, depth: 19 } });
  for (const { tag, p } of cases) {
    for (const detail of ['full', 'low']) {
      const z = zFights(R.build(THREE, p, { detail }));
      check(`${tag} (${detail}): no coplanar same-facing overlapping faces`, z.length === 0, z.slice(0, 6));
    }
  }
  // the checker itself must be able to fail
  const probe = new THREE.Group();
  const m = new THREE.MeshStandardMaterial();
  const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m); a.name = 'a';
  const b = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 1), m); b.name = 'b'; b.position.y = 0.25;
  probe.add(a, b);
  check('z-fight checker catches a box sharing a face with another', zFights(probe).length > 0);
}

// ---- 7. merge fidelity ----------------------------------------------------
{
  const FIN = new Set(['matte', 'gloss', 'metal', 'glass', 'mirror', 'emissive']);
  for (const p of [{}].concat(R.PRESETS.map(x => x.params))) {
    const g = R.build(THREE, p, { detail: 'full' });
    let untagged = 0, textured = 0, lights = 0, emissive = 0;
    g.traverse(o => {
      if (o.isLight) lights++;
      if (!o.isMesh) return;
      if (!FIN.has(o.userData.finish)) untagged++;
      if (o.userData.finish === 'emissive') emissive++;
      if (o.material.map || o.material.normalMap) textured++;
    });
    check('every mesh has a palette finish, no textures, no lights, nothing emissive', !untagged && !textured && !lights && !emissive,
      { untagged, textured, lights, emissive });
  }
}

// ---- 8. perf caps ---------------------------------------------------------
{
  const sweep = [];
  for (const cover of R.COVERS) for (const width of [40, 98, 140, 200, 260]) {
    sweep.push({ name: `sweep ${cover} ${width} wide`, params: { cover, width, height: cover === 'box' ? 92 : 64, depth: cover === 'box' ? 19 : 15 } });
  }
  for (const { name, params } of [{ name: 'DEFAULTS', params: {} }].concat(R.PRESETS, sweep)) {
    const f = triangles(R.build(THREE, params, { detail: 'full' }));
    const l = triangles(R.build(THREE, params, { detail: 'low' }));
    check(`${name}: full <= 800 triangles`, f <= 800, f);
    check(`${name}: low <= 250 triangles`, l <= 250, l);
    check(`${name}: low <= 60% of full when full > 300`, f <= 300 || l <= 0.6 * f, { f, l });
    if (process.env.RADIATOR_TRIS) console.log(`${name}: full ${f}, low ${l}`);
  }
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
