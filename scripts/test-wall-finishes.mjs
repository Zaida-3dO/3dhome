#!/usr/bin/env node
/**
 * Wall-face finishes -- `walls[].finishes` (schemaVersion 1.3): brick (ported
 * from the window spec pages) and a placeholder tile, on ONE face of a wall,
 * optionally over a height band and a span. No framework, no install:
 * `node scripts/test-wall-finishes.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. The schema declares `finishes` (walls are additionalProperties:false,
 *      so an undeclared field fails every profile using it), the finish names
 *      agree with the engine's registry, and the loader resolves each entry's
 *      face -- `exterior`, a compass side, or a `room` -- to the right plan
 *      normal, and drops bad entries with a warning.
 *   2. The brick IS the spec pages' brick: every constant that sets its look
 *      is read out of specs/WindowSpec.html and specs/BalconyWindowSpec.html
 *      and compared, so they cannot drift apart.
 *   3. The tiles (brick and the tile placeholder) are deterministic; brick is
 *      running bond, uses all six shades within the spec's +/-9 jitter, and a
 *      brick straddling the tile edge is one brick. One canvas per finish type.
 *   4. END faces: a compass side pointing along a short segment (a pillar)
 *      names the right END face, as do start/end; `reveals` defaults; a
 *      finish on a wallpapered face is warned about.
 *   5. The finish mesh, on real three.js geometry: long-face quads are WOUND
 *      to face the requested side (FrontSide) for walls authored both ways on
 *      both axes, sit 1.5 mm proud over exactly their rectangle, carry metre
 *      UVs and are not mirrored; cross-face quads (reveals, end faces) span
 *      the full thickness 1.5 mm out from the end.
 *   6. Height bands and spans intersect each wall box correctly, and a wall
 *      split round a window is ONE geometry with no groups -- one draw --
 *      whose coursing runs on across its boxes.
 *   7. The scene builds one mesh per wall per finish, keeps wall boxes on a
 *      single material, joins the fade, and leaves #63's fade loop intact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HouseLoader } = await imp('src/house-loader.js');
const THREE = await imp('vendor/three-r160/three.module.min.js');
const F = await imp('src/wall-finish.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const vecIs = (v, w) => !!v && near(v[0], w[0]) && near(v[1], w[1]);
function compile(doc) {
  const warnings = [];
  const w = console.warn;
  console.warn = m => warnings.push(String(m));
  try { return { house: HouseLoader.compile(doc, ''), warnings }; } finally { console.warn = w; }
}

// A south-facing cavity wall like the one brick was asked for: an inner leaf
// 4 and a 10 cm outer skin 32 south of it. A bathroom and a store sit either
// side of a north-south partition 7 -- the tile case. Made-up numbers.
function house(extraSegments) {
  return {
    kind: 'geometry', schemaVersion: '1.3', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [
      { id: 1, start: [0, 0], end: [1000, 0], exterior: true, thickness: 20 },
      { id: 2, start: [1000, 0], end: [1000, 620], exterior: true, thickness: 20 },
      { id: 3, start: [0, 620], end: [0, 0], exterior: true, thickness: 20 },
      { id: 4, start: [0, 600], end: [1000, 600], exterior: true, thickness: 30 }
    ].concat(extraSegments) },
    rooms: [
      { id: 'store', label: 'Store', polygon: [[10, 10], [495, 10], [495, 585], [10, 585]] },
      { id: 'bathroom', label: 'Bath', polygon: [[505, 10], [990, 10], [990, 585], [505, 585]] }
    ]
  };
}

// ---- 1. schema + loader -----------------------------------------------------
{
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'houses/schema.json'), 'utf8'));
  const wall = schema.$defs.wall, wf = schema.$defs.wallFinish;
  check('schema: walls stay additionalProperties:false (so the field must be declared)',
    wall.additionalProperties === false);
  check('schema: walls[].finishes is an array of wallFinish',
    wall.properties.finishes && wall.properties.finishes.items.$ref === '#/$defs/wallFinish');
  check('schema: finish names == the engine registry',
    JSON.stringify([...wf.properties.finish.enum].sort()) === JSON.stringify([...F.FINISHES].sort()), wf.properties.finish.enum);
  check('schema: side is exterior + compass + start/end',
    JSON.stringify([...wf.properties.side.enum].sort()) === '["east","end","exterior","north","south","start","west"]');
  check('schema: reveals is a boolean', wf.properties.reveals && wf.properties.reveals.type === 'boolean');
  check('schema: exactly one of side / room', Array.isArray(wf.oneOf) && wf.oneOf.length === 2);
  check('schema: height band + span declared', !!wf.properties.from && !!wf.properties.to &&
    wf.properties.along.minItems === 2 && wf.properties.along.maxItems === 2);
  check('schema: wallFinish is closed', wf.additionalProperties === false);

  const { house: h, warnings } = compile(house([
    { id: 32, start: [0, 620], end: [1000, 620], exterior: true, thickness: 10,
      finishes: [{ finish: 'brick', side: 'exterior' }] },
    { id: 33, start: [1000, 640], end: [0, 640], finishes: [{ finish: 'brick', side: 'exterior' }] },
    { id: 7, start: [500, 0], end: [500, 590], finishes: [
      { finish: 'tile', room: 'bathroom', to: 120 },
      { finish: 'tile', room: 'store', from: 30, to: 200, along: [400, 100] },
      { finish: 'tile', side: 'west' },
      { finish: 'stone', side: 'west' },
      { finish: 'tile', side: 'up' },
      { finish: 'tile', side: 'west', room: 'store' },
      { finish: 'tile' },
      { finish: 'tile', room: 'attic' },
      { finish: 'tile', side: 'east', from: 100, to: 50 },
      { finish: 'tile', side: 'east', along: [1] }
    ] }
  ]));
  const ext = id => h.wallsExt.find(w => w.id === id);
  const f32 = ext(32).finishes, f33 = ext(33).finishes, f7 = ext(7).finishes;
  check('loader: skin 32 exterior -> south', f32.length === 1 && vecIs(f32[0].normal, [0, 1]), f32);
  check('loader: same wall authored E->W still exterior -> south', f33.length === 1 && vecIs(f33[0].normal, [0, 1]), f33);
  check('loader: raw walls carry the same resolved list', h.wallsById[32].finishes === ext(32).finishes);
  check('loader: a wall without finishes has []', Array.isArray(ext(4).finishes) && ext(4).finishes.length === 0);
  check('loader: wall 7 keeps exactly the 3 good entries', f7.length === 3, f7);
  const [bath, store, west] = f7;
  check('loader: room bathroom -> east face (bathroom is east of 7)', vecIs(bath.normal, [1, 0]), bath);
  check('loader: room store -> west face', vecIs(store.normal, [-1, 0]), store);
  check('loader: compass west -> west face', vecIs(west.normal, [-1, 0]), west);
  check('loader: to kept, from null', bath.to === 120 && bath.from === null && bath.along === null, bath);
  check('loader: along sorted, band kept', JSON.stringify(store.along) === '[100,400]' && store.from === 30 && store.to === 200, store);
  const warned = re => warnings.some(m => re.test(m));
  check('loader: unknown finish warned', warned(/finishes\[3\].*stone/));
  check('loader: a side that is not a face warned', warned(/finishes\[4\].*"up"/));
  check('loader: side AND room warned', warned(/finishes\[5\].*exactly one/));
  check('loader: neither side nor room warned', warned(/finishes\[6\].*exactly one/));
  check('loader: missing room warned', warned(/finishes\[7\].*attic/));
  check('loader: to below from warned', warned(/finishes\[8\].*above/));
  check('loader: malformed along warned', warned(/finishes\[9\].*along/));
}

// ---- 2. the brick is the spec pages' brick ----------------------------------
for (const page of ['specs/WindowSpec.html', 'specs/BalconyWindowSpec.html']) {
  const src = fs.readFileSync(path.join(root, page), 'utf8');
  const num = re => { const m = src.match(re); return m ? Number(m[1]) : NaN; };
  check(page + ': BRICK_MODULE_W', num(/BRICK_MODULE_W\s*=\s*([\d.]+)/) === F.BRICK_MODULE_W);
  check(page + ': BRICK_MODULE_H', num(/BRICK_MODULE_H\s*=\s*([\d.]+)/) === F.BRICK_MODULE_H);
  const cell = src.match(/const brickW = (\d+), brickH = (\d+), mortar = (\d+);/);
  check(page + ': brick cell px',
    !!cell && +cell[1] === F.BRICK_TILE.brickW && +cell[2] === F.BRICK_TILE.brickH && +cell[3] === F.BRICK_TILE.mortar, cell);
  const tile = src.match(/const cols = (\d+), rows = (\d+);/);
  check(page + ': tile cols x rows', !!tile && +tile[1] === F.BRICK_TILE.cols && +tile[2] === F.BRICK_TILE.rows, tile);
  const fn = src.slice(src.indexOf('function makeBrickTexture'));
  const mortar = fn.match(/ctx\.fillStyle = '(#[0-9a-fA-F]{6})';/);
  check(page + ': mortar colour', !!mortar && mortar[1].toLowerCase() === F.BRICK_MORTAR, mortar && mortar[1]);
  const shades = fn.match(/const shades = \[([^\]]+)\]/);
  const list = shades ? shades[1].match(/#[0-9a-fA-F]{6}/g).map(s => s.toLowerCase()) : null;
  check(page + ': six shades', JSON.stringify(list) === JSON.stringify([...F.BRICK_SHADES]), list);
  check(page + ': jitter spread 18', /\(Math\.random\(\) - 0\.5\) \* 18/.test(fn));
  check(page + ': repeat formula', /repeat\.set\(1 \/ \(cols \* BRICK_MODULE_W\), 1 \/ \(rows \* BRICK_MODULE_H\)\)/.test(fn));
  check(page + ': hash2 identical',
    /x = \(a \* 374761393 \+ b \* 668265263\) \| 0;\s*x = \(\(x \^ \(x >>> 13\)\) \* 1274126177\) \| 0;/.test(src));
}
{
  const r = F.FINISH_TYPES.brick.repeat();
  check('brick repeat = tiles per metre (1/1.8, 1/0.45)', near(r.x, 1 / 1.8) && near(r.y, 1 / 0.45), r);
  const t = F.FINISH_TYPES.tile.repeat();
  check('tile repeat = 4 x 15 cm per tile', near(t.x, 1 / 0.6) && near(t.y, 1 / 0.6), t);
}

// ---- 3. the tiles ---------------------------------------------------------------
{
  const a = F.brickLayout(), b = F.brickLayout();
  check('brick layout deterministic', JSON.stringify(a) === JSON.stringify(b));
  const { cols, rows, brickW, brickH, mortar } = F.BRICK_TILE;
  check('brick layout count rows*(cols+2)', a.length === rows * (cols + 2), a.length);
  const size = F.FINISH_TYPES.brick.size();
  check('brick tile 384 x 96', size.w === 384 && size.h === 96, size);
  const row0 = a.filter(r => r.y === mortar / 2), row1 = a.filter(r => r.y === brickH + mortar + mortar / 2);
  const x0 = row0.find(r => r.x > 0 && r.x < brickW).x, x1 = row1.find(r => r.x > 0 && r.x < brickW).x;
  check('running bond: odd course shifted half a cell', x1 - x0 === (brickW + mortar) / 2, [x0, x1]);
  const shadeRgb = F.BRICK_SHADES.map(hx => { const n = parseInt(hx.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; });
  const used = new Set();
  const inRange = a.every(r => shadeRgb.some((s, i) => {
    const d = r.rgb[0] - s[0];
    const ok = Math.abs(d) <= 9 && r.rgb[1] - s[1] === d && r.rgb[2] - s[2] === d;
    if (ok) used.add(i);
    return ok;
  }));
  check('every brick is a shade +/-9', inRange);
  check('all six shades used', used.size === 6, [...used]);
  check('jitter actually varies (not a flat wash)', new Set(a.map(r => r.rgb.join())).size > 30);
  for (let row = 1; row < rows; row += 2) {
    const y = row * (brickH + mortar) + mortar / 2;
    const course = a.filter(r => r.y === y);
    const left = course.find(r => r.x < 0), right = course.find(r => r.x + r.w > size.w);
    check('row ' + row + ': wrapped brick is one colour both halves',
      left && right && left.rgb.join() === right.rgb.join() && near(left.x + size.w, right.x), [left, right]);
  }
  const tl = F.tileLayout();
  check('tile layout: 4 x 4 tiles inside a 128 px canvas', tl.length === 16 &&
    tl.every(r => r.x >= 0 && r.y >= 0 && r.x + r.w <= 128 && r.y + r.h <= 128), tl.length);

  function fakeDoc(calls) {
    return { createElement: () => ({ getContext: () => ({
      set fillStyle(v) { calls.push(['style', v]); },
      fillRect: (...r) => calls.push(['rect', ...r])
    }) }) };
  }
  const calls = [];
  const c1 = F.makeFinishCanvas('brick', fakeDoc(calls)), c2 = F.makeFinishCanvas('brick', fakeDoc(calls));
  check('brick canvas generated once and shared', c1 === c2);
  check('brick canvas sized to the tile', c1.width === 384 && c1.height === 96);
  check('mortar painted first', calls[0][0] === 'style' && calls[0][1] === F.BRICK_MORTAR && calls[1][3] === 384);
  check('every brick painted', calls.filter(c => c[0] === 'rect').length === 1 + a.length);
  const tcalls = [];
  const t1 = F.makeFinishCanvas('tile', fakeDoc(tcalls));
  check('tile has its OWN canvas', t1 !== c1 && t1.width === 128 && tcalls[0][1] === F.TILE_GROUT);
  const tex = F.makeFinishTexture(THREE, 'brick');
  check('texture wraps + tiles per metre', tex.wrapS === THREE.RepeatWrapping && tex.wrapT === THREE.RepeatWrapping &&
    near(tex.repeat.x, 1 / 1.8) && near(tex.repeat.y, 1 / 0.45) && tex.image === c1);
  let threw = false;
  try { F.makeFinishCanvas('marble', fakeDoc([])); } catch (e) { threw = true; }
  check('unknown finish refused', threw);
}

// ---- 4. end faces, reveals, wallpaper (loader) ----------------------------------
{
  // Two pillars authored as short north-south segments, like the bathroom's:
  // their 80 cm north / south faces are the segments' END faces.
  const doc = house([
    { id: 41, start: [300, 100], end: [300, 134], thickness: 80, finishes: [
      { finish: 'tile', side: 'north', to: 200 },
      { finish: 'tile', side: 'north', along: [100, 120] },
      { finish: 'tile', side: 'south' }] },
    { id: 42, start: [700, 160], end: [700, 128], thickness: 84, finishes: [
      { finish: 'tile', side: 'south' }, { finish: 'tile', side: 'start' }, { finish: 'tile', side: 'end' }] },
    { id: 32, start: [0, 620], end: [1000, 620], exterior: true, thickness: 10, finishes: [
      { finish: 'brick', side: 'exterior' }, { finish: 'brick', side: 'exterior', reveals: false },
      { finish: 'tile', side: 'north' }, { finish: 'tile', side: 'north', reveals: true }] },
    { id: 50, start: [0, 400], end: [400, 400], faceTexture: { side: 'south', texture: { path: 'x.png' } },
      finishes: [{ finish: 'tile', side: 'south' }, { finish: 'tile', side: 'north' }] }
  ]);
  const { house: h, warnings } = compile(doc);
  const fin = id => h.wallsExt.find(w => w.id === id).finishes;
  const [n41, n41a, s41] = fin(41);
  check('pillar 41: side south -> END face at its END point', s41.face === 'end' && vecIs(s41.normal, [0, 1]) &&
    vecIs(s41.at, [300, 134]), s41);
  check('pillar 41 (N-S, start at the north): side north -> END face at its start',
    n41.face === 'end' && vecIs(n41.normal, [0, -1]) && vecIs(n41.at, [300, 100]) && n41.to === 200, n41);
  check('end face: along is dropped with a warning',
    n41a.along === null && warnings.some(m => /wall 41 finishes\[1\].*end face/.test(m)), n41a);
  const [s42, st42, en42] = fin(42);
  check('pillar 42 (N-S, authored south->north): side south -> END face at its START',
    s42.face === 'end' && vecIs(s42.normal, [0, 1]) && vecIs(s42.at, [700, 160]), s42);
  check('side start -> start end face, pointing back along the wall',
    st42.face === 'end' && vecIs(st42.at, [700, 160]) && vecIs(st42.normal, [0, 1]), st42);
  check('side end -> end face, pointing on along the wall',
    en42.face === 'end' && vecIs(en42.at, [700, 128]) && vecIs(en42.normal, [0, -1]), en42);
  const f32 = fin(32);
  check('long faces are face:long', f32.every(f => f.face === 'long' && f.at === null));
  check('reveals: default ON for exterior', f32[0].reveals === true);
  check('reveals: explicit false honoured', f32[1].reveals === false);
  check('reveals: default OFF for a compass side', f32[2].reveals === false);
  check('reveals: explicit true honoured', f32[3].reveals === true);
  check('wallpapered face + finish on it: warned',
    warnings.some(m => /wall 50 finishes\[0\].*faceTexture/.test(m)), warnings.filter(m => /wall 50/.test(m)));
  check('finish on the OTHER face of a wallpapered wall: not warned', !warnings.some(m => /wall 50 finishes\[1\]/.test(m)));
}

// ---- 5. the finish mesh: quads on the right face, 1.5 mm proud ------------------
function frameOf(w, S, Tcm) {
  const wx1 = w.x1 * S, wz1 = w.y1 * S, dx = w.x2 * S - wx1, dz = w.y2 * S - wz1, len = Math.hypot(dx, dz);
  return { wx1, wz1, ux: dx / len, uz: dz / len, T: Tcm * S, len };
}
/** Every triangle's geometric normal (from its winding) and centroid. */
function triangles(geo) {
  const p = geo.attributes.position, idx = geo.index, out = [];
  for (let i = 0; i < idx.count; i += 3) {
    const [a, b, c] = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, idx.getX(i + k)));
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, b)).normalize();
    out.push({ n, c: a.clone().add(b).add(c).divideScalar(3), a, b, cc: c });
  }
  return out;
}
{
  const centre = [500, 310];
  const cases = [
    ['south skin authored W->E', { x1: 0, y1: 620, x2: 1000, y2: 620 }, [0, 1]],
    ['south skin authored E->W', { x1: 1000, y1: 620, x2: 0, y2: 620 }, [0, 1]],
    ['north wall authored W->E', { x1: 0, y1: 0, x2: 1000, y2: 0 }, [0, -1]],
    ['north wall authored E->W', { x1: 1000, y1: 0, x2: 0, y2: 0 }, [0, -1]],
    ['east wall authored N->S', { x1: 1000, y1: 0, x2: 1000, y2: 620 }, [1, 0]],
    ['east wall authored S->N', { x1: 1000, y1: 620, x2: 1000, y2: 0 }, [1, 0]],
    ['west wall authored N->S', { x1: 0, y1: 0, x2: 0, y2: 620 }, [-1, 0]],
    ['west wall authored S->N', { x1: 0, y1: 620, x2: 0, y2: 0 }, [-1, 0]]
  ];
  for (const [name, w, want] of cases) {
    const out = F.outsideVector(w, centre);
    check(name + ': outsideVector', vecIs(out, want), out);
    for (const n of [want, [-want[0], -want[1]]]) {   // the outside AND the inside face
      const fr = frameOf(w, 0.01, 10);
      const batch = F.createFinishBatch();
      F.addLongFace(batch, fr, n, 1.0, 2.5, 0, 1.2);
      const geo = F.buildFinishGeometry(THREE, batch);
      const tris = triangles(geo);
      const faces = tris.every(t => near(t.n.x, n[0], 1e-6) && near(t.n.z, n[1], 1e-6) && near(t.n.y, 0, 1e-6));
      check(name + ' n=' + n + ': both triangles WOUND to face n (FrontSide)', tris.length === 2 && faces, tris.map(t => t.n.toArray()));
      const nrm = geo.attributes.normal;
      check(name + ' n=' + n + ': vertex normals = n', [0, 1, 2, 3].every(v => near(nrm.getX(v), n[0]) && near(nrm.getZ(v), n[1])));
      // Every vertex 5 cm + 1.5 mm off the centreline on the n side, over exactly [1, 2.5] x [0, 1.2].
      const p = geo.attributes.position, uv = geo.attributes.uv;
      let ok = true, bad = null, sMin = Infinity, sMax = -Infinity, yMin = Infinity, yMax = -Infinity;
      for (let v = 0; v < p.count; v++) {
        const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
        const s = (x - fr.wx1) * fr.ux + (z - fr.wz1) * fr.uz;
        const off = (x - fr.wx1) * n[0] + (z - fr.wz1) * n[1];
        sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
        if (!near(off, 0.05 + F.FINISH_OFFSET, 1e-6)) { ok = false; bad = { off }; }
        if (!near(Math.abs(uv.getX(v)), s, 1e-6) || !near(uv.getY(v), y, 1e-6)) { ok = false; bad = { u: uv.getX(v), s }; }
      }
      check(name + ' n=' + n + ': quad 1.5 mm proud, UVs in metres', ok, bad);
      check(name + ' n=' + n + ': quad covers exactly the rect',
        near(sMin, 1) && near(sMax, 2.5) && near(yMin, 0) && near(yMax, 1.2), [sMin, sMax, yMin, yMax]);
      // u increases left-to-right seen from outside the face (texture not mirrored).
      const right = [n[1], -n[0]];   // viewer's right, looking at the face from outside (y up)
      const i0 = [0, 1, 2, 3].reduce((m, v) => ((p.getX(v) * right[0] + p.getZ(v) * right[1]) <
        (p.getX(m) * right[0] + p.getZ(m) * right[1]) ? v : m), 0);
      const i1 = [0, 1, 2, 3].reduce((m, v) => ((p.getX(v) * right[0] + p.getZ(v) * right[1]) >
        (p.getX(m) * right[0] + p.getZ(m) * right[1]) ? v : m), 0);
      check(name + ' n=' + n + ': texture not mirrored (u grows to the viewer\'s right)', uv.getX(i1) > uv.getX(i0));
    }
    // Cross faces: at s, facing +/- along the wall, across the full thickness.
    for (const facing of [1, -1]) {
      const fr = frameOf(w, 0.01, 30);
      const batch = F.createFinishBatch();
      F.addCrossFace(batch, fr, 2.0, facing, 0.5, 2.0);
      const geo = F.buildFinishGeometry(THREE, batch);
      const tris = triangles(geo);
      const want2 = [fr.ux * facing, fr.uz * facing];
      check(name + ' cross ' + facing + ': wound to face along the wall',
        tris.every(t => near(t.n.x, want2[0], 1e-6) && near(t.n.z, want2[1], 1e-6)), tris.map(t => t.n.toArray()));
      const p = geo.attributes.position;
      let ok = true, tMin = Infinity, tMax = -Infinity;
      for (let v = 0; v < p.count; v++) {
        const s = (p.getX(v) - fr.wx1) * fr.ux + (p.getZ(v) - fr.wz1) * fr.uz;
        const t = -(p.getX(v) - fr.wx1) * fr.uz + (p.getZ(v) - fr.wz1) * fr.ux;
        tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
        if (!near(s, 2.0 + facing * F.FINISH_OFFSET, 1e-6)) ok = false;
      }
      check(name + ' cross ' + facing + ': 1.5 mm out from the end, across the full 30 cm',
        ok && near(tMin, -0.15) && near(tMax, 0.15), [tMin, tMax]);
    }
  }
  check('degenerate wall -> null', F.outsideVector({ x1: 1, y1: 1, x2: 1, y2: 1 }, centre) === null);
  check('empty batch -> no geometry (a wall with no finished faces draws nothing)',
    F.buildFinishGeometry(THREE, F.createFinishBatch()) === null);
  check('revealEnds: full-height pier yes, cill/lintel no',
    F.revealEnds(2.65, 2.65) === true && F.revealEnds(0.4, 2.65) === false);
}

