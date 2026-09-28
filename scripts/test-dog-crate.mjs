#!/usr/bin/env node
/**
 * dog-crate.js: the decisions the generic contract test cannot pin.
 * No framework, no install: `node scripts/test-dog-crate.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract at DEFAULTS for every registered type. This file adds:
 *
 *   1. The envelope holds at DEFAULTS and at other sizes, with and without
 *      the cover and each door, full and low detail.
 *   2. The wire mesh: ONE kept, double-sided, alpha-cutout mesh in a satin
 *      (not metal) wireColor; flat planes plus rounded top-edge strips at
 *      full, flat planes only at low.
 *   3. The wire tile: real holes, a whole vertical wire along v and a whole
 *      horizontal wire along u, each ~0.3 cm thick at the default pitches;
 *      max-alpha mips so it never vanishes at a distance.
 *   4. The uvs put a vertical wire every wirePitch and a horizontal wire every
 *      rowPitch, and follow the params.
 *   5. The rounded top edges are mitred: no mesh vertex stands outside the
 *      rounded profile at a corner, and the top reaches the full height.
 *   6. Doors: the side door on the FRONT toward the chosen end, the end door
 *      on the chosen end, 'none' removes each; two latches per door on its
 *      free edge, standing proud of the wire but inside the envelope.
 *   7. The pan: matte panColor, the full footprint, 3.5 tall.
 *   8. The cover: OFF by default; on, it is the envelope, matte coverColor,
 *      open over the side door.
 *   9. The handle: on the front, clear of the side door, inside the envelope.
 *  10. Triangle caps: full <= 1000, low <= 200, low <= 0.3 x full.
 *  11. The wire survives the renderer's merge as a kept, textured part.
 *
 * Each check names the one-line mutation of dog-crate.js it catches.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const C = await imp('src/furniture/dog-crate.js');
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
  group.traverse(o => { if (o.isMesh) n += o.geometry.index.count / 3; });
  return n;
}
const byName = (group, name) => group.children.filter(o => o.isMesh && o.name === name)[0];
const hex = c => parseInt(c.slice(1), 16);
/** Every box of a merged box geometry (24 vertices each), as [x0, x1, y0, y1, z0, z1] in cm. */
function boxesOf(mesh) {
  if (!mesh) return [];
  const pos = mesh.geometry.attributes.position, out = [];
  for (let s = 0; s < pos.count; s += 24) {
    const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (let i = s; i < s + 24; i++) {
      const x = pos.getX(i) * 100, y = pos.getY(i) * 100, z = pos.getZ(i) * 100;
      b[0] = Math.min(b[0], x); b[1] = Math.max(b[1], x); b[2] = Math.min(b[2], y);
      b[3] = Math.max(b[3], y); b[4] = Math.min(b[4], z); b[5] = Math.max(b[5], z);
    }
    out.push(b);
  }
  return out;
}
const inside = (b, x, y, z) => x > b[0] && x < b[1] && y > b[2] && y < b[3] && z > b[4] && z < b[5];
const P = C.DEFAULTS;

// ---- 1. envelope ---------------------------------------------------------------
{
  check('TYPE is dog-crate', C.TYPE === 'dog-crate');
  check('DEFAULTS frozen', Object.isFrozen(C.DEFAULTS));
  // The defaults are a 42-inch two-door crate over its latches (109 x 72 x 76).
  check('DEFAULTS are 109 x 72 x 76', P.width === 109 && P.depth === 72 && P.height === 76, P);
  const cases = [
    ['DEFAULTS', {}],
    ['cover', { cover: true }],
    ['no doors', { sideDoor: 'none', endDoor: 'none' }],
    ['doors swapped', { sideDoor: 'left', endDoor: 'right' }],
    ['small', { width: 61, depth: 46, height: 49 }],
    ['large, cover', { width: 122, depth: 76, height: 84, cover: true }],
    ['tiny', { width: 30, depth: 25, height: 25 }]
  ];
  for (const [tag, params] of cases) {
    const p = Object.assign({}, P, params);
    for (const detail of ['full', 'low']) {
      const b = bboxCm(C.build(THREE, params, { detail }));
      const t = tag + ' (' + detail + ')';
      // Mutation: pan x from -W/2 + 1 -> width fails.
      check(t + ': width == params, x centred', Math.abs(b.maxX - b.minX - p.width) <= 0.5 && Math.abs(b.maxX + b.minX) <= 0.5, { b, w: p.width });
      // Mutation: yt = H + 1 -> height fails.
      check(t + ': height == params, bottom at 0', Math.abs(b.minY) <= 0.5 && Math.abs(b.maxY - p.height) <= 0.5, { b, h: p.height });
      // Mutation: LATCH_PROUD = 1.5 (past the inset) -> depth fails.
      check(t + ': depth == params, back at 0', Math.abs(b.minZ) <= 0.5 && Math.abs(b.maxZ - p.depth) <= 0.5, { b, d: p.depth });
    }
  }
}

