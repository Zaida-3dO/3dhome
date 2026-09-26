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
  climate: { lounge_radiator: ['climate.e'] },
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
  const r = T.resolveTarget(rad, bindings);
  ok(r && r.kind === 'climate' && r.entities[0] === 'climate.e', 'radiator furniture -> climate entity');
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
  let r = T.placePopover(200, 400, 224, 150, b);
  ok(r.placement === 'above' && r.top === 400 - 14 - 150 && r.left === 88, 'centred above the tap');
  r = T.placePopover(200, 60, 224, 150, b);
  ok(r.placement === 'below' && r.top === 74, 'flips below near the top edge');
  r = T.placePopover(5, 400, 224, 150, b);
  ok(r.left === 8, 'clamped to the left margin');
  r = T.placePopover(398, 400, 224, 150, b);
  ok(r.left + 224 <= 392, 'clamped to the right margin');
  r = T.placePopover(200, 100, 224, 700, b);
  ok(r.top >= 8 && r.top + 700 <= 800, 'too tall either way -> kept inside the bounds');
}

if (failed) { console.log('\n' + failed + ' FAILED'); process.exit(1); }
console.log('\nall passed');
