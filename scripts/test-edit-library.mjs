#!/usr/bin/env node
/**
 * Edit mode's furniture library (plan B2): src/edit-library.js, the
 * footprint confinement in src/edit-ops.js, and the control filtering in
 * src/furniture/controls.js. No framework, no install:
 *   node scripts/test-edit-library.mjs
 *   node scripts/test-edit-library.mjs --write <dir>
 *       also writes an export of the demo house with one of EVERY palette
 *       entry placed in it over the two JSON files in <dir> -- a temp COPY
 *       of houses/demo -- for CI's house-profiles job to run
 *       `validate-house.py --strict` on. <dir> must be outside the repo.
 *
 * WHAT THIS GUARDS
 *   1. The palette is every registered type with a module, except `model`
 *      (it needs a .glb), each with a human label and a known group; every
 *      preset it names exists; search filters it.
 *   2. Every palette entry, placed at its defaults by a tap in a room of the
 *      demo house, lands in THAT room with a unique `<room>_<type>_<n>` id,
 *      compiles, and builds (furniture.js buildFurnitureSync, the same path
 *      the scene uses). A wall type is on a wall of that room, facing into
 *      it, its whole width on the room's stretch of the wall; a floor type
 *      stands on the floor with its whole footprint inside the room.
 *   3. A tap outside every room is refused; an item too big for the room is
 *      refused, never placed through a wall.
 *   4. Confinement by FOOTPRINT (B1 review): a drag stops with the rotated
 *      footprint flush to the wall, slides along it, holds in an L-shaped
 *      room; an item authored overhanging may move along or inward but never
 *      further out, and does not jump. A wall item's centre keeps its whole
 *      width on the span.
 *   5. Control filtering: `kinds`, `when`, CONTROL_RULES (no plant "Wall
 *      planter contents" on a floor plant, no LED colour while the LED is
 *      off), every length slider in cm, and every rule names real keys.
 *   6. The export of a placement appends ONE line per new item and leaves
 *      every existing line byte-identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const readRaw = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail).slice(0, 600) : ''));
}
function quietly(fn) {
  const w = console.warn, i = console.info;
  console.warn = () => {}; console.info = () => {};
  try { return fn(); } finally { console.warn = w; console.info = i; }
}

const THREE = await imp('vendor/three-r160/three.module.min.js');
const L = await imp('src/edit-library.js');
const E = await imp('src/edit-ops.js');
const C = await imp('src/furniture/controls.js');
const R = await imp('src/furniture/registry.js');
const F = await imp('src/furniture.js');
const { HouseLoader } = await imp('src/house-loader.js');
const { exportProfile } = await imp('src/profile-export.js');
const { insidePoly } = await imp('src/footstep-walk.js');

const geoText = readRaw('houses/demo/geometry.json');
const roomsText = readRaw('houses/demo/rooms.json');
const fresh = () => JSON.parse(geoText);
const compile = d => quietly(() => HouseLoader.compile(d, 'houses/demo/'));

// Every builder the palette needs, loaded the way the page loads them.
const builders = new Map();
for (const t of new Set(L.LIBRARY.map(x => x.type))) {
  const b = await quietly(() => R.loadBuilder(t, { importer: u => import(u) }));
  if (b) builders.set(t, b);
}
const defaultsOf = (type, params) => {
  const b = builders.get(type);
  return Object.assign({}, typeof b.defaultsFor === 'function' ? b.defaultsFor(params || {}) : b.DEFAULTS, params || {});
};
const paramsOf = x => (x.preset ? Object.assign({}, builders.get(x.type).PRESETS[x.preset]) : {});
const sizeOf = (x, params) => { const v = defaultsOf(x.type, params); return { width: v.width, depth: v.depth }; };

// ---- 1. the palette ----------------------------------------------------------
console.log('1. palette');
{
  const want = Object.keys(R.REGISTRY).filter(t => !L.EXCLUDED_TYPES.includes(t));
  const have = new Set(L.LIBRARY.map(x => x.type));
  check('every registered type except model is in the palette', want.every(t => have.has(t)), want.filter(t => !have.has(t)));
  check('the palette offers nothing unregistered, and never model', [...have].every(t => R.REGISTRY[t]) && !have.has('model'));
  check('model is the one exclusion', JSON.stringify(L.EXCLUDED_TYPES) === '["model"]');
  check('every palette type has a builder that loads', [...have].every(t => builders.has(t)), [...have].filter(t => !builders.has(t)));
  const groups = new Set(L.GROUPS.map(g => g.id));
  L.LIBRARY.forEach(x => {
    check(x.type + ': a known group', groups.has(x.group), x);
    check(x.type + ': a human label (no hyphenated type id)', typeof x.label === 'string' && x.label.length > 1 && !/^[a-z]+-[a-z-]+$/.test(x.label), x.label);
    check(x.type + ': mount is floor or wall', x.mount === 'floor' || x.mount === 'wall', x);
    if (x.preset) check(x.label + ': preset ' + x.preset + ' exists', !!(builders.get(x.type).PRESETS || {})[x.preset]);
  });
  const keys = L.LIBRARY.map(L.entryKey);
  check('entry keys are unique', new Set(keys).size === keys.length);
  const all = L.paletteGroups('');
  check('no query: every entry, in group order', all.reduce((n, g) => n + g.entries.length, 0) === L.LIBRARY.length &&
    JSON.stringify(all.map(g => g.id)) === JSON.stringify(L.GROUPS.map(g => g.id).filter(id => all.some(g => g.id === id))));
  const lamp = L.paletteGroups('lamp').flatMap(g => g.entries.map(x => x.type));
  check('search "lamp" finds the lamps only', lamp.length >= 2 && lamp.includes('tube-floor-lamp') && lamp.includes('wall-sconce') && !lamp.includes('sofa'), lamp);
  const kw = L.paletteGroups('COUCH').flatMap(g => g.entries.map(x => x.type));
  check('search matches keywords, case-insensitively', JSON.stringify(kw) === '["sofa"]', kw);
  check('search: every word must match', L.paletteGroups('wall clock').flatMap(g => g.entries.map(x => x.type)).join() === 'wall-clock');
  check('search with no match: no groups', L.paletteGroups('zzzz').length === 0);
  check('a per-kind mount: a floor-standing speaker stands on the floor', L.mountFor(L.LIBRARY.find(x => x.type === 'speaker'), { kind: 'floor-standing' }).mount === 'floor');
  check('... the default speaker hangs on a wall', L.mountFor(L.LIBRARY.find(x => x.type === 'speaker'), {}).mount === 'wall');
}

// ---- 2/3. placing every entry -----------------------------------------------
console.log('2. every palette entry placed at its defaults');
const demo = fresh();
const house = compile(demo);
const polyOf = (h, id) => h.rooms[id].poly;
// A tap: a floor type in the middle of the room; a wall type 30 cm off the
// middle of the room's north face.
function tapFor(h, room, mount) {
  const r = h.rooms[room];
  const cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
  return mount === 'wall' ? [cx, r.y1 + 30] : [cx, cy];
}
// The biggest demo room takes everything (the balcony is wider than any demo
// room: it goes in the big synthetic room below).
const ROOM = 'bedroom';
let placedDoc = demo;
const placed = [];
for (const x of L.LIBRARY) {
  const params = paramsOf(x);
  const size = sizeOf(x, params);
  const { mount } = L.mountFor(x, params);
  const res = L.placeNew({ doc: placedDoc, compiled: house, entry: x, room: ROOM, point: tapFor(house, ROOM, mount), params, size, label: x.label });
  if (x.type === 'balcony') {
    check('the balcony (547 cm) is refused in a 465 cm room, not pushed through a wall', !!res.error && !res.item, res);
    continue;
  }
  if (res.error) { check(L.entryKey(x) + ': placed', false, res.error); continue; }
  const it = res.item;
  check(L.entryKey(x) + ': lands in the tapped room', it.room === ROOM, it);
  check(L.entryKey(x) + ': id is <room>_<type>_<n> and schema-valid', /^[a-z][a-z0-9_]*$/.test(it.id) && it.id.startsWith(ROOM + '_' + x.type.replace(/-/g, '_') + '_'), it.id);
  check(L.entryKey(x) + ': passes the shape check', E.checkFurnitureItem(it).length === 0, E.checkFurnitureItem(it));
  check(L.entryKey(x) + ': anchor matches its mount', mount === 'wall' ? it.wall != null && it.at == null : Array.isArray(it.at) && it.wall == null, it);
  placedDoc = E.addItem(placedDoc, it);
  placed.push({ x, it, size, mount });
}
const ids = placedDoc.furniture.map(f => f.id);
check('every id in the house is unique after placing them all', new Set(ids).size === ids.length);
check('the same type twice gets _1 then _2', placed.filter(p => p.x.type === 'plant').map(p => p.it.id).slice(0, 2).join() === 'bedroom_plant_1,bedroom_plant_2',
  placed.filter(p => p.x.type === 'plant').map(p => p.it.id));
const h2 = compile(placedDoc);
const S = h2.transform.S, OX = h2.transform.OX, OY = h2.transform.OY;
const tx = v => (v - OX) * S, tz = v => (v - OY) * S;
const quality = { tier: 'ultra', sunShadow: true, roomShadowLights: true };
for (const p of placed) {
  const ci = h2.furniture.find(f => f.id === p.it.id);
  check(p.it.id + ': compiles (the loader did not skip it)', !!ci, h2.warnings.filter(w => w.indexOf(p.it.id) >= 0));
  if (!ci) continue;
  const res = quietly(() => F.buildFurnitureSync(THREE, [ci], builders, { tx, tz, quality, walls: h2.walls }));
  check(p.it.id + ': builds (an entry with a world box, no warning)', res && res.byId[ci.id] && res.byId[ci.id].worldBox && res.warnings.length === 0, res && res.warnings);
  if (res) F.disposeFurniture && F.disposeFurniture(res);
  if (p.mount === 'wall') {
    const wall = h2.wallsById[p.it.wall];
    const horiz = Math.abs(wall.y1 - wall.y2) < Math.abs(wall.x1 - wall.x2);
    const front = [-Math.sin(ci.rotationDeg * Math.PI / 180), Math.cos(ci.rotationDeg * Math.PI / 180)];
    const probe = [ci.x + front[0] * 10, ci.y + front[1] * 10];
    check(p.it.id + ': on a wall of its room, facing into it', ci.hostWallId === p.it.wall && insidePoly(polyOf(h2, ROOM), probe[0], probe[1]), { ci, probe });
    const lo = Math.min(horiz ? wall.x1 : wall.y1, horiz ? wall.x2 : wall.y2), hi = Math.max(horiz ? wall.x1 : wall.y1, horiz ? wall.x2 : wall.y2);
    check(p.it.id + ': its whole width is on the wall', p.it.centre - p.size.width / 2 >= lo - 1e-6 && p.it.centre + p.size.width / 2 <= hi + 1e-6, { centre: p.it.centre, w: p.size.width, lo, hi });
    check(p.it.id + ': elevation is the entry\'s hanging height', (p.it.elevation || 0) === L.mountFor(p.x, paramsOf(p.x)).elevation);
  } else {
    check(p.it.id + ': rotation 0, on the floor (elevation = the entry\'s)', p.it.rotation === 0 && (p.it.elevation || 0) === (p.x.elevation || 0), p.it);
    check(p.it.id + ': its whole footprint is inside the room', E.footprintOverhang(polyOf(h2, ROOM), p.it.at, Object.assign({ rotation: 0 }, p.size)) === 0, { at: p.it.at, size: p.size });
  }
}
check('every palette entry but the balcony was placed in the bedroom', placed.length === L.LIBRARY.length - 1, placed.length);

// The balcony at its defaults, in a room it fits: a big room on the demo's open site.
{
  const d = fresh();
  d.rooms = d.rooms.concat([{ id: 'terrace', label: 'Terrace', polygon: [[0, 760], [900, 760], [900, 1060], [0, 1060]] }]);
  const h = compile(d);
  const x = L.LIBRARY.find(e => e.type === 'balcony');
  const size = sizeOf(x, {});
  const res = L.placeNew({ doc: d, compiled: h, entry: x, room: 'terrace', point: [450, 910], params: {}, size });
  check('the balcony places where it fits', !!res.item && res.item.room === 'terrace' && E.footprintOverhang(h.rooms.terrace.poly, res.item.at, Object.assign({ rotation: 0 }, size)) === 0, res);
  const h3 = compile(E.addItem(d, res.item));
  const ci = h3.furniture.find(f => f.id === res.item.id);
  const built = ci && quietly(() => F.buildFurnitureSync(THREE, [ci], builders, { tx, tz, quality, walls: h3.walls }));
  check('... and builds', !!(built && built.byId[ci.id]), built && built.warnings);
}

console.log('3. refusals and nudges');
{
  const x = L.LIBRARY.find(e => e.type === 'sofa');
  const r0 = L.placeNew({ doc: demo, compiled: house, entry: x, room: null, point: [-500, -500], params: {}, size: sizeOf(x, {}) });
  check('a tap outside every room is refused', !!r0.error && !r0.item);
  check('roomAtPoint: outside -> null, inside -> the room', L.roomAtPoint(house, [-500, -500]) === null && L.roomAtPoint(house, [600, 500]) === 'bedroom');
  // A tap right by a wall: the footprint is pulled in, not left through the wall.
  const size = sizeOf(x, {});
  const r1 = L.placeNew({ doc: demo, compiled: house, entry: x, room: ROOM, point: [430, 395], params: {}, size });
  check('a floor item tapped in a corner is pulled inside the room', !!r1.item && E.footprintOverhang(polyOf(house, ROOM), r1.item.at, Object.assign({ rotation: 0 }, size)) === 0, r1);
  check('... as near the tap as it fits (flush to both walls)', r1.item && Math.abs(r1.item.at[0] - (425 + size.width / 2)) <= 5 && Math.abs(r1.item.at[1] - (385 + size.depth / 2)) <= 5, r1.item && r1.item.at);
  const tv = L.LIBRARY.find(e => e.type === 'tv');
  const r2 = L.placeNew({ doc: demo, compiled: house, entry: tv, room: ROOM, point: [430, 395], params: {}, size: sizeOf(tv, {}) });
  const w2 = r2.item && house.wallsById[r2.item.wall];
  check('a wall item tapped by a corner snaps to the nearer wall', !!w2, r2);
  const r3 = L.placeNew({ doc: demo, compiled: house, entry: tv, room: ROOM, point: [600, 395], params: {}, size: { width: 2000, depth: 5 } });
  check('a wall item wider than every wall of the room is refused', !!r3.error, r3);
  check('newItemId sanitises odd room and type ids', E.newItemId({ furniture: [] }, 'Living-Room', 'tube-floor-lamp') === 'living_room_tube_floor_lamp_1');
  check('newItemId skips taken numbers', E.newItemId({ furniture: [{ id: 'a_box_1' }, { id: 'a_box_2' }] }, 'a', 'box') === 'a_box_3');
  let threw = false; try { E.addItem(demo, demo.furniture[0]); } catch (e) { threw = true; }
  check('addItem refuses a duplicate id', threw);
  threw = false; try { E.addItem(demo, { id: 'x', room: 'bedroom', type: 'box' }); } catch (e) { threw = true; }
  check('addItem refuses an item with no anchor', threw);
  const before = JSON.stringify(demo);
  const added = E.addItem(demo, { id: 'bedroom_box_9', room: 'bedroom', type: 'box', at: [600, 500], rotation: 0 });
  check('addItem appends at the end and never mutates its input', JSON.stringify(demo) === before && added.furniture.length === demo.furniture.length + 1 &&
    added.furniture[added.furniture.length - 1].id === 'bedroom_box_9' && demo.furniture.every((f, k) => added.furniture[k] === f));
}

// ---- 4. footprint confinement ------------------------------------------------
console.log('4. confinement by footprint');
{
  const sq = [[0, 0], [400, 0], [400, 300], [0, 300]];
  const sz = { width: 100, depth: 60, rotation: 0 };
  let p = E.confineFootprint(sq, [200, 150], [900, 150], sz);
  check('a drag into a wall stops with the footprint flush to it (not the centre)', p[0] >= 349 && p[0] <= 350 && p[1] === 150, p);
  check('... and the result is inside', E.footprintOverhang(sq, p, sz) === 0);
  p = E.confineFootprint(sq, [200, 150], [900, 200], sz);
  check('a diagonal drag into a wall slides along it', p[0] >= 349 && p[0] <= 350 && p[1] === 200, p);
  p = E.confineFootprint(sq, [200, 150], [900, 150], { width: 100, depth: 60, rotation: 90 });
  check('rotated 90: the DEPTH now runs along x (stops at 370)', p[0] >= 369 && p[0] <= 370, p);
  p = E.confineFootprint(sq, [200, 150], [300, 100], sz);
  check('a move that stays inside is untouched', p[0] === 300 && p[1] === 100, p);
  // L-shaped room (the demo study's shape).
  const L_ = [[565, 10], [890, 10], [890, 275], [700, 275], [700, 180], [565, 180]];
  const s2 = { width: 60, depth: 60, rotation: 0 };
  p = E.confineFootprint(L_, [800, 100], [620, 240], s2);
  check('L-shaped room: the footprint never crosses the inner corner', E.footprintOverhang(L_, p, s2) === 0, p);
  // Authored overhanging (a deck over the room edge): 50 cm out of the east side.
  const over = [380, 150];
  const o0 = E.footprintOverhang(sq, over, sz);
  check('(fixture) the item really overhangs', o0 > 0);
  p = E.confineFootprint(sq, over, [380, 100], sz);
  check('an overhanging item slides along the edge (same overhang)', p[0] === 380 && p[1] === 100, p);
  p = E.confineFootprint(sq, over, [300, 150], sz);
  check('... and may be pulled in', p[0] === 300 && p[1] === 150, p);
  p = E.confineFootprint(sq, over, [450, 150], sz);
  check('... but never pushed further out (and does not jump)', p[0] === 380 && p[1] === 150, p);
  check('with no size it is the old centre-only rule', JSON.stringify(E.confineFootprint(sq, [200, 150], [900, 150])) ===
    JSON.stringify(E.confineToPoly(sq, [200, 150], [900, 150])));
  // Sampling the edges, not only the corners: a thin item across the L's notch.
  check('edge samples catch an inner corner between two inside corners',
    E.footprintOverhang(L_, [650, 200], { width: 20, depth: 200, rotation: 90 }) > 0);
  // nearestFit
  const f = E.nearestFit(sq, [395, 295], sz, 1);
  check('nearestFit: the nearest centre where it fits', f && f[0] === 350 && f[1] === 270, f);
  check('nearestFit: null when it fits nowhere', E.nearestFit(sq, [200, 150], { width: 500, depth: 60, rotation: 0 }) === null);
  // wall items
  const span = { lo: 100, hi: 500, axis: 'x' };
  let r = E.wallCentreRange(span, 120);
  check('wall item: centre range keeps the whole width on the span', r.lo === 160 && r.hi === 440, r);
  r = E.wallCentreRange(span, 120, 470);
  check('wall item authored past the end: the range reaches its own centre (no jump)', r.lo === 160 && r.hi === 470, r);
  r = E.wallCentreRange(span, 600);
  check('wall item wider than the span: its middle', r.lo === 300 && r.hi === 300, r);
}

// ---- 5. control filtering ------------------------------------------------------
console.log('5. control filtering');
{
  const ctl = (type, params) => {
    const b = builders.get(type);
    const defaults = typeof b.defaultsFor === 'function' ? b.defaultsFor(params || {}) : b.DEFAULTS;
    const all = C.controlsFor(type, defaults, b.CONTROLS, b.CONTROL_RULES);
    return { all, vis: C.visibleControls(all, Object.assign({}, defaults, params || {})).map(c => c.key) };
  };
  let v = ctl('plant', { kind: 'corn-plant' }).vis;
  check('floor plant: no wall-planter contents, no wire frame', !v.includes('contents') && !v.includes('frameColor'), v);
  check('floor plant: no trail unless a trailing pothos', !v.includes('trail') && !v.includes('habit'), v);
  check('floor plant: pot controls shown', v.includes('potStyle') && v.includes('potHeight'), v);
  check('floor plant: fewer than the 21 controls B1 drew', v.length < 21, v.length);
  v = ctl('plant', { kind: 'wall-planter' }).vis;
  check('wall planter: contents and frame shown, pot style hidden', v.includes('contents') && v.includes('frameColor') && !v.includes('potStyle'), v);
  check('trailing pothos: trail shown', ctl('plant', { kind: 'pothos', habit: 'trailing' }).vis.includes('trail'));
  check('upright pothos: trail hidden, habit shown', !ctl('plant', { kind: 'pothos', habit: 'upright' }).vis.includes('trail') && ctl('plant', { kind: 'pothos', habit: 'upright' }).vis.includes('habit'));
  check('glass tint only on a glass pot', ctl('plant', { kind: 'peace-lily', potStyle: 'glass-bubble' }).vis.includes('glassColor') && !ctl('plant', { kind: 'ficus', potStyle: 'bowl' }).vis.includes('glassColor'));
  check('seed relabelled', ctl('plant', {}).all.find(c => c.key === 'seed').label !== 'Seed');
  check('desk: LED colour hidden while the strip is off', !ctl('standing-desk', { ledStrip: false }).vis.includes('ledColor') && ctl('standing-desk', { ledStrip: true }).vis.includes('ledColor'));
  check('shelf: LED colour follows led', !ctl('shelf', { led: false }).vis.includes('ledColor') && ctl('shelf', { led: true }).vis.includes('ledColor'));
  check('tv: stand sizes follow stand', !ctl('tv', { stand: false }).vis.includes('standHeight') && ctl('tv', { stand: true }).vis.includes('standHeight'));
  const gain = ctl('cabinet', {}).all.find(c => c.key === 'gain');
  check('cabinet gain: a readable label and a fine step, not 0..2 step 1', gain.label !== 'Gain' && gain.step < 1 && gain.min > 0, gain);
  check('the derived TV width rounds to sensible bounds', (() => { const w = ctl('tv', {}).all.find(c => c.key === 'width'); return w.min === 80 && w.max === 340 && w.unit === 'cm'; })(),
    ctl('tv', {}).all.find(c => c.key === 'width'));
  check('visibleControls drops unsupported', C.visibleControls([{ key: 'a', kind: 'unsupported' }, { key: 'b', kind: 'toggle' }], {}).map(c => c.key).join() === 'b');
  check('when: a list of values', C.visibleControls([{ key: 'a', kind: 'toggle', when: { m: ['x', 'y'] } }], { m: 'y' }).length === 1 &&
    C.visibleControls([{ key: 'a', kind: 'toggle', when: { m: ['x', 'y'] } }], { m: 'z' }).length === 0);
  check('isLengthKey: lengths yes; counts, angles, seeds, gains no', C.isLengthKey('width') && C.isLengthKey('potTopDiameter') && C.isLengthKey('frameWidth') &&
    !C.isLengthKey('leafCount') && !C.isLengthKey('reclineDeg') && !C.isLengthKey('seed') && !C.isLengthKey('gain'));
  check('controlsFor RULES patch in place (order kept)', (() => {
    const out = C.controlsFor('t', { a: 1, b: true, c: '#ffffff' }, null, { c: { when: { b: true } } });
    return out.map(x => x.key).join() === 'a,b,c' && out[2].when.b === true && out[2].kind === 'color';
  })());
  // Every type: rules and kinds name real keys and values; ranges hold their defaults; lengths say cm.
  for (const [type, b] of builders) {
    const defaults = b.DEFAULTS;
    const all = C.controlsFor(type, defaults, b.CONTROLS, b.CONTROL_RULES);
    const kindSel = all.find(c => c.key === 'kind' && c.kind === 'select');
    const kindVals = kindSel ? kindSel.options.map(C.optionValue) : [];
    Object.keys(b.CONTROL_RULES || {}).forEach(k => check(type + ': rule key ' + k + ' is a DEFAULTS key', Object.prototype.hasOwnProperty.call(defaults, k)));
    all.forEach(c => {
      if (c.when) Object.keys(c.when).forEach(k => check(type + '.' + c.key + ': when names a DEFAULTS key (' + k + ')', Object.prototype.hasOwnProperty.call(defaults, k)));
      if (c.kinds) check(type + '.' + c.key + ': kinds are real kinds', c.kinds.every(k => kindVals.includes(k)), c.kinds);
      if (c.kind === 'range') {
        check(type + '.' + c.key + ': min <= default <= max', c.min <= defaults[c.key] && defaults[c.key] <= c.max && c.step > 0, c);
        if (C.isLengthKey(c.key)) check(type + '.' + c.key + ': a length says cm', c.unit === 'cm', c);
      }
    });
  }
}

// ---- 6. the export -------------------------------------------------------------
console.log('6. export');
{
  const served = { geometryText: geoText, roomsText };
  const out = exportProfile(served, { geometry: placedDoc, rooms: JSON.parse(roomsText) });
  const a = geoText.replace(/\r\n/g, '\n').split('\n'), b = out.geometry.replace(/\r\n/g, '\n').split('\n');
  const added = b.length - a.length;
  check('one new line per placed item', added === placed.length, { added, placed: placed.length });
  const fEnd = a.findIndex((l, k) => k > a.findIndex(x => /"furniture": \[/.test(x)) && /^ {2}\],?$/.test(l));
  check('every line before the last furniture item is byte-identical', a.slice(0, fEnd - 1).every((l, k) => b[k] === l));
  check('every line after the furniture array is byte-identical', a.slice(fEnd).every((l, k) => b[fEnd + added + k] === l));
  const news = b.slice(fEnd, fEnd + added);
  check('each new item is one line: { "id": ... }', news.every(l => /^ {4}\{ "id": "bedroom_[a-z0-9_]+", .* \},?$/.test(l)), news.slice(0, 3));
  check('the export parses back to the placed document', JSON.stringify(JSON.parse(out.geometry).furniture) === JSON.stringify(placedDoc.furniture));
  check('rooms.json is untouched (byte-identical)', out.rooms === roomsText);
  const wi = process.argv.indexOf('--write');
  if (wi > 0) {
    const dir = path.resolve(process.argv[wi + 1] || '');
    if (!process.argv[wi + 1] || dir.startsWith(root + path.sep) || dir === root) {
      console.error('--write <dir>: a directory OUTSIDE the repo is required');
      process.exit(2);
    }
    fs.writeFileSync(path.join(dir, 'geometry.json'), out.geometry);
    fs.writeFileSync(path.join(dir, 'rooms.json'), out.rooms);
    console.log('wrote an export with ' + placed.length + ' placed items to ' + dir);
  }
}

console.log((failures ? 'FAILED' : 'ok') + ' - ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