// ---- 2. wire mesh ----------------------------------------------------------------
{
  const g = C.build(THREE, {}, { detail: 'full' });
  const w = byName(g, 'wire-mesh');
  check('wire: one wire-mesh', !!w && g.children.filter(o => o.name === 'wire-mesh').length === 1);
  const m = w ? w.material : {};
  // Mutation: makeFinish(THREE, 'metal', ...) for the mesh -> fails.
  check('wire: satin, not metal, in wireColor', m.userData && m.userData.finish === 'satin' && m.metalness === 0 &&
    m.color.getHex() === hex(P.wireColor), m.userData);
  // Mutation: drop `mm.alphaTest = ...` -> the holes draw solid -> fails.
  check('wire: alpha-cutout (map + alphaTest), not blended', !!m.map && m.alphaTest > 0 && m.alphaTest < 1 && m.transparent !== true, { a: m.alphaTest });
  // Mutation: drop `mm.side = DoubleSide` -> the far panels vanish from inside the view -> fails.
  check('wire: double-sided', m.side === THREE.DoubleSide);
  // Mutation: drop the keep line -> fails.
  check('wire: kept', !!w && Fin.partKeep(w).keep === true);
  // Five flat planes (2 triangles each) + four rounded strips of 3 segments.
  // Mutation: ARC_SEG = 6 -> 58 -> fails.
  check('wire: 34 triangles at full (5 planes + 4 x 3-segment rounded edges)', !!w && w.geometry.index.count / 3 === 34, w && w.geometry.index.count / 3);
  const lw = byName(C.build(THREE, {}, { detail: 'low' }), 'wire-mesh');
  // Mutation: wireGeometry(..., true) at low -> 34 -> fails.
  check('wire: 10 triangles at low (five flat planes)', !!lw && lw.geometry.index.count / 3 === 10, lw && lw.geometry.index.count / 3);
  check('wire low: the same cutout material', !!lw && !!lw.material.map && lw.material.alphaTest > 0);
}

// ---- 3. the tile ----------------------------------------------------------------
{
  const { levels } = C.wireTile();
  const L0 = levels[0];
  const alphaAt = (lv, u, v) => lv.data[(v * lv.width + u) * 4 + 3];
  const cover = lv => { let n = 0; for (let i = 3; i < lv.data.length; i += 4) if (lv.data[i] >= C.WIRE_ALPHA_TEST * 255) n++; return n / (lv.width * lv.height); };
  const c0 = cover(L0);
  // Mutation: `wire = u < TILE_U || ...` (no holes) or `u < 0 && v < 0` (no wire) -> fails.
  check('tile: mostly open, with wire (10-30 %)', c0 >= 0.1 && c0 <= 0.3, c0);
  let vWhole = true, hWhole = true;
  for (let v = 0; v < L0.height; v++) if (alphaAt(L0, 0, v) !== 255) vWhole = false;
  for (let u = 0; u < L0.width; u++) if (alphaAt(L0, u, 0) !== 255) hWhole = false;
  // Mutation: `u < V_WIRE_PX && v < H_WIRE_PX` -> no whole wires -> fails.
  check('tile: column 0 is a whole vertical wire, row 0 a whole horizontal wire', vWhole && hWhole);
  let rowMetal = 0, colMetal = 0;
  for (let u = 0; u < L0.width; u++) if (alphaAt(L0, u, L0.height >> 1) === 255) rowMetal++;
  for (let v = 0; v < L0.height; v++) if (alphaAt(L0, L0.width >> 1, v) === 255) colMetal++;
  const vCm = rowMetal / L0.width * P.wirePitch, hCm = colMetal / L0.height * P.rowPitch;
  // Mutation: V_WIRE_PX = 4 -> 0.63 cm -> fails.
  check('tile: each wire ~0.3 cm thick at the default pitches', vCm >= 0.2 && vCm <= 0.45 && hCm >= 0.2 && hCm <= 0.45, { vCm, hCm });
  const m = byName(C.build(THREE, {}, { detail: 'full' }), 'wire-mesh').material;
  check('tile: power-of-two with a full mip chain to 1x1, supplied by hand', L0.width === 16 && L0.height === 32 &&
    levels[levels.length - 1].width === 1 && levels[levels.length - 1].height === 1 &&
    m.map.mipmaps.length === levels.length && m.map.generateMipmaps === false);
  // Mutation: average the alpha instead of max -> the crate VANISHES at a distance -> fails.
  let monotone = true;
  for (let i = 1; i < levels.length; i++) if (cover(levels[i]) < cover(levels[i - 1]) - 1e-9) monotone = false;
  check('mips: coverage never drops with distance, and the 1x1 mip is solid', monotone && cover(levels[levels.length - 1]) === 1, levels.map(cover));
}

