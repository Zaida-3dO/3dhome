#!/usr/bin/env node
/**
 * balcony.js: the decisions the generic contract test cannot pin.
 * No framework, no install: `node scripts/test-balcony.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract at DEFAULTS for every registered type. This file adds:
 *
 *   1. The envelope holds at DEFAULTS and at other sizes, both railings and
 *      every side mode.
 *   2. The largest CLEAR gap between adjacent vertical members of the front
 *      railing (bars and corner posts), measured on the built geometry, is
 *      <= 10 cm -- including with a barSpacing that asks for more. The same
 *      holds for the left/right side runs, measured along z and including
 *      the building face (z = 0) and the front corner post as boundaries.
 *   3. The front rail's max z is the depth (the railing is at the front).
 *   4. leftSide / rightSide 'none' removes that side's parts, 'solid' adds a
 *      solid panel on that side (and only that side; +x is right).
 *   5. The glass railing's panes are glass and kept.
 *   6. Triangle caps at DEFAULTS: full <= 1500, low <= 450, low <= 0.6 x full.
 *   7. The decking floor (an option): boards run along x, with real gaps,
 *      deck top at slabThickness, kept; a metal edge trim; 'slab' and low
 *      detail fall back to one slab box.
 *   8. The grating floor (the default): one kept, two-plane, alpha-cutout
 *      mesh in a satin (not metal) near-black, with real holes, load bars
 *      running along z at gratingPitch and cross bars along x; max-alpha
 *      mips so it never vanishes at a distance; top at slabThickness; a
 *      metal perimeter frame it meets edge to edge; no solid slab under it;
 *      it survives the renderer's merge as a textured kept part.
 *
 * Each check names the one-line mutation of balcony.js it catches.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const B = await imp('src/furniture/balcony.js');
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
const meshes = (group, pred) => group.children.filter(o => o.isMesh && (!pred || pred(o)));
const byName = (group, name) => meshes(group, m => m.name === name)[0];

/**
 * The interval (cm) along `axis` ('x' or 'z') of every separate box in a
 * merged box geometry: each box is a run of consecutive vertices (24, or 16
 * for an open box). Returns sorted [lo, hi] pairs, one per box.
 */