// ---- 6. partial finishes, and one merged mesh per wall ------------------------
{
  const I = Infinity;
  check('rect: no band, no span -> full', F.finishRectOnBox([0, 2], [-0.15, 2.5], [-I, I], [-I, I]).full === true);
  const band = F.finishRectOnBox([0, 2], [-0.15, 2.5], [-I, I], [-I, 1.2]);
  check('rect: tiles to 120 cm -> partial, bottom kept, top cut', band && !band.full &&
    near(band.y0, -0.15) && near(band.y1, 1.2) && near(band.s0, 0) && near(band.s1, 2), band);
  const span = F.finishRectOnBox([1, 3], [0, 2.5], [2.5, 9], [-I, I]);
  check('rect: span clipped to the box', span && !span.full && near(span.s0, 2.5) && near(span.s1, 3), span);
  check('rect: span missing the box -> null', F.finishRectOnBox([0, 1], [0, 2.5], [2, 3], [-I, I]) === null);
  check('rect: band above a cill box -> null', F.finishRectOnBox([0, 1], [0, 0.9], [-I, I], [1.2, I]) === null);
  check('rect: band covering a lintel box exactly -> full', F.finishRectOnBox([0, 1], [2.1, 2.5], [-I, I], [0, 2.5]).full === true);
  const wS = { x1: 500, y1: 590, x2: 500, y2: 0 };
  const m = F.alongToMetres(wS, [100, 400], 0.01);
  check('along on a reversed wall: metres from ITS start', near(m[0], 1.9) && near(m[1], 4.9), m);
  const mF = F.alongToMetres({ x1: 500, y1: 0, x2: 500, y2: 590 }, [400, 100], 0.01);
  check('along on a forward wall, pair given backwards', near(mF[0], 1) && near(mF[1], 4), mF);
  check('along null -> whole wall', F.alongToMetres(wS, null, 0.01)[0] === -Infinity);

  // A wall split around a window exactly as the scene splits it -- two
  // full-height piers, a cill box and a lintel box -- all into ONE batch:
  // one geometry, 4 long quads + 4 reveal quads (each pier's two ends).
  const fr = frameOf({ x1: 0, y1: 620, x2: 400, y2: 620 }, 0.01, 10);
  const batch = F.createFinishBatch();
  const FULL = 2.65, BOT = -0.15;
  const boxes = [[0, 1.2, BOT, FULL], [2.4, 4.0, BOT, FULL], [1.2, 2.4, BOT, 1.05], [1.2, 2.4, 2.1, 0.4]];
  for (const [s0, s1, y0, hgt] of boxes) {
    F.addLongFace(batch, fr, [0, 1], s0, s1, y0, y0 + hgt);
    if (F.revealEnds(hgt, FULL)) {
      F.addCrossFace(batch, fr, s0, -1, y0, y0 + hgt);
      F.addCrossFace(batch, fr, s1, 1, y0, y0 + hgt);
    }
  }
  const geo = F.buildFinishGeometry(THREE, batch);
  check('window wall: ONE geometry, no groups (a single draw)', !!geo && geo.groups.length === 0);
  check('window wall: 4 long + 4 reveal quads = 16 triangles', geo.index.count / 3 === 16, geo.index.count / 3);
  // UVs continue across boxes: the pier's right edge and the lintel's left
  // edge meet at s = 1.2 with the same u.
  const uv = geo.attributes.uv, p = geo.attributes.position;
  const uAt = [];
  for (let v = 0; v < p.count; v++) {
    if (near(geo.attributes.normal.getZ(v), 1) && near(p.getX(v) - fr.wx1, 1.2, 1e-6)) uAt.push(uv.getX(v));
  }
  check('coursing continues across boxes (same u where two boxes meet)',
    uAt.length === 6 && uAt.every(u => near(u, uAt[0], 1e-6)), uAt);
}