// ---- 4. uvs -----------------------------------------------------------------------
{
  // The FRONT plane: its four vertices have normal +z and z at the cage front.
  const pitchOf = params => {
    const w = byName(C.build(THREE, params, { detail: 'full' }), 'wire-mesh');
    const pos = w.geometry.attributes.position, nor = w.geometry.attributes.normal, uv = w.geometry.attributes.uv;
    const idx = [];
    for (let i = 0; i < pos.count; i++) if (nor.getZ(i) === 1 && nor.getY(i) === 0) idx.push(i);
    const ext = f => { const v = idx.map(f); return Math.max(...v) - Math.min(...v); };
    return {
      n: idx.length,
      alongX: ext(i => pos.getX(i) * 100) / ext(i => uv.getX(i)),
      upY: ext(i => pos.getY(i) * 100) / ext(i => uv.getY(i))
    };
  };
  const d = pitchOf({});
  // Mutation: U = s => s / rowPitch -> fails.
  check('uv: the front plane has a vertical wire every wirePitch and a horizontal one every rowPitch',
    d.n === 4 && Math.abs(d.alongX - P.wirePitch) < 1e-3 && Math.abs(d.upY - P.rowPitch) < 1e-3, d);
  const e = pitchOf({ wirePitch: 3, rowPitch: 7.5 });
  // Mutation: the params ignored (DEFAULTS used) -> fails.
  check('uv: follows wirePitch 3 / rowPitch 7.5', Math.abs(e.alongX - 3) < 1e-3 && Math.abs(e.upY - 7.5) < 1e-3, e);
}

// ---- 5. rounded, mitred top edges ------------------------------------------------------
{
  const L = C.layout({});
  const w = byName(C.build(THREE, {}, { detail: 'full' }), 'wire-mesh');
  const pos = w.geometry.attributes.position;
  let above = 0, outside = [], topY = -Infinity;
  const ys = L.yt - L.r;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) * 100, y = pos.getY(i) * 100, z = pos.getZ(i) * 100;
    topY = Math.max(topY, y);
    if (y <= ys + 1e-3) continue;
    above++;
    // on the rounded band, every vertex must be at least `need` in from EVERY side face
    const need = L.r - Math.sqrt(Math.max(0, L.r * L.r - (y - ys) * (y - ys)));
    const inset = Math.min(x - L.xl, L.xr - x, z - L.zb, L.zf - z);
    if (inset < need - 1e-3) outside.push({ x, y, z, inset, need });
  }
  // Mutation: the rounded strips dropped (r forced 0 at full) -> no vertex above ys but the top -> fails.
  check('rounded edges: mesh vertices on the curve between the sides and the top', above > 8, above);
  // Mutation: a strip's ends not mitred (d0/d1 dropped from the x range) -> a corner pokes out -> fails.
  check('rounded edges: mitred -- no vertex outside the rounded profile at a corner', outside.length === 0, outside.slice(0, 3));
  check('rounded edges: the top reaches the full height', Math.abs(topY - L.yt) < 1e-3 && Math.abs(L.yt - P.height) < 1e-6, { topY });
  check('rounded edges: radius 3.5 at DEFAULTS', Math.abs(L.r - 3.5) < 1e-9, L.r);
}

