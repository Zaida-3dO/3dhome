#!/usr/bin/env node
/**
 * Windows + curtains: loader pass-through and the geometry decisions that a
 * screenshot cannot pin. No framework, no install -
 * `node scripts/test-wall-fittings.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. house-loader compiles `windows[]` / `curtains[]` into what the renderer
 *      reads -- every authored field lands, defaults fill the gaps, a broken
 *      reference is skipped with a warning rather than thrown.
 *   2. The inside/outside decision. It is DERIVED from `room` (which side of
 *      the wall the room lies on). Get it backwards and every window renders
 *      with its frame on the room face and every curtain hangs outside the
 *      building -- in a house nobody is looking at from that side, so it
 *      would survive review.
 *   3. The cavity-wall sandwich: `throughWalls` must widen the cill to the
 *      outer leaf's face.
 *   4. Curtain stacking: a blackout hung in front of a sheer must never fold
 *      back through it. Checked on the real vertex positions, not on the
 *      formula, so a change to either the budget or the fold maths trips it.
 *   5. The balcony door lands at the authored compass end of the run on a
 *      wall whose local frame is rotated 180 degrees.
 *   6. The cornice is a closed box: a lid under the ceiling line, the fabric
 *      and LED strip below it, and downlights (3, or 5 on a wide cornice)
 *      whose cones cannot reach the front, the lid or a side face -- checked
 *      by casting rays round each cone's edge through the box.
 *
 * The scene half builds real three.js geometry (the vendored module is plain
 * ESM and needs no DOM for geometry), so it exercises the same code the page
 * runs rather than a copy of it.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HouseLoader } = await imp('src/house-loader.js');
const THREE = await imp('vendor/three-r160/three.module.min.js');
const F = await imp('src/wall-fittings.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// An illustrative south-facing cavity wall: inner leaf 4 (30 cm) with an
// outer skin 32 (10 cm) south of it; the room lies NORTH of both.
function house(extra) {
  return Object.assign({
    kind: 'geometry', schemaVersion: '1.1', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      { id: 4, start: [0, 600], end: [1000, 600], exterior: true, thickness: 30 },
      { id: 32, start: [0, 620], end: [1000, 620], exterior: true, thickness: 10 },
      { id: 7, start: [500, 0], end: [500, 585], thickness: 10 },
      { id: 9, start: [0, 0], end: [1000, 0], exterior: true, thickness: 20 }
    ] },
    rooms: [{ id: 'living', label: 'Living', polygon: [[10, 10], [490, 10], [490, 585], [10, 585]] }]
  }, extra);
}
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

// ---- 1. absent keys compile to empty lists ---------------------------------
{
  const h = quiet(() => HouseLoader.compile(house({}), ''));
  check('no windows key -> []', Array.isArray(h.windows) && h.windows.length === 0, h.windows);
  check('no curtains key -> []', Array.isArray(h.curtains) && h.curtains.length === 0, h.curtains);
}

// ---- 2/3. window pass-through, side derivation, the sandwich ---------------
const windowsDoc = [
  { id: 'bay', room: 'living', wall: 4, throughWalls: [32], centre: 250, width: 100, height: 200, sill: 10 },
  { id: 'plain', room: 'living', wall: 4, centre: 400, width: 60, height: 100 },
  { id: 'glaze', kind: 'balcony', room: 'living', wall: 4, throughWalls: [32], centre: 150, width: 200,
    height: 210, sill: 5, doorSide: 'west', frameColor: '#102030' },
  { id: 'ghost', room: 'living', wall: 99, centre: 1, width: 1, height: 1 },
  { id: 'nowhere', room: 'attic', wall: 4, centre: 1, width: 1, height: 1 },
  { id: 'badend', kind: 'balcony', room: 'living', wall: 4, centre: 450, width: 60, height: 100, doorSide: 'north' },
  { id: 'crosscut', room: 'living', wall: 4, throughWalls: [7], centre: 300, width: 50, height: 50 }
];
const h = quiet(() => HouseLoader.compile(house({ windows: windowsDoc }), ''));
const byId = Object.fromEntries(h.windows.map(w => [w.id, w]));
{
  const b = byId.bay;
  check('window compiled', !!b);
  check('window fields pass through', b && b.c === 250 && b.w === 100 && b.h === 200 && b.sill === 10 &&
    b.room === 'living' && b.wallId === 4 && b.kind === 'window', b);
  check('room north of a south wall -> inDir -1', b && b.inDir === -1, b && b.inDir);
  check('outer face is the SOUTH face of the host', b && near(b.outerFace, 615), b && b.outerFace);
  check('host thickness carried', b && b.hostThickness === 30);
  check('throughWalls kept', b && b.throughWallIds.length === 1 && b.throughWallIds[0] === 32, b && b.throughWallIds);
  check('sandwich depth beyond the host = outer leaf 10 cm', b && near(b.beyond, 10), b && b.beyond);
  check('exterior host flagged', b && b.exterior === true);
  check('sill defaults to 90', byId.plain && byId.plain.sill === 90, byId.plain && byId.plain.sill);
  check('no throughWalls -> beyond 0', byId.plain && byId.plain.beyond === 0);
  check('topSplit defaults to 0.5', byId.plain && byId.plain.topSplit === 0.5);
  const g = byId.glaze;
  check('balcony kind + doorEnd', g && g.kind === 'balcony' && g.doorEnd === 'west', g);
  check('frameColor hex -> int', g && g.frameColor === 0x102030, g && g.frameColor);
  check('missing wall -> skipped', !byId.ghost);
  check('missing room -> skipped', !byId.nowhere);
  check('doorSide off the wall axis -> falls back to west', byId.badend && byId.badend.doorEnd === 'west',
    byId.badend && byId.badend.doorEnd);
  check('non-parallel throughWall ignored', byId.crosscut && byId.crosscut.throughWallIds.length === 0);
  check('warnings name the skipped window', h.warnings.some(m => m.includes('"ghost"')) &&
    h.warnings.some(m => m.includes('"nowhere"')), h.warnings);

  // Room SOUTH of a wall: the same wall seen from the other side flips.
  const hs = quiet(() => HouseLoader.compile(house({
    rooms: [{ id: 'yard', label: 'Yard', polygon: [[10, 20], [490, 20], [490, 300], [10, 300]] }],
    windows: [{ id: 'n', room: 'yard', wall: 9, centre: 100, width: 50, height: 50 }]
  }), ''));
  check('room south of a wall -> inDir +1', hs.windows[0] && hs.windows[0].inDir === 1, hs.windows[0]);
}

// ---- 4. curtains: pass-through, defaults, stacking --------------------------
const curtainsDoc = [
  { id: 'blackout', room: 'living', wall: 4, centre: 250, width: 300, offset: 12.5,
    outerColor: '#224466', innerColor: '#cc8844', openPct: 0, cornice: { sideFaces: false } },
  { id: 'sheer', room: 'living', wall: 4, centre: 250, width: 300, offset: 3.5, opacity: 0.4, openPct: 0,
    outerColor: '#eeddaa', innerColor: '#eeddaa', cornice: { enabled: false } },
  { id: 'plainc', room: 'living', wall: 4, centre: 450, width: 60 },
  { id: 'stacked', room: 'living', wall: 4, centre: 460, width: 40, stackWidth: 18.5, stackPerPleat: 3.3,
    cornice: { enabled: false } },
  { id: 'badstack', room: 'living', wall: 4, centre: 470, width: 40, stackWidth: 0, cornice: { enabled: false } },
  { id: 'bare', room: 'living', wall: 7, centre: 300, width: 60, cornice: { enabled: false } },
  { id: 'lost', room: 'living', wall: 123, centre: 1, width: 1 }
];
const hc = quiet(() => HouseLoader.compile(house({ curtains: curtainsDoc }), ''));
const cById = Object.fromEntries(hc.curtains.map(c => [c.id, c]));
{
  const bo = cById.blackout, sh = cById.sheer, pc = cById.plainc;
  check('curtain colours pass through', bo && bo.outerColor === 0x224466 && bo.innerColor === 0xcc8844, bo);
  check('curtain openPct passes through', bo && bo.openPct === 0);
  check('opaque curtain is not a sheer', bo && bo.sheer === false && bo.opacity === 1);
  check('opacity < 1 makes a sheer', sh && sh.sheer === true && sh.opacity === 0.4, sh);
  check('cornice.enabled false -> no cornice', sh && sh.cornice === null);
  check('sideFaces false carried', bo && bo.cornice && bo.cornice.sideFaces === false);
  check('curtain hangs on the ROOM face', bo && near(bo.roomFace, 585), bo && bo.roomFace);
  check('defaults: floor-to-ceiling, open, pink/blue, 5+2 pleats',
    pc && pc.top === 250 && pc.drop === 250 && pc.openPct === 100 && pc.outerColor === 0xd98aa8 &&
    pc.innerColor === 0x5f86c4 && pc.outerPleats === 5 && pc.innerPleats === 2, pc);
  check('default offset = half the default 18 cm cornice', pc && pc.offset === 9, pc && pc.offset);
  check('curtain on a missing wall -> skipped', !cById.lost);
  check('room span carried for a wall-to-wall cornice', bo && bo.roomSpan[0] === 10 && bo.roomSpan[1] === 490,
    bo && bo.roomSpan);
  // Budget: sheer = 3.5 - 0 (no lining) - 2.5 wall clearance = 1.
  // Blackout = 12.5 - 2 (lining) - (3.5 + 1 + 1 layer gap) = 5.
  check('sheer fold budget', sh && near(sh.maxAmp, 1), sh && sh.maxAmp);
  check('blackout stacked in front of the sheer', bo && near(bo.maxAmp, 5), bo && bo.maxAmp);
  check('unstacked curtain gets the wall-only budget (9 - 2 - 2.5)', pc && near(pc.maxAmp, 4.5), pc && pc.maxAmp);
  const sk = cById.stacked, bs = cById.badstack;
  check('stackWidth + stackPerPleat pass through', sk && sk.stackWidth === 18.5 && sk.stackPerPleat === 3.3, sk);
  check('no stack fields -> null (the default rule)', pc && pc.stackWidth === null && pc.stackPerPleat === null, pc);
  check('a non-positive stackWidth -> null', bs && bs.stackWidth === null, bs && bs.stackWidth);
}

// ---- head gap: only for a curtain hanging in a cornice -----------------------
{
  const topOf = built => {
    let t = -Infinity;
    built.group.traverse(o => {
      if (!o.isMesh || !/^curtain_/.test(o.name)) return;
      const p = o.geometry.attributes.position.array;
      for (let i = 1; i < p.length; i += 3) t = Math.max(t, p[i]);
    });
    return t;
  };
  const sh = cById.sheer, bare = cById.bare;
  check('sheer behind the blackout is marked under its cornice', sh && sh.underCornice === true, sh && sh.underCornice);
  check('a lone cornice-less curtain is not', bare && bare.underCornice === false, bare && bare.underCornice);
  check('cornice-less curtain keeps its full drop (top at `top`)', near(topOf(F.buildCurtain(THREE, bare, false)), bare.top / 100, 1e-6));
  check('sheer under a cornice stops CURTAIN_HEAD_GAP short',
    near(topOf(F.buildCurtain(THREE, sh, false)), sh.top / 100 - F.CURTAIN_HEAD_GAP, 1e-6));
  check('curtain with its own cornice stops CURTAIN_HEAD_GAP short',
    near(topOf(F.buildCurtain(THREE, cById.plainc, false)), cById.plainc.top / 100 - F.CURTAIN_HEAD_GAP, 1e-6));
}

// ---- cornice lid + downlights ----------------------------------------------
{
  const meshes = built => { const m = {}; built.group.traverse(o => { if (o.isMesh) (m[o.name] = m[o.name] || []).push(o); }); return m; };
  const boxOf = o => { o.geometry.computeBoundingBox(); return o.geometry.boundingBox.clone().translate(o.position); };
  const boxed = Object.assign({}, cById.plainc, { cornice: Object.assign({}, cById.plainc.cornice) });
  const wall2wall = Object.assign({}, cById.blackout);
  for (const [label, cur] of [['side faces', boxed], ['wall-to-wall', wall2wall]]) {
    const built = F.buildCurtain(THREE, cur, true);
    const m = meshes(built);
    const TOP = cur.top / 100, D = cur.cornice.depth / 100, H = cur.cornice.height / 100;
    const lid = m.corniceTop && m.corniceTop[0];
    check('cornice has a lid (' + label + ')', !!lid, Object.keys(m));
    if (!lid) continue;
    const lb = boxOf(lid), fb = boxOf(m.corniceFront[0]);
    check('lid shares the front face material (' + label + ')', lid.material === m.corniceFront[0].material);
    check('lid is in the fade set like the front (' + label + ')',
      built.fadeMeshes.includes(lid) && built.fadeMeshes.includes(m.corniceFront[0]));
    check('lid top sits just under the ceiling line (' + label + ')',
      lb.max.y < TOP && lb.max.y > TOP - 0.005, { max: lb.max.y, TOP });
    // Light-tight: nothing merely butts against anything. The lid is the box
    // top -- it runs into the wall and overhangs the front's OUTER face --
    // and the front/side tops are buried inside it (below its top, above
    // its underside), so from above there is one surface and no seam.
    check('lid runs into the wall and past the front face (' + label + ')',
      lb.min.z < -0.005 && lb.max.z > fb.max.z + 0.001, { lid: [lb.min.z, lb.max.z], front: [fb.min.z, fb.max.z] });
    check('front face top is buried in the lid (' + label + ')',
      fb.max.y < lb.max.y - 0.001 && fb.max.y > lb.min.y + 0.001, { front: fb.max.y, lid: [lb.min.y, lb.max.y] });
    if (cur.cornice.sideFaces) {
      check('lid overhangs the side faces too (' + label + ')',
        lb.min.x < fb.min.x - 0.001 && lb.max.x > fb.max.x + 0.001, { lid: [lb.min.x, lb.max.x], front: [fb.min.x, fb.max.x] });
      m.corniceSide.forEach(sf => {
        const sb = boxOf(sf);
        check('side face runs into the wall and into the front (' + label + ')',
          sb.min.z < -0.005 && sb.max.z > fb.min.z + 0.001, [sb.min.z, sb.max.z]);
        check('side face top is buried in the lid (' + label + ')',
          sb.max.y < lb.max.y - 0.001 && sb.max.y > lb.min.y + 0.001, sb.max.y);
      });
    } else {
      // Wall-to-wall: the front and lid run into each side wall.
      const span = (cur.roomSpan[1] - cur.roomSpan[0]) / 100;
      check('wall-to-wall front and lid run into both side walls (' + label + ')',
        fb.max.x - fb.min.x > span + 0.01 && lb.max.x - lb.min.x > span + 0.01, { front: fb.max.x - fb.min.x, span });
    }
    // Nothing inside pokes up through the lid: fabric and strip stay under it.
    let topFabric = -Infinity;
    Object.keys(m).filter(k => /^curtain_/.test(k)).forEach(k => m[k].forEach(o => {
      const p = o.geometry.attributes.position.array;
      for (let i = 1; i < p.length; i += 3) topFabric = Math.max(topFabric, p[i]);
    }));
    check('fabric heading stays under the lid (' + label + ')', topFabric < lb.min.y, { topFabric, lidBottom: lb.min.y });
    const strip = m.corniceLightStrip[0], sb = boxOf(strip);
    check('LED strip tucked in the top-front corner, under the lid, behind the front (' + label + ')',
      sb.max.y <= lb.min.y + 1e-9 && sb.max.y > lb.min.y - 0.01 && sb.max.z <= fb.min.z + 1e-9 && sb.min.y > TOP - H,
      { strip: [sb.min.y, sb.max.y, sb.max.z], lid: lb.min.y, front: fb.min.z });

    // Downlights: inside the box, and no ray of any cone can reach the
    // front face, the lid or a side face. Checked by casting rays around
    // the cone edge (the extreme directions) through the box.
    const box = strip.userData.cornice;
    const layout = F.corniceSpotLayout(box);
    const n = F.corniceLightCount(box.width * 100);
    check('light count by width (' + label + ')', layout.spots.length === n && n === (box.width * 100 >= 250 ? 5 : 3),
      { n, len: layout.spots.length, w: box.width });
    const xs = layout.spots.map(sp => sp.x);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    check('lights evenly spaced (' + label + ')', gaps.every(g => near(g, gaps[0], 1e-9)) && gaps[0] > 0, gaps);
    check('lights centred on the cornice (' + label + ')',
      near((xs[0] + xs[xs.length - 1]) / 2, box.offset, 1e-9), { xs, off: box.offset });
    let leak = null;
    const frontInner = fb.min.z, sideInner = box.width / 2 - 0.01;
    layout.spots.forEach(sp => {
      check('light inside the box (' + label + ')', sp.y < lb.min.y && sp.y > TOP - H && sp.z < frontInner && sp.z > 0, sp);
      const axis = new THREE.Vector3(sp.tx - sp.x, sp.ty - sp.y, sp.tz - sp.z).normalize();
      const u = new THREE.Vector3(1, 0, 0), v = new THREE.Vector3().crossVectors(axis, u).normalize();
      for (let k = 0; k < 72; k++) {
        const a = k / 72 * 2 * Math.PI;
        const dir = axis.clone().multiplyScalar(Math.cos(layout.angle))
          .add(u.clone().multiplyScalar(Math.sin(layout.angle) * Math.cos(a)))
          .add(v.clone().multiplyScalar(Math.sin(layout.angle) * Math.sin(a))).normalize();
        if (dir.y >= 0) { leak = leak || { up: dir.toArray() }; continue; }
        // March to the bottom of the box (or the wall) and see what it met.
        for (let t = 0; t < 1; t += 0.0005) {
          const x = sp.x + dir.x * t, y = sp.y + dir.y * t, z = sp.z + dir.z * t;
          if (y < TOP - H || z < 0) break;
          if (z >= frontInner) { leak = leak || { front: [x, y, z] }; break; }
          if (cur.cornice.sideFaces && Math.abs(x - box.offset) >= sideInner) { leak = leak || { side: [x, y, z] }; break; }
        }
      }
    });
    check('no downlight ray reaches the front, the lid or a side face (' + label + ')', leak === null, leak);
  }
  check('3 lights under 250 cm, 5 at 250 cm and over',
    F.corniceLightCount(249.9) === 3 && F.corniceLightCount(250) === 5 && F.corniceLightCount(120) === 3);
  // A cramped box: the end lights are pulled in so the side faces stay dark.
  function cramped0(w) { return { width: w || 0.4, offset: 0, top: 2.5, height: 0.3, depth: 0.2, stripY: 2.476, stripZ: 0.175, sideFaces: true }; }
  const cramped = { width: 0.4, offset: 0, top: 2.5, height: 0.3, depth: 0.2, stripY: 2.476, stripZ: 0.175, sideFaces: true };
  const cl = F.corniceSpotLayout(cramped);
  // specs/CurtainSpec.html keeps its own copy of these (it cannot import the
  // module); a constant that drifts there makes the spec lie about the app.
  const fs = await import('node:fs');
  const spec = fs.readFileSync(path.join(root, 'specs/CurtainSpec.html'), 'utf8');
  const specConst = name => { const m = spec.match(new RegExp('const ' + name + ' = ([^;]+);')); return m ? m[1].trim() : null; };
  for (const [name, want] of [
    ['STACK_PER_PLEAT_CM', String(F.STACK_PER_PLEAT_CM)],
    ['CURTAIN_CLOSED_OVERLAP', String(F.CURTAIN_CLOSED_OVERLAP)],
    ['CORNICE_WIDE_CM', String(F.CORNICE_WIDE_CM)],
    ['CORNICE_SPOT_TILT', Math.round(F.CORNICE_SPOT_TILT * 180 / Math.PI) + ' * Math.PI / 180'],
    ['CORNICE_SPOT_ANGLE', Math.round(F.CORNICE_SPOT_ANGLE * 180 / Math.PI) + ' * Math.PI / 180'],
    ['CORNICE_SPOT_RANGE', String(F.CORNICE_SPOT_RANGE)],
    ['CORNICE_LID_T', String(F.CORNICE_LID_T)],
    ['CORNICE_LID_GAP', String(F.CORNICE_LID_GAP)],
    ['CORNICE_LID_LIP', String(F.CORNICE_LID_LIP)],
    ['CORNICE_FACE_TUCK', String(F.CORNICE_FACE_TUCK)],
    ['CORNICE_WALL_TUCK', String(F.CORNICE_WALL_TUCK)],
    ['CORNICE_STRIP_DROP', String(F.CORNICE_STRIP_DROP)],
    ['CURTAIN_HEAD_GAP', String(+F.CURTAIN_HEAD_GAP.toFixed(6))]
  ]) check('CurtainSpec.html mirrors ' + name, specConst(name) === want, { spec: specConst(name), want });
  // Unshadowed, so they must not reach far, nor lean back to horizontal
  // (that is how light gets through the wall behind them).
  check('downlight range <= 1.5 m', F.CORNICE_SPOT_RANGE <= 1.5 && F.corniceSpotLayout(cramped0()).range === F.CORNICE_SPOT_RANGE);
  check('cone back edge at least 10 degrees below horizontal',
    (F.CORNICE_SPOT_TILT + F.CORNICE_SPOT_ANGLE) * 180 / Math.PI <= 80);

  // Tier cap: the fullest cornices give up lights first, never below 1
  // until nothing else is left; under the cap, nothing changes.
  const B = F.corniceLightBudget;
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('budget: under the cap -> unchanged', eq(B([3, 3, 5], 12), [3, 3, 5]) && eq(B([3, 3, 5], null), [3, 3, 5]));
  check('budget: cap 9 takes from the 5 first', eq(B([3, 3, 5], 9), [3, 3, 3]), B([3, 3, 5], 9));
  check('budget: cap 6 -> two each', eq(B([3, 3, 5], 6), [2, 2, 2]), B([3, 3, 5], 6));
  check('budget: cap 2 with 3 cornices -> later ones go dark', eq(B([3, 3, 5], 2), [1, 1, 0]), B([3, 3, 5], 2));
  check('budget: cap 0 -> none', eq(B([3, 5], 0), [0, 0]));
  const two = F.corniceSpotLayout(cramped0(1.5), 2);
  check('a reduced count still lays out inside the box', two.spots.length === 2 &&
    two.spots.every(sp => Math.abs(sp.x) < 0.75), two.spots.map(sp => sp.x));
  check('cramped cornice: end lights held in by the reach',
    cl.spots[0].x > -0.2 + 0.1 && cl.spots[cl.spots.length - 1].x < 0.2 - 0.1, cl.spots.map(sp => sp.x));
}

// ---- scene geometry --------------------------------------------------------
function zRange(group) {
  let lo = Infinity, hi = -Infinity;
  group.traverse(o => {
    if (!o.isMesh || !/^curtain_/.test(o.name)) return;
    const p = o.geometry.attributes.position.array;
    for (let i = 2; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
  });
  return [lo, hi];
}
{
  // Both drawn closed AND fully open: the gathered pose folds deepest.
  for (const pct of [0, 100]) {
    const bo = Object.assign({}, cById.blackout, { openPct: pct });
    const sh = Object.assign({}, cById.sheer, { openPct: pct });
    const [boLo] = zRange(F.buildCurtain(THREE, bo, true).group);
    const [shLo, shHi] = zRange(F.buildCurtain(THREE, sh, true).group);
    check('sheer never touches the wall (open ' + pct + ')', shLo > 0.02, shLo);
    check('blackout lining stays in front of the sheer (open ' + pct + ')', boLo > shHi, { boLo, shHi });
  }
  const sheerBuilt = F.buildCurtain(THREE, cById.sheer, true);
  const sheerFabric = [];
  sheerBuilt.group.traverse(o => { if (o.isMesh && /^curtain_/.test(o.name)) sheerFabric.push(o); });
  check('sheer has no lining (2 surfaces, not 4)', sheerFabric.length === 2, sheerFabric.length);
  check('sheer keeps its own opacity', sheerFabric.every(m => m.material.transparent && near(m.material.opacity, 0.4)));
  check('sheer fabric stays out of the wall fade', sheerFabric.every(m => sheerBuilt.fadeMeshes.indexOf(m) === -1));
  const boBuilt = F.buildCurtain(THREE, cById.blackout, true);
  const names = [];
  boBuilt.group.traverse(o => { if (o.isMesh) names.push(o.name); });
  check('blackout has 4 fabric surfaces + wall-to-wall cornice (no ends) + strip',
    names.filter(n => /^curtain_/.test(n)).length === 4 && names.includes('corniceFront') &&
    !names.includes('corniceSide') && names.includes('corniceLightStrip'), names);

  // Windows: verticals, fade membership, cill depth, balcony door end.
  const v = F.windowVerticals(byId.bay);
  check('glazing 10..210 cm, hole 6..214 cm', near(v.openBot, 0.10) && near(v.openTop, 2.10) &&
    near(v.holeBot, 0.06) && near(v.holeTop, 2.14), v);
  const vLow = F.windowVerticals(Object.assign({}, byId.bay, { sill: 0 }));
  check('a sill under the reveal is raised to it', near(vLow.openBot, 0.04) && near(vLow.holeBot, 0), vLow);

  const bay = F.buildWindow(THREE, byId.bay, true);
  let glass = 0, cill = null;
  bay.group.traverse(o => {
    if (o.isMesh && /Glass$/.test(o.name)) { glass++; check('glass not in fade', bay.fadeMeshes.indexOf(o) === -1, o.name); }
    if (o.name === 'windowCill') cill = o;
  });
  check('window has fixed + sash glass', glass === 2, glass);
  check('frame is in the fade', bay.fadeMeshes.some(m => m.name === 'windowFrame'));
  cill.geometry.computeBoundingBox();
  const cb = cill.geometry.boundingBox.clone().translate(cill.position);
  check('cill spans outer skin face (-10 cm) to room face (+30 cm)', near(cb.min.z, -0.10) && near(cb.max.z, 0.30), cb);

  const g = F.buildWindow(THREE, byId.glaze, true);
  F.placeOnWall(g.group, byId.glaze, byId.glaze.outerFace, x => x * 0.01, y => y * 0.01);
  g.group.updateMatrixWorld(true);
  let pivot = null, mullion = null;
  g.group.traverse(o => { if (o.name === 'balconyDoorPivot') pivot = o; if (o.name === 'balconyMullion') mullion = o; });
  const pw = new THREE.Vector3(), mw = new THREE.Vector3();
  pivot.getWorldPosition(pw); mullion.getWorldPosition(mw);
  // Run is 150 +/- 100 cm: the west jamb is at x = 0.5 m, the door 25% of the run.
  check('balcony door hinge is on the WEST jamb', near(pw.x, 0.5, 1e-4), pw.x);
  check('mullion sits a quarter-run east of it', near(mw.x, 1.0, 1e-4), mw.x);
  // No sliver between the fixed pane and the east jamb (the spec page had one).
  let fixedGlass = null;
  g.group.traverse(o => { if (o.name === 'balconyFixedGlass') fixedGlass = o; });
  const fb = new THREE.Box3().setFromObject(fixedGlass);
  check('fixed pane reaches the east jamb (x = 2.5 m)', near(fb.max.x, 2.5, 1e-4), fb.max.x);
  check('fixed pane starts at the mullion face', near(fb.min.x, 1.0 + 0.035, 1e-4), fb.min.x);
  check('window frame sits on the host OUTER face', near(g.group.position.z, 6.15, 1e-6), g.group.position.z);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