// ---- 7. the scene wires it (source guard) --------------------------------------
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('scene: wall loop reads finishes', /WALL_EXT\.forEach\(\(\{[^}]*\bfinishes \}\)/.test(src));
  check('scene: ONE batch per wall per finish', /const key = id \+ '\|' \+ f\.finish;/.test(src) &&
    /finishBatches\.set\(key,/.test(src));
  check('scene: ONE mesh per batch', /finishBatches\.forEach\(\(\{ batch, wallId, finish, outer \}\) => \{[\s\S]{0,200}new THREE\.Mesh\(geo, finishMaterial\(finish, outer\)\)/.test(src));
  check('scene: finish mesh casts no shadow (no extra shadow-pass draw)', /mesh\.castShadow = false;\s*mesh\.name = 'wall-finish:'/.test(src));
  check('scene: wall boxes keep a single material (no per-face finish array)',
    !/withFaceFinish|faceSlot\(/.test(src));
  check('scene: every box intersects every finish', /finishRectOnBox\(boxSpan, boxY, wf\.span, wf\.range\)/.test(src));
  check('scene: reveals only on full-height boxes', /wf\.reveals && revealEnds\(h, WALL_FULL_H\)/.test(src));
  check('scene: finish meshes join the fade with the host wall',
    /finishMeshes\.forEach\(\(\{ mesh, wallId \}\) => \{\s*const host = wallEntryById\[wallId\];\s*if \(!host \|\| !host\.outer\) return;\s*wallMeshes\.push\(\{ mesh, nx: host\.nx, nz: host\.nz, outer: true \}\)/.test(src));
  check('scene: the #63 fade loop is intact (base opacity + depthWrite)',
    /wallFadeTarget\(dot, b\)/.test(src) && /wallFadeDepthWrite\(mesh\.material\.opacity, b, baseDepthWrite\)/.test(src));
}

console.log((failures ? 'FAILED' : 'OK') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