// ---- 6. doors and latches ------------------------------------------------------------
{
  const L = C.layout({});
  const g = C.build(THREE, {}, { detail: 'full' });
  const doors = boxesOf(byName(g, 'door-frames'));
  const front = doors.filter(b => b[4] >= L.zf - 1e-3);
  const end = doors.filter(b => b[1] <= L.xl + 1e-3);
  // Mutation: side door z0 = zb (the back) -> no front frame -> fails.
  check('side door: a 4-rod frame on the front, outside the wire', front.length === 4, front.length);
  const fx0 = Math.min(...front.map(b => b[0])), fx1 = Math.max(...front.map(b => b[1]));
  // Mutation: sideDoor 'right' placing at xl + gap -> fails.
  check("side door 'right': toward the right end", fx1 > 0 && fx1 <= L.xr && (fx0 + fx1) / 2 > 0, { fx0, fx1 });
  check('side door: a real door (40-65 wide, 45+ tall)', fx1 - fx0 >= 40 && fx1 - fx0 <= 65 &&
    Math.max(...front.map(b => b[3])) - Math.min(...front.map(b => b[2])) >= 45, { w: fx1 - fx0 });
  // Mutation: end door x0 = xr (the wrong end) -> fails.
  check("end door 'left': a 4-rod frame on the -x end", end.length === 4, end.length);
  const gl = C.build(THREE, { sideDoor: 'left', endDoor: 'right' }, { detail: 'full' });
  const Ll = C.layout({ sideDoor: 'left', endDoor: 'right' });
  const dl = boxesOf(byName(gl, 'door-frames'));
  const fl = dl.filter(b => b[4] >= Ll.zf - 1e-3);
  check("side door 'left': toward the left end", fl.length === 4 && (Math.min(...fl.map(b => b[0])) + Math.max(...fl.map(b => b[1]))) / 2 < 0);
  check("end door 'right': on the +x end", dl.filter(b => b[0] >= Ll.xr - 1e-3).length === 4);
  const gn = C.build(THREE, { sideDoor: 'none', endDoor: 'none' }, { detail: 'full' });
  // Mutation: sideOf() ignoring 'none' -> fails.
  check("doors 'none': no door frames and no latches", !byName(gn, 'door-frames') && !byName(gn, 'latches'));
  check("sideDoor 'none' alone: only the end door's frame", boxesOf(byName(C.build(THREE, { sideDoor: 'none' }, { detail: 'full' }), 'door-frames')).length === 4);
  check('unknown door value -> the default', !!C.layout({ sideDoor: 'up' }).side && C.layout({ sideDoor: 'up' }).side.x0 === L.side.x0);

  const lat = boxesOf(byName(g, 'latches'));
  // Mutation: one latch per door (drop the 0.75 entry) -> 2 -> fails.
  check('latches: two per door', lat.length === 4, lat.length);
  const sideL = lat.filter(b => b[4] >= L.zf - 1e-3), endL = lat.filter(b => b[1] <= L.xl + 1e-3);
  // Mutation: latches at zf - P (inside the wire) -> fails.
  check('latches: side-door bolts stand proud of the front wire, inside the envelope', sideL.length === 2 &&
    sideL.every(b => b[5] > L.zf + 0.5 && b[5] < P.depth), sideL);
  check('latches: end-door bolts stand proud of the end wire, inside the envelope', endL.length === 2 &&
    endL.every(b => b[0] < L.xl - 0.5 && b[0] > -P.width / 2), endL);
  // The side door is hinged at its end-of-crate edge; the bolts are on the edge toward the middle.
  // Mutation: latchX = x0 + w for a 'right' door -> fails.
  check("latches: a 'right' side door bolts on its left (middle-facing) edge", sideL.every(b => Math.abs((b[0] + b[1]) / 2 - fx0) < 0.5), { fx0, sideL });
  check('latches: metal finish', byName(g, 'latches').material.userData.finish === 'metal');
}

// ---- 7. pan ------------------------------------------------------------------------------
{
  const g = C.build(THREE, {}, { detail: 'full' });
  const pan = byName(g, 'pan');
  const b = bboxCm(pan);
  // Mutation: pan in 'gloss' -> fails.
  check('pan: matte panColor', pan.material.userData.finish === 'matte' && pan.material.color.getHex() === hex(P.panColor));
  // Mutation: PAN_H = 5 -> fails.
  check('pan: the full footprint, 3.5 tall', Math.abs(b.maxX - b.minX - P.width) < 1e-3 && Math.abs(b.minZ) < 1e-3 &&
    Math.abs(b.maxZ - P.depth) < 1e-3 && Math.abs(b.minY) < 1e-3 && Math.abs(b.maxY - 3.5) < 1e-3, b);
}