function boxIntervalsAlong(mesh, axis) {
  mesh.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position;
  // boxes built with end caps have +-y faces (24 vertices each); open (low
  // detail) boxes have none (16 vertices each)
  const nor = mesh.geometry.attributes.normal;
  let capped = false;
  for (let i = 0; i < nor.count; i++) if (Math.abs(nor.getY(i)) > 0.5) { capped = true; break; }
  const perBox = capped ? 24 : 16;
  const out = [];
  const v = new THREE.Vector3();
  for (let s = 0; s < pos.count; s += perBox) {
    let lo = Infinity, hi = -Infinity;
    for (let i = s; i < s + perBox; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const c = (axis === 'x' ? v.x : v.z) * 100;
      lo = Math.min(lo, c); hi = Math.max(hi, c);
    }
    out.push([lo, hi]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** The x-intervals (cm) of every separate box in a merged box geometry. */
const boxIntervalsX = mesh => boxIntervalsAlong(mesh, 'x');

/**
 * The max clear gap along a run's own axis between its vertical members,
 * INCLUDING the run's fixed boundaries: for 'front' the two ends of the
 * railing span (already posts/solid, so no extra boundary is added here);
 * for 'left'/'right' the building face at z = 0 and the front corner post
 * that the side run butts up against at its far end.
 */
function runMaxGap(g, runName) {
  const axis = runName === 'front' ? 'x' : 'z';
  const members = [];
  meshes(g, m => m.userData.run === runName && m.userData.vertical).forEach(m => members.push(...boxIntervalsAlong(m, axis)));
  if (runName !== 'front') {
    members.push([0, 0]); // the building face, z = 0
    meshes(g, m => m.userData.run === 'front' && m.userData.role === 'post').forEach(m => members.push(...boxIntervalsAlong(m, axis)));
  }
  members.sort((a, b) => a[0] - b[0]);
  let max = 0;
  for (let i = 1; i < members.length; i++) max = Math.max(max, members[i][0] - members[i - 1][1]);
  return { max, count: members.length };
}
const frontMaxGap = g => runMaxGap(g, 'front');

// ---- 1. envelope ---------------------------------------------------------------
{
  check('TYPE is balcony', B.TYPE === 'balcony');
  check('DEFAULTS frozen', Object.isFrozen(B.DEFAULTS));
  const cases = [
    ['DEFAULTS', {}],
    ['small', { width: 200, depth: 90, height: 100 }],
    ['deep and tall', { width: 320, depth: 240, height: 125, slabThickness: 25, railingThickness: 8 }],
    ['glass', { railing: 'glass' }],
    ['solid left, open right', { leftSide: 'solid', rightSide: 'none' }],
    ['both open', { leftSide: 'none', rightSide: 'none', width: 400 }],
    ['decking', { floor: 'decking' }],
    ['slab', { floor: 'slab' }],
    ['grating, 11 slab, tiny', { slabThickness: 11, width: 30, depth: 20, height: 40 }]
  ];
  for (const [tag, params] of cases) {
    const p = Object.assign({}, B.DEFAULTS, params);
    for (const detail of ['full', 'low']) {
      const b = bboxCm(B.build(THREE, params, { detail }));
      const t = tag + ' (' + detail + ')';
      // Mutation: slab width W -> W - 2 (and no side at the edge) -> width fails.
      check(t + ': width == params, x centred', Math.abs(b.maxX - b.minX - p.width) <= 0.5 && Math.abs(b.maxX + b.minX) <= 1, { b, w: p.width });
      // Mutation: top rail y1 = H + 2 -> height fails.
      check(t + ': height == params, bottom at 0', Math.abs(b.minY) <= 0.5 && Math.abs(b.maxY - p.height) <= 0.5, { b, h: p.height });
      // Mutation: front run fixed at D + rt / 2 -> depth fails.
      check(t + ': depth == params, back at 0', Math.abs(b.minZ) <= 0.5 && Math.abs(b.maxZ - p.depth) <= 0.5, { b, d: p.depth });
    }
  }
}

// ---- 2. clear gap between front bars <= 10 cm -----------------------------------
{
  for (const [tag, params] of [['DEFAULTS', {}], ['barSpacing 25 asks for too much', { barSpacing: 25 }],
    ['small', { width: 200, depth: 90 }], ['solid sides', { leftSide: 'solid', rightSide: 'solid' }]]) {
    const g = B.build(THREE, params, { detail: 'full' });
    const { max, count } = frontMaxGap(g);
    // Mutation: MAX_GAP 10 -> 20 fails the barSpacing-25 case; `k` computed
    // with Math.floor instead of Math.ceil fails DEFAULTS.
    check(tag + ': front max clear gap <= 10 cm', count > 2 && max <= 10 + 1e-6, { max, count });
    check(tag + ': front clear gap is real (> 1 cm)', max > 1, { max });
  }
  // Side runs (leftSide/rightSide: 'railing'): the same <= 10 cm clear-gap
  // rule applies, including the gap at the building face (z = 0) and at the
  // front corner post the side run butts against.
  for (const [tag, params] of [['DEFAULTS', {}], ['barSpacing 25 asks for too much', { barSpacing: 25 }],
    ['small', { width: 200, depth: 90 }]]) {
    const g = B.build(THREE, params, { detail: 'full' });
    for (const side of ['left', 'right']) {
      const { max, count } = runMaxGap(g, side);
      // Mutation: side run starting at z = 14 instead of 0 (a 14 cm gap at
      // the building face) -> fails, because z = 0 is included as a
      // boundary member here even though it is not part of the run itself.
      check(tag + ': ' + side + ' max clear gap <= 10 cm', count > 1 && max <= 10 + 1e-6, { max, count });
      check(tag + ': ' + side + ' clear gap is real (> 1 cm)', max > 1, { max });
    }
  }
  // The DEFAULT bars: about barSpacing apart, so not needlessly dense.
  const g = B.build(THREE, {}, { detail: 'full' });
  const bars = boxIntervalsX(byName(g, 'front-bars'));
  const pitch = (bars[bars.length - 1][0] - bars[0][0]) / (bars.length - 1);
  check('DEFAULTS: bar pitch within 1 cm of barSpacing', Math.abs(pitch - B.DEFAULTS.barSpacing) <= 1, { pitch, n: bars.length });
  // Low detail drops every second bar.
  const low = boxIntervalsX(byName(B.build(THREE, {}, { detail: 'low' }), 'front-bars'));
  check('low keeps every second bar', low.length === Math.ceil(bars.length / 2), { full: bars.length, low: low.length });
}

// ---- 3. front rail at z = depth -------------------------------------------------
{
  for (const params of [{}, { depth: 120 }, { railing: 'glass' }]) {
    const p = Object.assign({}, B.DEFAULTS, params);
    const g = B.build(THREE, params, { detail: 'full' });
    const rail = bboxCm(byName(g, 'front-rails'));
    // Mutation: front run fixed at D - rt * 1.5 -> fails.
    check(JSON.stringify(params) + ': front rail max z == depth', Math.abs(rail.maxZ - p.depth) <= 0.5, rail);
    check(JSON.stringify(params) + ': front rail top == height', Math.abs(rail.maxY - p.height) <= 0.5, rail);
    check(JSON.stringify(params) + ': front rail spans the width', rail.maxX - rail.minX >= p.width - 2 * p.railingThickness - 0.5, rail);
  }
}

// ---- 4. side modes ---------------------------------------------------------------
{
  const sidesOf = (g, side) => meshes(g, m => m.userData.side === side);
  const both = B.build(THREE, {}, { detail: 'full' });
  check('railing sides: left rails and bars', sidesOf(both, 'left').length >= 2, sidesOf(both, 'left').map(m => m.name));
  check('railing sides: right rails and bars', sidesOf(both, 'right').length >= 2);

  const noneL = B.build(THREE, { leftSide: 'none' }, { detail: 'full' });
  // Mutation: sideMode() ignoring 'none' -> fails.
  check("leftSide 'none': no left parts", sidesOf(noneL, 'left').length === 0, sidesOf(noneL, 'left').map(m => m.name));
  check("leftSide 'none': right side untouched", sidesOf(noneL, 'right').length === sidesOf(both, 'right').length);
  check("leftSide 'none': fewer triangles", triangles(noneL) < triangles(both));
  const noneR = B.build(THREE, { rightSide: 'none' }, { detail: 'full' });
  check("rightSide 'none': no right parts", sidesOf(noneR, 'right').length === 0);
  check("rightSide 'none': left side untouched", sidesOf(noneR, 'left').length === sidesOf(both, 'left').length);

  const solidR = B.build(THREE, { rightSide: 'solid' }, { detail: 'full' });
  const panel = byName(solidR, 'right-solid');
  check("rightSide 'solid': a solid panel", !!panel && panel.userData.role === 'solid');
  check("rightSide 'solid': no right bars", !byName(solidR, 'right-bars'));
  const pb = panel && bboxCm(panel);
  // Mutation: sides.right sign -1 -> the panel lands at -x -> fails.
  check("rightSide 'solid': the panel is at +x (right, seen from the front)", !!pb && pb.minX > 0 && Math.abs(pb.maxX - B.DEFAULTS.width / 2) <= 0.5, pb);
  check("rightSide 'solid': panel runs building face to front, slab top to rail top",
    !!pb && Math.abs(pb.minZ) <= 0.5 && Math.abs(pb.maxZ - B.DEFAULTS.depth) <= 0.5 &&
    Math.abs(pb.minY - B.DEFAULTS.slabThickness) <= 0.5 && Math.abs(pb.maxY - B.DEFAULTS.height) <= 0.5, pb);
  check("rightSide 'solid': panel is matte in solidColor", !!panel && panel.material.userData.finish === 'matte' &&
    panel.material.color.getHex() === parseInt(B.DEFAULTS.solidColor.slice(1), 16));
  check("rightSide 'solid': left side still a railing", !!byName(solidR, 'left-bars'));
  const solidL = B.build(THREE, { leftSide: 'solid' }, { detail: 'full' });
  const lb = bboxCm(byName(solidL, 'left-solid'));
  check("leftSide 'solid': the panel is at -x", lb.maxX < 0 && Math.abs(lb.minX + B.DEFAULTS.width / 2) <= 0.5, lb);
}

// ---- 5. glass railing -------------------------------------------------------------
{
  for (const detail of ['full', 'low']) {
    const g = B.build(THREE, { railing: 'glass' }, { detail });
    const panes = meshes(g, m => m.userData.role === 'glass');
    check(detail + ': glass railing has panes on all three runs', panes.length === 3, panes.map(m => m.name));
    // Mutation: mats.glass finish 'matte' -> fails.
    check(detail + ': panes are glass', panes.length > 0 && panes.every(m => Fin.partFinish(m).finish === 'glass'));
    // Mutation: drop the keep line in add() -> fails.
    check(detail + ': panes are kept', panes.length > 0 && panes.every(m => Fin.partKeep(m).keep === true));
    check(detail + ': glass railing has no bars', meshes(g, m => m.userData.role === 'bar').length === 0);
  }
  const bars = B.build(THREE, {}, { detail: 'full' });
  check('bars railing has no glass', meshes(bars, m => m.userData.role === 'glass').length === 0);
  const rails = byName(bars, 'front-bars');
  check('bars are metal in railColor', rails.material.userData.finish === 'metal' &&
    rails.material.color.getHex() === parseInt(B.DEFAULTS.railColor.slice(1), 16));
}

// ---- 6. triangle caps -------------------------------------------------------------
{
  for (const [tag, p] of [['bars', {}], ['glass', { railing: 'glass' }], ['decking', { floor: 'decking' }], ['slab', { floor: 'slab' }]]) {
    const tf = triangles(B.build(THREE, p, { detail: 'full' }));
    const tl = triangles(B.build(THREE, p, { detail: 'low' }));
    // PERF-BUDGET AMENDMENT: 1500 / 450 is above the furniture audit's
    // 600 / 200 default for an unlisted type, on purpose -- a balcony is
    // architecture, there is one per house, and ~78 balusters are what a
    // bar railing is. Recorded in plan ad7a5b22 / review c69e6c5d.
    // Mutation: BAR drawn as a 12-segment cylinder, or low keeping all bars -> fails.
    check(tag + ': full <= 1500 triangles', tf <= 1500, tf);
    check(tag + ': low <= 450 triangles', tl <= 450, tl);
    check(tag + ': low <= 0.6 x full', tl <= 0.6 * tf, { tf, tl });
    console.log('balcony ' + tag + ': full ' + tf + ' / low ' + tl + ' triangles');
  }
  const lights = [];
  B.build(THREE, {}, { detail: 'full' }).traverse(o => { if (o.isLight) lights.push(o.type); });
  check('no lights', lights.length === 0, lights);
}

// ---- 7. decking floor (an option since the grating became the default) -----------
{
  const P = B.DEFAULTS;
  const DK = { floor: 'decking' };
  const g = B.build(THREE, DK, { detail: 'full' });
  const deck = byName(g, 'deck-boards');
  check('decking: a deck-boards mesh', !!deck);
  const boardsZ = deck ? boxIntervalsAlong(deck, 'z') : [];
  const boardsX = deck ? boxIntervalsAlong(deck, 'x') : [];
  // Mutation: boardSpans rounding to a single board, or the boards built as
  // one slab -> fails (155 deep / ~15 per board is about ten).
  check('decking: about depth / (boardWidth + gap) boards', boardsZ.length >= 9 && boardsZ.length <= 11 &&
    deck.userData.boards === boardsZ.length, boardsZ.length);
  // Mutation: boards laid along z (box(z0, z1, ..., -D/2, D/2)) -> each
  // board is then narrow in x and long in z -> fails. Boards run PARALLEL
  // to the facade.
  check('decking: every board runs the full width along x (parallel to the facade)',
    boardsX.length > 0 && boardsX.every(([lo, hi]) => hi - lo >= P.width - 2 * 1 - 0.5), boardsX.slice(0, 2));
  check('decking: every board is about boardWidth across (z)',
    boardsZ.every(([lo, hi]) => Math.abs(hi - lo - P.boardWidth) <= 1.5), boardsZ.slice(0, 2));
  // Mutation: boardGap ignored (gap 0) -> fails.
  let minGap = Infinity, maxGap = 0;
  for (let i = 1; i < boardsZ.length; i++) {
    const d = boardsZ[i][0] - boardsZ[i - 1][1];
    minGap = Math.min(minGap, d); maxGap = Math.max(maxGap, d);
  }
  check('decking: real gaps between boards, about boardGap', Math.abs(minGap - P.boardGap) <= 0.05 && Math.abs(maxGap - P.boardGap) <= 0.05, { minGap, maxGap });
  const db = deck && bboxCm(deck);
  // Mutation: boards y range slabT .. slabT + bt -> the deck top rises -> fails.
  check('decking: deck top is at slabThickness (level with the threshold)', !!db && Math.abs(db.maxY - P.slabThickness) <= 0.05, db);
  check('decking: boards stop short of the front trim', !!db && db.maxZ < P.depth - 0.5 && db.minZ >= -0.01, db);
  check('decking: boards are matte in deckColor', !!deck && deck.material.userData.finish === 'matte' &&
    deck.material.color.getHex() === parseInt(P.deckColor.slice(1), 16));
  // Mutation: drop the deck keep line -> fails (a finish-bucket merge would
  // strip the groove map in the browser).
  check('decking: boards are kept', !!deck && Fin.partKeep(deck).keep === true);
  const slab = bboxCm(byName(g, 'slab'));
  check('decking: the structure sits below the boards', slab.maxY < P.slabThickness - 1 && Math.abs(slab.minY) <= 0.05, slab);
  const trim = byName(g, 'edge-trim');
  const tb = trim && bboxCm(trim);
  // Mutation: trim in mats.slab -> finish fails; trim front at D - 1 -> z fails.
  check('decking: dark metal edge trim at the front and both ends', !!trim && trim.material.userData.finish === 'metal' &&
    Math.abs(tb.maxZ - P.depth) <= 0.05 && Math.abs(tb.maxX - tb.minX - P.width) <= 0.05 && Math.abs(tb.maxY - P.slabThickness) <= 0.05, tb);
  check('decking: three trim boxes', !!trim && boxIntervalsX(trim).length === 3);

  // floor 'slab' is the old look.
  const s = B.build(THREE, { floor: 'slab' }, { detail: 'full' });
  check("floor 'slab': no boards, no trim", !byName(s, 'deck-boards') && !byName(s, 'edge-trim'));
  const ss = byName(s, 'slab');
  check("floor 'slab': slab in slabColor up to slabThickness", ss.material.color.getHex() === parseInt(P.slabColor.slice(1), 16) &&
    Math.abs(bboxCm(ss).maxY - P.slabThickness) <= 0.05);

  // Low detail: one charcoal slab box, no boards (the triangle cap holds).
  const l = B.build(THREE, DK, { detail: 'low' });
  const ls = byName(l, 'slab');
  // Mutation: low using DECK_UNDER or slabColor -> fails.
  check('decking low: no boards, slab in deckColor to the deck top', !byName(l, 'deck-boards') &&
    ls.material.color.getHex() === parseInt(P.deckColor.slice(1), 16) && Math.abs(bboxCm(ls).maxY - P.slabThickness) <= 0.05);

  // The placement's 11 cm slab keeps the deck top at 11.
  const h = byName(B.build(THREE, { floor: 'decking', slabThickness: 11 }, { detail: 'full' }), 'deck-boards');
  check('decking: slabThickness 11 -> deck top 11', Math.abs(bboxCm(h).maxY - 11) <= 0.05, bboxCm(h));
}

// ---- 8. grating floor (the default) --------------------------------------------------
{
  const P = B.DEFAULTS;
  // Mutation: DEFAULTS floor back to 'decking' -> fails.
  check("DEFAULTS floor is 'grating'", P.floor === 'grating');
  const g = B.build(THREE, {}, { detail: 'full' });
  const gr = byName(g, 'grating');
  check('grating: a grating mesh', !!gr);
  // Two planes (top and bottom of the bars), 2 triangles each: one draw.
  check('grating: 4 triangles (two textured planes)', !!gr && gr.geometry.index.count / 3 === 4, gr && gr.geometry.index.count);
  const m = gr ? gr.material : {};
  // Mutation: makeFinish(THREE, 'metal', ...) for the grating -> fails (the
  // live scene has no env map; the owner's note asks for satin, not metal).
  check('grating: satin, not metal, in gratingColor', m.userData && m.userData.finish === 'satin' && m.metalness === 0 &&
    m.color.getHex() === parseInt(P.gratingColor.slice(1), 16), m.userData);
  // Mutation: drop `gm.alphaTest = ...` -> the holes draw solid -> fails.
  check('grating: alpha-cutout (map + alphaTest)', !!m.map && m.alphaTest > 0 && m.alphaTest < 1 && m.transparent !== true, { a: m.alphaTest });
  // Mutation: drop `gm.side = DoubleSide` -> invisible from below -> fails.
  check('grating: double-sided', m.side === THREE.DoubleSide);
  // Mutation: drop the grating keep line -> fails.
  check('grating: kept', !!gr && Fin.partKeep(gr).keep === true);

  // The tile: real holes, and the load bar runs the whole tile along v (z).
  const { levels } = B.gratingTile();
  const L0 = levels[0];
  const alphaAt = (lv, u, v) => lv.data[(v * lv.width + u) * 4 + 3];
  const cover = lv => { let n = 0; for (let i = 3; i < lv.data.length; i += 4) if (lv.data[i] >= B.GRATING_ALPHA_TEST * 255) n++; return n / (lv.width * lv.height); };
  const c0 = cover(L0);
  // Mutation: `bar = u < TILE_U || ...` (no holes) or `u < 0 && v < 0` (no bars) -> fails.
  check('grating tile: mostly open, but with bars (20-40 % metal)', c0 >= 0.2 && c0 <= 0.4, c0);
  let loadBarWhole = true, crossBarWhole = true;
  for (let v = 0; v < L0.height; v++) if (alphaAt(L0, 0, v) !== 255) loadBarWhole = false;
  for (let u = 0; u < L0.width; u++) if (alphaAt(L0, u, 0) !== 255) crossBarWhole = false;
  // Mutation: swap the u and v tests in `bar` -> the bars change axis -> fails.
  check('grating tile: column 0 is a whole load bar (along v) and row 0 a whole cross bar (along u)', loadBarWhole && crossBarWhole);
  // The bar thicknesses in cm: a hole row crosses the load bar (the tile's u
  // spans gratingPitch), a hole column crosses the cross bar (v spans 10 cm).
  // Both are real bar sections, about half a centimetre.
  let rowMetal = 0, colMetal = 0;
  const midV = L0.height >> 1, midU = L0.width >> 1;
  for (let u = 0; u < L0.width; u++) if (alphaAt(L0, u, midV) === 255) rowMetal++;
  for (let v = 0; v < L0.height; v++) if (alphaAt(L0, midU, v) === 255) colMetal++;
  const loadCm = rowMetal / L0.width * P.gratingPitch, crossCm = colMetal / L0.height * 10;
  // Mutation: swap the u and v tests in `bar` (load 2 px of 16, cross 3 of
  // 32) -> 0.38 / 0.94 cm -> fails.
  check('grating tile: load bar ~0.56 cm, cross bar ~0.63 cm', loadCm >= 0.45 && loadCm <= 0.7 && crossCm >= 0.5 && crossCm <= 0.75, { loadCm, crossCm });
  check('grating tile: power-of-two, a full mip chain to 1x1', L0.width === 16 && L0.height === 32 &&
    levels[levels.length - 1].width === 1 && levels[levels.length - 1].height === 1 && m.map && m.map.mipmaps.length === levels.length &&
    m.map.generateMipmaps === false, levels.map(l => l.width + 'x' + l.height));
  // Mutation: average the alpha instead of max -> coverage falls with each
  // level and the 1x1 mip is below the alpha test (the floor VANISHES at a
  // distance) -> fails.
  let monotone = true;
  for (let i = 1; i < levels.length; i++) if (cover(levels[i]) < cover(levels[i - 1]) - 1e-9) monotone = false;
  check('grating mips: coverage never drops with distance, and the 1x1 mip is solid', monotone && cover(levels[levels.length - 1]) === 1,
    levels.map(cover));

  // The uvs: one tile per gratingPitch along x, one per 10 cm along z.
  const uvPitch = (grp, name) => {
    const mesh = byName(grp, name);
    const pos = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      x0 = Math.min(x0, pos.getX(i)); x1 = Math.max(x1, pos.getX(i)); z0 = Math.min(z0, pos.getZ(i)); z1 = Math.max(z1, pos.getZ(i));
      u0 = Math.min(u0, uv.getX(i)); u1 = Math.max(u1, uv.getX(i)); v0 = Math.min(v0, uv.getY(i)); v1 = Math.max(v1, uv.getY(i));
    }
    return { alongX: (x1 - x0) * 100 / (u1 - u0), alongZ: (z1 - z0) * 100 / (v1 - v0) };
  };
  const up = uvPitch(g, 'grating');
  // Mutation: u computed with CROSS_PITCH (or v with pitchCm) -> fails.
  check('grating: a load bar every gratingPitch along x, a cross bar every 10 cm along z',
    Math.abs(up.alongX - P.gratingPitch) <= 1e-3 && Math.abs(up.alongZ - 10) <= 1e-3, up);
  const up5 = uvPitch(B.build(THREE, { gratingPitch: 5 }, { detail: 'full' }), 'grating');
  // Mutation: gratingPitch ignored (DEFAULTS.gratingPitch used) -> fails.
  check('grating: gratingPitch 5 -> a load bar every 5 cm', Math.abs(up5.alongX - 5) <= 1e-3, up5);

  // Height: top at slabThickness (level with the threshold), bottom plane 3 below.
  const gb = gr && bboxCm(gr);
  // Mutation: yTop = (slabT + 1) -> fails.
  check('grating: top at slabThickness, bars 3 deep', !!gb && Math.abs(gb.maxY - P.slabThickness) <= 0.05 &&
    Math.abs(gb.maxY - gb.minY - 3) <= 0.05, gb);
  const g11 = bboxCm(byName(B.build(THREE, { slabThickness: 11 }, { detail: 'full' }), 'grating'));
  check('grating: slabThickness 11 -> top 11', Math.abs(g11.maxY - 11) <= 0.05, g11);

  // The frame: metal, round all four edges, slab bottom to deck top.
  const fr = byName(g, 'grating-frame');
  const fb = fr && bboxCm(fr);
  // Mutation: frame in mats.slab -> finish fails.
  check('grating: a metal frame in railColor, full width x depth, 0 .. slabThickness', !!fr &&
    fr.material.userData.finish === 'metal' && fr.material.color.getHex() === parseInt(P.railColor.slice(1), 16) &&
    Math.abs(fb.maxX - fb.minX - P.width) <= 0.05 && Math.abs(fb.minZ) <= 0.05 && Math.abs(fb.maxZ - P.depth) <= 0.05 &&
    Math.abs(fb.minY) <= 0.05 && Math.abs(fb.maxY - P.slabThickness) <= 0.05, fb);
  // Mutation: drop the back member -> 4 boxes -> fails.
  check('grating: frame is five boxes (front, back, two ends, a mid beam)', !!fr && boxIntervalsX(fr).length === 5);
  // The grating meets the frame's inner edges exactly: no gap, no overlap.
  // Mutation: grating x0 = -W/2 (overlapping the end frame) -> fails.
  check('grating: fills the frame edge to edge (4 cm frame)', !!gb && Math.abs(gb.minX + P.width / 2 - 4) <= 0.05 &&
    Math.abs(P.width / 2 - gb.maxX - 4) <= 0.05 && Math.abs(gb.minZ - 4) <= 0.05 && Math.abs(P.depth - gb.maxZ - 4) <= 0.05, gb);
  // See-through: nothing solid under the grating but the frame.
  // Mutation: also adding the solid slab box under the grating -> fails.
  check('grating: no solid slab under it (you can see through)', !byName(g, 'slab'), meshes(g).map(o => o.name));
  // The mid beam stays below the bars' bottom plane (no coplanar faces).
  const beam = boxIntervalsAlong(fr, 'z').filter(([lo, hi]) => lo > 10 && hi < P.depth - 10);
  check('grating: one mid beam, inside the depth', beam.length === 1, beam);

  // Low detail: one gratingColor slab box, satin.
  const l = B.build(THREE, {}, { detail: 'low' });
  const ls = byName(l, 'slab');
  // Mutation: low using slabColor -> fails.
  check('grating low: no grating, one satin gratingColor slab to the deck top', !byName(l, 'grating') && !byName(l, 'grating-frame') &&
    ls.material.userData.finish === 'satin' && ls.material.color.getHex() === parseInt(P.gratingColor.slice(1), 16) &&
    Math.abs(bboxCm(ls).maxY - P.slabThickness) <= 0.05);

  // The renderer's merge keeps it as a textured part WITH its uvs (a merge
  // into the vertex-coloured palette bucket would lose the cutout).
  const Merge = await imp('src/furniture/merge.js');
  const flat = Merge.flattenGroup(THREE, B.build(THREE, {}, { detail: 'full' }));
  const gp = flat.parts.filter(pt => pt.material && pt.material.alphaTest > 0);
  check('grating: survives the merge as a kept, textured part with uvs', gp.length === 1 && Merge.bucketClass(gp[0]) === 'kept' &&
    gp[0].textured && !!gp[0].geometry.attributes.uv, gp.map(pt => ({ keep: pt.keep, textured: pt.textured })));

  // An unknown floor value falls back to the default, not to the old slab.
  check("unknown floor -> grating", !!byName(B.build(THREE, { floor: 'lava' }, { detail: 'full' }), 'grating'));
}

// ---- toFurnitureJSON ----------------------------------------------------------------
{
  const j = B.toFurnitureJSON(Object.assign({}, B.DEFAULTS, { railing: 'glass', leftSide: 'solid' }));
  check('toFurnitureJSON: only non-default keys', j.type === 'balcony' &&
    JSON.stringify(j.params) === JSON.stringify({ railing: 'glass', leftSide: 'solid' }), j);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
