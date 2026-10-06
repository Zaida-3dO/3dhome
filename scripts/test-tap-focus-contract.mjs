#!/usr/bin/env node
/**
 * THE TAP FOCUS CONTRACT: every tap on interactive furniture flies the camera
 * to the item FIRST and only then opens its dialog -- and nobody can forget
 * it. There is no build step, so "compile time" is this test in CI.
 * No framework, no install -- `node scripts/test-tap-focus-contract.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. ROUTES: every route in the real table (src/tap-popovers.js
 *      buildTapRoutes) focuses, unless its kind is a DECLARED opt-out; the
 *      opt-out list is pinned here verbatim, so a new one is a visible diff.
 *      Every kind a target builder can emit has a route.
 *   2. STATIC GUARD: nothing in src/ or index.html opens a card or the sound
 *      menu except the route table (TAP-ROUTES block) or a line marked
 *      TAP-OPEN-ALLOWED (the ?debug=1 seam); the tap handler calls the
 *      dispatcher and nothing else that opens UI; only the dispatcher calls
 *      the page's focus.
 *   3. BEHAVIOUR: for every interactive thing in the demo house, a tap built
 *      by the real target builders and dispatched through the real routes
 *      produces the flight, then the open -- never the open before the
 *      flight lands; a newer tap supersedes an older one in the air.
 *   4. NO PER-TYPE CODE: a new route kind, a new sensors.items entry and a
 *      new soundMenu.openFrom entry all fly with nothing written for them;
 *      an undeclared opt-out throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
// Source with its whole-line comments dropped (a doc comment naming a call is not a call).
const isComment = l => /^\s*(\/\/|\*|\/\*)/.test(l);
const codeOnly = src => src.split('\n').filter(l => !isComment(l)).join('\n');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}

const T = await imp('src/tap-popovers.js');
const D = await imp('src/tap-dispatch.js');
const F = await imp('src/camera-focus.js');
const { normaliseVacuumBindings } = await imp('src/vacuum-control.js');
const { normalisePlantBindings } = await imp('src/plant-status.js');
const { normaliseItemBindings, tappableFurnitureIds } = await imp('src/item-cards.js');
const { normaliseSoundMenu } = await imp('src/sound-model.js');

// The pinned opt-out list. Changing it is a product decision: edit both.
const EXPECTED_OPT_OUTS = ['door'];

// A recording harness round the REAL route table.
function harness(o) {
  const log = [];
  const soundMenu = (o && o.noSound) ? null : {
    open: a => log.push('open:soundMenu:' + a.itemId),
    coverRight: () => (o && o.cover) || 0,
  };
  const routes = T.buildTapRoutes({
    openCard: t => log.push('open:' + t.kind + ':' + t.id),
    project: () => ({ x: 1, y: 2 }),
    closeCard: () => {},
    soundMenu,
    onClose: () => {},
  });
  const pending = [];
  const frames = [];
  const focus = (t, point, frame) => {
    log.push('fly:' + t.kind + ':' + t.id);
    frames.push(frame);
    let res; const p = new Promise(r => { res = r; });
    pending.push(res);
    return p;
  };
  const gate = F.createFocusGate();
  const abandoned = [];
  const disp = D.createTapDispatcher({ routes, gate, focus: o && o.focusOff ? () => null : focus, onAbandon: t => abandoned.push(t.id) });
  const land = async () => { while (pending.length) pending.shift()('landed'); await new Promise(r => setTimeout(r, 0)); };
  return { log, disp, routes, land, frames, abandoned, gate };
}
const tick = () => new Promise(r => setTimeout(r, 0));

// ---- 1. routes ---------------------------------------------------------------
console.log('routes');
{
  const { routes } = harness();
  const kinds = [...routes.keys()];
  check('the declared opt-outs are exactly ' + EXPECTED_OPT_OUTS.join(', '),
    JSON.stringify(Object.keys(D.FOCUS_OPT_OUTS).sort()) === JSON.stringify(EXPECTED_OPT_OUTS.slice().sort()), Object.keys(D.FOCUS_OPT_OUTS));
  check('every opt-out carries a reason', Object.values(D.FOCUS_OPT_OUTS).every(r => typeof r === 'string' && r.length > 20));
  kinds.forEach(k => {
    const r = routes.get(k);
    check('route ' + k + ': ' + (r.focus ? 'flies before it opens' : 'declared opt-out (' + (r.reason || '').slice(0, 40) + '...)'),
      r.focus === true || (EXPECTED_OPT_OUTS.includes(k) && r.reason === D.FOCUS_OPT_OUTS[k]), { focus: r.focus, reason: r.reason });
  });
  check('the sound menu is a FOCUSING route (the Nest speakers fly in)', routes.get('soundMenu') && routes.get('soundMenu').focus === true);
  // Every kind literal a target builder emits must have a route: a builder
  // emitting a kind with no route would make that thing silently untappable.
  const builders = read('src/tap-popovers.js').split('export function attachTapPopovers')[0] + read('src/item-cards.js');
  const emitted = new Set([...builders.matchAll(/\{ kind: '([A-Za-z]+)'/g)].map(m => m[1]));
  check('the target builders emit at least light, door, curtain, vacuum, plant, soundMenu, item, clock, climate',
    ['light', 'door', 'curtain', 'vacuum', 'plant', 'soundMenu', 'item', 'clock', 'climate'].every(k => emitted.has(k)), [...emitted]);
  emitted.forEach(k => check('emitted kind ' + k + ' has a route', routes.has(k)));
}

// ---- 2. static guard ----------------------------------------------------------
console.log('static guard');
{
  const files = [];
  const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).forEach(e => {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel); else if (e.name.endsWith('.js')) files.push(rel);
  });
  walk('src');
  files.push('index.html');
  // Calls that OPEN tap UI: the popover's card opener, the sound menu's open
  // (by any receiver name ending in soundMenu / Sound), the debug seam.
  const OPENERS = [
    /\bopenCard\(/,
    /\b\w*[sS]ound(Menu)?\.open\(/,
    /\.openAt\(/,
    /\bshowCard\(/,
    /\bopenSoundMenu\(/,
  ];
  const offenders = [];
  let allowedSeen = 0, inRoutes = 0;
  files.forEach(f => {
    const lines = read(f).split('\n');
    let inBlock = false;
    lines.forEach((ln, i) => {
      if (/TAP-ROUTES:BEGIN/.test(ln)) inBlock = true;
      if (/TAP-ROUTES:END/.test(ln)) inBlock = false;
      if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;                 // comments
      if (/function openCard\(/.test(ln)) return;                  // its definition
      if (!OPENERS.some(re => re.test(ln))) return;
      if (inBlock) { inRoutes++; return; }
      if (i > 0 && /TAP-OPEN-ALLOWED:/.test(lines[i - 1])) { allowedSeen++; return; }
      offenders.push(f + ':' + (i + 1) + ': ' + ln.trim());
    });
  });
  check('no card / sound-menu opener outside the route table (or a marked debug seam)', offenders.length === 0, offenders);
  check('the route table does open things (the scan sees it)', inRoutes >= 3, inRoutes);
  check('the marked exceptions are the two ?debug=1 openAt lines and handing the opener to the route table', allowedSeen === 3, allowedSeen);
  const tp = read('src/tap-popovers.js');
  const body = tp.slice(tp.indexOf('const onClick = e => {'), tp.indexOf('// The client-pixel position of a world point'));
  check('the tap handler dispatches', /tapDispatch\.dispatch\(res\.target, res\.point,/.test(body));
  check('the tap handler opens nothing itself and never calls focus', !/openCard\(|soundMenu|\.open\(|o\.focus\(/.test(body), body.length);
  const code = codeOnly(tp);
  check('only the dispatcher is handed the page\'s focus', (code.match(/o\.focus\b/g) || []).length === 2 &&
    /focus: typeof o\.focus === 'function' \? o\.focus : null,/.test(tp));
  check('each marked exception is the debug seam (inside api.openAt) or the route table\'s injection', (() => {
    const a = tp.indexOf('openAt(kind, id, x, y, extra) {'), b = tp.indexOf('simulate(spec) {');
    const inj = tp.indexOf('routes: buildTapRoutes({');
    return [...tp.matchAll(/TAP-OPEN-ALLOWED:/g)].every(m => (m.index > a && m.index < b) || (m.index > inj && m.index < inj + 200));
  })());
  const dsp = codeOnly(read('src/tap-dispatch.js'));
  check('the dispatcher opens a route only via focusThenOpen, or at once when focus returned null',
    /if \(!flight\) \{\s*o\.gate\.invalidate\(\);[^\n]*\n\s*route\.open\(/.test(dsp) &&
    /return focusThenOpen\(o\.gate, \(\) => flight, \(\) => route\.open\(/.test(dsp) &&
    (dsp.match(/route\.open\(/g) || []).length === 2);
}

// ---- 3. behaviour: the demo house ------------------------------------------
console.log('behaviour: every interactive thing in the demo house');
{
  const rooms = JSON.parse(read('houses/demo/rooms.json'));
  const geo = JSON.parse(read('houses/demo/geometry.json'));
  const s = rooms.sensors || {};
  const vacuums = normaliseVacuumBindings(s.vacuums);
  const plants = normalisePlantBindings(s.plants);
  const items = normaliseItemBindings(s.items || {});
  const sm = normaliseSoundMenu(s.soundMenu);
  const ctx = { vacuums, plants, items, climate: s.climate || {}, rawItems: s.items || {}, soundOpenFrom: sm ? sm.openFrom : null };
  const furniture = geo.furniture || [];
  const ids = new Set([...vacuums.keys(), ...plants.keys(), ...(sm ? sm.openFrom.keys() : []), ...tappableFurnitureIds(furniture, items, s.climate)]);
  const targets = [];
  const missing = [];
  furniture.filter(f => ids.has(f.id)).forEach(f => {
    // A region card (one cabinet, two cards) is tapped once per region.
    const width = 100;
    const it = Object.assign({}, f, { origin: [0, 0, 0], rotationDeg: 0, width });
    const regions = (items.get(f.id) || []).filter(c => c.region);
    const pts = regions.length ? regions.map(c => ({ x: ((c.region.from + c.region.to) / 2 - width / 2) / 100, y: 0, z: 0 })) : [{ x: 0, y: 0, z: 0 }];
    pts.forEach(pt => {
      const t = T.furnitureTarget(it, pt, {}, ctx);
      if (t) targets.push(t); else missing.push(f.id);
    });
  });
  const bindings = { lights: rooms.rooms || {}, curtains: s.curtains || {}, doors: s.doors || {} };
  Object.keys(bindings.lights).forEach(r => Object.keys(bindings.lights[r]).forEach(ch => {
    const t = T.resolveTarget({ userData: { lightChannel: ch, roomId: r } }, bindings); if (t) targets.push(t);
  }));
  Object.keys(bindings.curtains).forEach(id => { const t = T.resolveTarget({ name: 'curtain:' + id, userData: {} }, bindings); if (t) targets.push(t); });
  Object.keys(bindings.doors).forEach(id => { const t = T.resolveTarget({ userData: { doorProfileId: id } }, bindings); if (t) targets.push(t); });
  check('every tappable demo furniture id makes a target', missing.length === 0, missing);
  const kinds = new Set(targets.map(t => t.kind));
  check('the demo covers lights, curtains, doors, a radiator, the vacuum, plants, item cards, the TV, a clock and the speakers',
    ['light', 'curtain', 'door', 'climate', 'vacuum', 'plant', 'item', 'clock', 'soundMenu'].every(k => kinds.has(k)), [...kinds]);
  check('... the demo TV is an item card', targets.some(t => t.kind === 'item' && /tv/.test(t.itemId)));
  check('... both demo speakers open the sound menu', targets.filter(t => t.kind === 'soundMenu').length >= 2);

  for (const t of targets) {
    const h = harness();
    const done = h.disp.dispatch(t, { x: 0, y: 0, z: 0 }, { x: 5, y: 5 });
    await tick();
    const name = t.kind + ' ' + t.id;
    if (D.FOCUS_OPT_OUTS[t.kind]) {
      check(name + ': declared opt-out -- opens at once, no flight', h.log.length === 1 && h.log[0].startsWith('open:'), h.log);
      continue;
    }
    check(name + ': the flight starts, and nothing opens while it flies', h.log.length === 1 && h.log[0].startsWith('fly:'), h.log);
    await h.land();
    const opened = await done;
    check(name + ': then it opens -- flight first, open second', opened === true && h.log.length === 2 && h.log[1].startsWith('open:'), h.log);
  }
}

// ---- 3b. dispatcher semantics -------------------------------------------------
console.log('dispatcher semantics');
{
  const h = harness();
  const a = { kind: 'plant', id: 'p1' }, b = { kind: 'vacuum', id: 'v1' };
  const pa = h.disp.dispatch(a, null, { x: 0, y: 0 });
  const pb = h.disp.dispatch(b, null, { x: 0, y: 0 });
  await h.land();
  const [oa, ob] = [await pa, await pb];
  check('a newer tap supersedes one still in the air: only the newer opens', oa === false && ob === true &&
    h.log.join() === 'fly:plant:p1,fly:vacuum:v1,open:vacuum:v1', h.log);
  check('... and the superseded one is reported abandoned', h.abandoned.join() === 'p1', h.abandoned);
  const h2 = harness();
  const p = h2.disp.dispatch({ kind: 'item', id: 'x' }, null, { x: 0, y: 0 });
  await tick();
  h2.gate.invalidate();   // Escape / wheel / a pointer down elsewhere
  await h2.land();
  check('invalidated while flying (Escape, wheel): never opens', (await p) === false && h2.log.join() === 'fly:item:x', h2.log);
  const h3 = harness({ focusOff: true });
  await h3.disp.dispatch({ kind: 'item', id: 'x' }, null, { x: 0, y: 0 });
  check('focus switched off (focus() returns null): opens at once', h3.log.join() === 'open:item:x', h3.log);
  const h4 = harness({ cover: 488 });
  h4.disp.dispatch({ kind: 'soundMenu', id: 's', itemId: 's' }, null, { x: 0, y: 0 });
  check('the sound menu hands its docked width to the flight (frames the speaker beside it)', h4.frames[0] && h4.frames[0].coverRight === 488, h4.frames);
  const h5 = harness();
  check('an unknown kind opens nothing', (await h5.disp.dispatch({ kind: 'nope', id: 'n' }, null, { x: 0, y: 0 })) === false && h5.log.length === 0);
}

// ---- 4. no per-type code ------------------------------------------------------
console.log('a new interactive type flies with no code of its own');
{
  const log = [];
  const routes = D.defineTapRoutes([{ kind: 'dummy', open: t => log.push('open:' + t.id) }]);
  const disp = D.createTapDispatcher({ routes, gate: F.createFocusGate(), focus: t => { log.push('fly:' + t.id); return Promise.resolve('landed'); } });
  await disp.dispatch({ kind: 'dummy', id: 'gizmo' }, null, { x: 0, y: 0 });
  check('a newly registered kind flies, then opens, with nothing but { kind, open }', log.join() === 'fly:gizmo,open:gizmo', log);
  const throws = fn => { try { fn(); return false; } catch (e) { return true; } };
  check('an undeclared opt-out (focus: false) throws',
    throws(() => D.defineTapRoutes([{ kind: 'dummy', open: () => {}, focus: false, reason: 'because' }])));
  check('a declared kind still needs its reason', throws(() => D.defineTapRoutes([{ kind: 'door', open: () => {}, focus: false }])));
  check('a route cannot smuggle in a flag (unknown key throws)', throws(() => D.defineTapRoutes([{ kind: 'dummy', open: () => {}, noFocus: true }])));
  check('focus: true-ish values other than "omitted" throw', throws(() => D.defineTapRoutes([{ kind: 'dummy', open: () => {}, focus: 0 }])));
  check('a kind registered twice throws', throws(() => D.defineTapRoutes([{ kind: 'a', open: () => {} }, { kind: 'a', open: () => {} }])));

  // A new device bound in the profile: a sensors.items entry and an openFrom
  // entry for furniture nobody has written code for.
  const items = normaliseItemBindings({ new_gadget: { title: 'Gadget', media: [{ entity: 'media_player.gadget', label: 'Gadget' }] } });
  const demoSm = JSON.parse(read('houses/demo/rooms.json')).sensors.soundMenu;
  const sm = normaliseSoundMenu(Object.assign({}, demoSm, { openFrom: { new_speaker: demoSm.speakers[0].entity } }));
  const ctx = { vacuums: new Map(), plants: new Map(), items, climate: {}, rawItems: {}, soundOpenFrom: sm ? sm.openFrom : null };
  const tg = T.furnitureTarget({ id: 'new_gadget', type: 'box' }, { x: 0, y: 0, z: 0 }, {}, ctx);
  const ts = T.furnitureTarget({ id: 'new_speaker', type: 'box' }, { x: 0, y: 0, z: 0 }, {}, ctx);
  check('(fixtures) the new item and the new speaker are tap targets', tg && tg.kind === 'item' && ts && ts.kind === 'soundMenu', [tg && tg.kind, ts && ts.kind, !!sm]);
  for (const t of [tg, ts].filter(Boolean)) {
    const h = harness();
    const p = h.disp.dispatch(t, null, { x: 0, y: 0 });
    await tick();
    const before = h.log.slice();
    await h.land(); await p;
    check('a new ' + t.kind + ' binding (' + t.itemId + ') flies first, then opens', before.length === 1 && before[0].startsWith('fly:') && h.log.length === 2 && h.log[1].startsWith('open:'), h.log);
  }
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