// ---- 8. cover ----------------------------------------------------------------------------
{
  // Mutation: DEFAULTS cover true -> fails.
  check('cover: OFF by default', P.cover === false && !byName(C.build(THREE, {}, { detail: 'full' }), 'cover'));
  const g = C.build(THREE, { cover: true }, { detail: 'full' });
  const cv = byName(g, 'cover');
  check('cover: on when asked, matte coverColor', !!cv && cv.material.userData.finish === 'matte' && cv.material.color.getHex() === hex(P.coverColor));
  const cb = bboxCm(cv);
  // Mutation: cover top at H - COVER_T -> fails.
  check('cover: it is the envelope', Math.abs(cb.maxX - cb.minX - P.width) < 1e-3 && Math.abs(cb.maxY - P.height) < 1e-3 &&
    Math.abs(cb.minZ) < 1e-3 && Math.abs(cb.maxZ - P.depth) < 1e-3, cb);
  const L = C.layout({ cover: true });
  const pieces = boxesOf(cv).concat(boxesOf(byName(g, 'cover-roll')));
  const mx = (L.side.x0 + L.side.x1) / 2, my = (L.side.y0 + L.side.y1) / 2;
  // Mutation: the front drawn as one full piece -> fails.
  check('cover: open over the side door (flap rolled up)', !pieces.some(b => inside(b, mx, my, P.depth - 0.3)));
  check('cover: closed over the back and the top', pieces.some(b => inside(b, 0, 40, 0.3)) && pieces.some(b => inside(b, 0, P.height - 0.3, 36)));
  check('cover: a rolled flap above the opening', boxesOf(byName(g, 'cover-roll')).some(b => b[2] >= L.side.y1 - 1e-3 && b[5] > P.depth - 0.5));
  // Under the cover the cage drops below the cover's top and the pan goes inside the wire.
  const pb = bboxCm(byName(g, 'pan'));
  check('cover: the pan sits inside the cover', pb.minZ > 0.5 && pb.maxX < P.width / 2 - 0.5, pb);
  check('cover: the cage top is under the cover top', L.yt < P.height - 0.6);
  check('cover: in the furniture JSON only when on', !('cover' in C.toFurnitureJSON({}).params) &&
    C.toFurnitureJSON({ cover: true }).params.cover === true);
}

// ---- 9. handle ---------------------------------------------------------------------------
{
  const L = C.layout({});
  const hb = boxesOf(byName(C.build(THREE, {}, { detail: 'full' }), 'handle'));
  const x0 = Math.min(...hb.map(b => b[0])), x1 = Math.max(...hb.map(b => b[1]));
  check('handle: three parts on the front, inside the envelope', hb.length === 3 &&
    hb.every(b => b[4] >= L.zf - 1e-3 && b[5] < P.depth), hb);
  // Mutation: handle centred on x = 0 (over the side door) -> fails.
  check('handle: clear of the side door', x1 < L.side.x0 || x0 > L.side.x1, { x0, x1, door: [L.side.x0, L.side.x1] });
  check('handle: high on the front', Math.min(...hb.map(b => b[2])) > P.height * 0.75);
}

// ---- 10. triangle caps ---------------------------------------------------------------------
{
  for (const params of [{}, { cover: true }, { sideDoor: 'left', endDoor: 'right' }]) {
    const tf = triangles(C.build(THREE, params, { detail: 'full' }));
    const tl = triangles(C.build(THREE, params, { detail: 'low' }));
    // Mutation: build the rods at low too -> low > 0.3 x full -> fails.
    check('caps ' + JSON.stringify(params) + ': full <= 1000, low <= 200, low <= 0.3 x full',
      tf <= 1000 && tl <= 200 && tl <= 0.3 * tf, { tf, tl });
  }
  const lg = C.build(THREE, {}, { detail: 'low' });
  check('low: only the pan and the wire', lg.children.map(o => o.name).sort().join() === 'pan,wire-mesh', lg.children.map(o => o.name));
}

// ---- 11. merge ------------------------------------------------------------------------------
{
  const Merge = await imp('src/furniture/merge.js');
  const flat = Merge.flattenGroup(THREE, C.build(THREE, {}, { detail: 'full' }));
  const wp = flat.parts.filter(pt => pt.material && pt.material.alphaTest > 0);
  check('wire: survives the merge as a kept, textured part with uvs', wp.length === 1 && Merge.bucketClass(wp[0]) === 'kept' &&
    wp[0].textured && !!wp[0].geometry.attributes.uv, wp.map(pt => ({ keep: pt.keep, textured: pt.textured })));
}

// ---- toFurnitureJSON -----------------------------------------------------------------------
{
  const j = C.toFurnitureJSON(Object.assign({}, P, { sideDoor: 'left', wirePitch: 3 }));
  check('toFurnitureJSON: only non-default keys', j.type === 'dog-crate' &&
    JSON.stringify(j.params) === JSON.stringify({ wirePitch: 3, sideDoor: 'left' }), j);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
