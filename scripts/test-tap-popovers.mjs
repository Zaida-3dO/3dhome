#!/usr/bin/env node
/**
 * Tap-popover picking and placement (src/tap-popovers.js). No framework, no
 * install - `node scripts/test-tap-popovers.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. resolveTarget maps a hit mesh to the entity bound in rooms.json, by the
 *      tags the scene already carries, and returns null for an UNBOUND object.
 *   2. pickFromHits is nearest-visible-hit: a solid wall in front of a light
 *      occludes it; a faded wall / glass / zero-opacity catcher does not; a
 *      target is accepted even when its own material is nearly transparent.
 *   3. placePopover prefers above the tap, flips below at the top edge, and
 *      never leaves the bounds.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = await import(pathToFileURL(path.join(root, 'src/tap-popovers.js')).href);

let failed = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok  ' + msg); else { failed++; console.log('  FAIL ' + msg); } };

const bindings = {
  lights: { lounge: { main: ['light.a'], ambient: ['light.b'] } },
  curtains: { lounge_curtain: ['cover.c'] },
  doors: { store_door: ['binary_sensor.d'] },
};
const mat = (opacity, transparent = true) => ({ opacity, transparent });
const mesh = (userData = {}, material = mat(1, false), parent = null, name = '') =>
  ({ isMesh: true, visible: true, userData, material, parent, name });
const hit = (object, distance) => ({ object, distance, face: { materialIndex: 0 } });

console.log('resolveTarget');
{
  const bulb = mesh({ roomId: 'lounge', clickable: true, lightChannel: 'main' });
  const t = T.resolveTarget(bulb, bindings);
  ok(t && t.kind === 'light' && t.entities[0] === 'light.a', 'light fixture -> its channel entity');
  const unbound = mesh({ roomId: 'lounge', lightChannel: 'galaxy' });
  ok(T.resolveTarget(unbound, bindings) === null, 'unbound channel -> null');

  const curtainGroup = { visible: true, userData: {}, name: 'curtain:lounge_curtain', parent: null };
  const panel = mesh({}, mat(1, false), curtainGroup);
  const c = T.resolveTarget(panel, bindings);
  ok(c && c.kind === 'curtain' && c.id === 'lounge_curtain', 'curtain panel -> ancestor curtain:<id>');

  const doorMount = { visible: true, userData: { doorId: 'Store cupboard', doorProfileId: 'store_door' }, name: '', parent: null };
  const slab = mesh({}, mat(1, false), { visible: true, userData: {}, name: '', parent: doorMount });
  const d = T.resolveTarget(slab, bindings);
  ok(d && d.kind === 'door' && d.id === 'store_door', 'door slab -> mount doorProfileId (not the label)');
  const otherMount = { visible: true, userData: { doorId: 'Hall', doorProfileId: 'hall_door' }, parent: null };
  ok(T.resolveTarget(mesh({}, mat(1, false), otherMount), bindings) === null, 'unbound door -> null');

  const rad = mesh({}, mat(1, false), { visible: true, userData: { furnitureId: 'lounge_radiator' }, parent: null });
  ok(T.resolveTarget(rad, bindings) === null, 'merged furniture is not a target (climate opens per room, not by mesh)');
}

console.log('pickFromHits');
{
  const bulb = mesh({ roomId: 'lounge', lightChannel: 'main' });
  const solidWall = mesh({}, mat(1, true), null, 'wall');
  const fadedWall = mesh({}, mat(0.05, true), null, 'faded');
  const glass = mesh({}, mat(0.28, true));
  const catcher = mesh({ roomId: 'lounge', clickable: true }, mat(0, true));

  let p = T.pickFromHits([hit(solidWall, 1), hit(bulb, 2)], bindings);
  ok(p.target === null && p.hit.object === solidWall, 'solid wall in front of a light OCCLUDES it');

  p = T.pickFromHits([hit(fadedWall, 1), hit(glass, 1.5), hit(catcher, 1.8), hit(bulb, 2)], bindings);
  ok(p.target && p.target.kind === 'light', 'faded wall, glass and catcher are see-through');

  const hiddenParent = { visible: false, userData: {}, parent: null };
  const hiddenWall = mesh({}, mat(1, false), hiddenParent);
  p = T.pickFromHits([hit(hiddenWall, 1), hit(bulb, 2)], bindings);
  ok(p.target && p.target.kind === 'light', 'a mesh under an invisible ancestor is skipped');

  const offStrip = mesh({ roomId: 'lounge', lightChannel: 'ambient' }, mat(0.15, true));
  p = T.pickFromHits([hit(offStrip, 1)], bindings);
  ok(p.target && p.target.channel === 'ambient', 'an OFF (15% opaque) strip is still tappable');

  p = T.pickFromHits([hit({ isMesh: false, visible: true, userData: {} }, 0.5), hit(bulb, 2)], bindings);
  ok(p.target && p.target.kind === 'light', 'non-mesh (label/sprite) ignored');

  p = T.pickFromHits([hit(fadedWall, 1)], bindings);
  ok(p.target === null && p.hit === null, 'only see-through hits -> nothing');

  const multi = mesh({}, [mat(0.05, true), mat(1, false)]);
  const h = { object: multi, distance: 1, face: { materialIndex: 1 } };
  p = T.pickFromHits([h, hit(bulb, 2)], bindings);
  ok(p.target === null, 'material-array wall: the FACE\'s material decides (opaque face occludes)');
}

console.log('placePopover');
{
  const b = { left: 0, top: 0, right: 400, bottom: 800 };
  let r = T.placePopover(200, 400, 200, 104, b);
  ok(r.placement === 'above' && r.top === 400 - 12 - 104 && r.left === 100, 'centred above the tap, 12px gap');
  ok(r.arrow.side === 'bottom' && r.arrow.offset === 100, 'arrow on the bottom edge, pointing at the tap');
  r = T.placePopover(200, 60, 200, 104, b);
  ok(r.placement === 'below' && r.top === 72 && r.arrow.side === 'top', 'flips below near the top edge; arrow on top');
  r = T.placePopover(5, 400, 200, 104, b);
  ok(r.left === 8 && r.arrow.offset === T.ARROW_INSET, 'clamped to the left margin; arrow kept off the corner');
  r = T.placePopover(398, 400, 200, 104, b);
  ok(r.left + 200 <= 392 && r.arrow.offset === 200 - T.ARROW_INSET, 'clamped to the right margin; arrow kept off the corner');

  // Short landscape viewport: neither above nor below fits -> go SIDEWAYS.
  const land = { left: 0, top: 0, right: 844, bottom: 200 };
  r = T.placePopover(200, 100, 200, 104, land);
  ok(r.placement === 'right' && r.left === 212, 'no room above/below: placed to the RIGHT of the tap');
  ok(r.arrow.side === 'left' && r.arrow.offset === 100 - r.top, 'side arrow on the left edge, at the tap height');
  ok(r.top >= 8 && r.top + 104 <= 192, 'side placement stays inside the bounds vertically');
  r = T.placePopover(700, 100, 200, 104, land);
  ok(r.placement === 'left' && r.left === 700 - 12 - 200 && r.arrow.side === 'right', 'near the right edge: placed LEFT, arrow on its right edge');
  r = T.placePopover(420, 100, 200, 104, land);
  ok(r.placement === 'right', 'both sides fit: the roomier side (right) wins');
  r = T.placePopover(430, 100, 200, 150, land);
  ok(r.placement === 'left', 'both sides fit, left roomier: left wins');
  ok(r.left + 200 <= 430 - 12, 'the card never covers the tap point sideways');

  // Nothing fits anywhere: clamp, no arrow (it would point from inside the card).
  r = T.placePopover(150, 100, 280, 190, { left: 0, top: 0, right: 300, bottom: 200 });
  ok(r.placement === 'clamped' && r.arrow === null && r.left >= 8 && r.top >= 8, 'nothing fits: clamped, no arrow');
}

console.log('statusKey');
{
  ok(T.statusKey('light', null, false) === 'offline', 'no client -> red offline');
  ok(T.statusKey('light', 'disconnected', false) === 'offline', 'disconnected -> red (the app pill paints it grey)');
  ok(T.statusKey('light', 'auth_failed', false) === 'offline' && T.statusKey('light', 'sync_failed', false) === 'offline', 'auth/sync failed -> red');
  ok(T.statusKey('climate', null, false, true) === 'offlineMock', 'offline climate with sample values -> offlineMock');
  ok(T.statusKey('curtain', 'polling', true) === 'connecting' && T.statusKey('light', 'syncing', false) === 'connecting', 'polling/syncing -> pulsing yellow');
  ok(T.statusKey('light', 'connected', false) === 'ok', 'connected + reporting -> green');
  ok(T.statusKey('light', 'connected', true) === 'na', 'connected, entity unavailable -> yellow na');
  ok(T.statusKey('curtain', 'connected', true) === 'motor', 'connected, curtain motor down -> yellow motor');
}

console.log('climateActivity (hvac_action, never state)');
{
  ok(T.climateActivity('idle', false) === 'idle', "state 'heat' at target reports hvac_action 'idle' -> idle, not heating");
  ok(T.climateActivity('heating', false) === 'heating', "hvac_action 'heating' -> heating");
  ok(T.climateActivity(undefined, false) === null, 'no hvac_action -> nothing claimed (NOT inferred from state)');
  ok(T.climateActivity('heating', true) === 'off', 'an off thermostat is off whatever hvac_action says');
}

console.log('lightName');
{
  ok(T.lightName('Hall', 'main', 'Hall Ceiling') === 'Hall ceiling', 'label containing the room: sentence-cased, kept');
  ok(T.lightName('Living Room', 'main', 'Living Room') === 'Living room light', 'label == room -> "{Room} light"');
  ok(T.lightName('Lounge', 'ambient', 'Cove') === 'Lounge cove', 'label lacking the room gets it prefixed');
  ok(T.lightName('Study', 'main', '') === 'Study light', 'no label -> "{Room} light"');
  ok(T.lightName('Lounge', 'ambient', 'TV backlight') === 'Lounge TV backlight', 'ALL-CAPS words survive sentence case');
  ok(T.sentenceCase('Living Room radiator') === 'Living room radiator', 'sentenceCase lowers Capitalised words after the first');
}

if (failed) { console.log('\n' + failed + ' FAILED'); process.exit(1); }
console.log('\nall passed');
