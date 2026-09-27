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
 *      never leaves the bounds; boundsExcluding takes the open sidebar out.
 *   4. The status dot: only syncing pulses; a configured HA that is not
 *      connected is red "HA offline"; no 'polling' status exists (#58);
 *      entity and curtain-motor availability apply in every live mode.
 *   5. The door chip says "Unknown" offline with no reading, "Unavailable"
 *      only when the sensor (or a live HA) says so.
 *   6. The coarse/fine hit areas of the row controls never overlap the slider.
 *   7. lightName never repeats the room ("Home office office ambience").
 *   8. marqueePlan: names that fit stay still; overflow slides with ~1.5 s
 *      pauses; reduced motion wraps instead.
 *   9. The accent light's colour square: inline with the slider, current
 *      colour, disabled offline; the main light has none.
 */
import fs from 'node:fs';
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
  ok(T.statusKey('light', null, false) === 'offline', 'no client (demo) -> red offline (preview)');
  ok(T.statusKey('light', 'disconnected', false) === 'haOffline', 'configured HA disconnected -> red HA offline');
  ok(T.statusKey('light', 'auth_failed', false) === 'haOffline' && T.statusKey('light', 'sync_failed', false) === 'haOffline', 'auth/sync failed -> red HA offline');
  ok(T.statusKey('climate', null, false, true) === 'offlineMock', 'no client, climate with sample values -> offlineMock');
  ok(T.statusKey('light', 'syncing', false) === 'connecting', 'syncing -> pulsing yellow');
  ok(T.statusKey('light', 'syncing', true) === 'connecting', 'syncing outranks entity-unavailable (no snapshot yet)');
  ok(T.statusKey('light', 'polling', false) === 'haOffline', "'polling' is not a status any more (#58): not live");
  ok(T.statusKey('light', 'connected', false) === 'ok', 'connected + reporting -> green');
  ok(T.statusKey('light', 'connected', true) === 'na', 'connected, entity unavailable -> yellow na');
  ok(T.statusKey('curtain', 'connected', true) === 'motor', 'connected, curtain motor down -> yellow motor');
}

console.log('status table: no polling, syncing pulses');
{
  const src = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  // The dot class for each key is the first entry of STATUS[key]; read it
  // from source so the test pins the colour, not just the key name.
  const line = k => (src.match(new RegExp('\\n  ' + k + ": \\[[^\\n]*")) || [''])[0];
  const cls = k => (line(k).match(/\['([^']*)'/) || [])[1];
  ok(line('polling') === '', 'no polling entry in the status table');
  ok(cls('connecting') === 'warn pulse', 'only syncing/reconnecting pulses yellow');
  ok(cls('haOffline') === 'bad' && /disabled/.test(line('haOffline')), 'HA offline is red and says controls are disabled');
  ok(/disabled/.test(line('connecting')), 'syncing tooltip says controls are disabled');
  ok(T.isLive('connected') && T.isLive('syncing'), 'connected and syncing are live');
  ok(!T.isLive('polling') && !T.isLive(null) && !T.isLive('disconnected') && !T.isLive('auth_failed') && !T.isLive('sync_failed'), 'everything else is not');
}

console.log('availability applies in every live mode');
{
  for (const c of ['connected', 'syncing']) {
    ok(T.curtainUnavailable(c, false) === true, c + ': curtain reported unavailable -> controls hidden');
    ok(T.curtainUnavailable(c, null) === true, c + ': curtain never heard from -> controls hidden (sidebar rule: must be TRUE)');
    ok(T.curtainUnavailable(c, true) === false, c + ': curtain available -> controls shown');
    ok(T.lightUnavailable(c, { state: 'unavailable' }) === true, c + ': light unavailable -> na');
    ok(T.lightUnavailable(c, { state: 'on' }) === false, c + ': light reporting -> usable');
  }
  ok(T.curtainUnavailable('disconnected', false) === false && T.curtainUnavailable(null, null) === false, 'offline: availability says nothing (haOfflineConn disables instead)');
  ok(T.lightUnavailable(null, null) === false, 'no client: light stays a preview');
  ok(T.lightUnavailable('connected', { state: 'unknown' }) === true && T.lightUnavailable('connected', null) === true, 'unknown / no raw state -> na');
}

console.log('doorState');
{
  ok(T.doorState(null, null) === 'unknown', 'no client, never reported -> Unknown (not Unavailable)');
  ok(T.doorState(null, 'disconnected') === 'unknown', 'disconnected, never reported -> Unknown');
  ok(T.statusKey('door', 'disconnected', T.doorState(null, 'disconnected') === 'na') === 'haOffline', '...with the red HA offline dot');
  ok(T.doorState('unavailable', 'connected') === 'na', 'connected, sensor unavailable -> Unavailable');
  ok(T.statusKey('door', 'connected', T.doorState('unavailable', 'connected') === 'na') === 'na', '...with the yellow dot');
  ok(T.doorState(null, 'connected') === 'na' && T.doorState(null, 'syncing') === 'na', 'live but never reported -> Unavailable (the sidebar row agrees)');
  ok(T.doorState('on', 'disconnected') === 'open' && T.doorState('off', null) === 'closed', 'offline: last-known reading kept');
  ok(T.doorState('unavailable', 'disconnected') === 'na', 'offline: a last-known "unavailable" still reads Unavailable');
  ok(T.doorState('on', 'connected') === 'open' && T.doorState('off', 'connected') === 'closed', 'live readings');
}

console.log('boundsExcluding (the sidebar is out of bounds)');
{
  const view = { left: 0, top: 0, right: 1280, bottom: 800 };
  const side = { left: 980, top: 0, right: 1280, bottom: 800 };
  let b = T.boundsExcluding(view, side, 900, 400);
  ok(b.left === 0 && b.right === 980 && b.top === 0 && b.bottom === 800, 'open right sidebar: bounds end at its left edge');
  ok(T.boundsExcluding(view, null, 900, 400) === view, 'no sidebar -> bounds unchanged');
  ok(T.boundsExcluding(view, { left: 1280, top: 0, right: 1580, bottom: 800 }, 900, 400) === view, 'closed (translated off-screen) -> unchanged');
  let r = T.placePopover(960, 400, 200, 104, b);
  ok(r.placement === 'above' && r.left + 200 <= 980 - 8, 'tap beside the sidebar: above, clamped clear of it');
  r = T.placePopover(960, 400, 200, 104, view);
  ok(r.left + 200 > 980, '(control: without the sidebar rect that card would sit under it)');
  // Short viewport: above/below do not fit, right would be under the sidebar -> LEFT.
  const shortView = { left: 0, top: 0, right: 700, bottom: 200 };
  const shortSide = { left: 450, top: 0, right: 700, bottom: 200 };
  r = T.placePopover(260, 100, 200, 150, T.boundsExcluding(shortView, shortSide, 260, 100));
  ok(r.placement === 'left' && r.left + 200 <= 260 - 12, 'no room above/below: goes to the side AWAY from the sidebar');
  r = T.placePopover(260, 100, 200, 150, shortView);
  ok(r.placement === 'right' && r.left + 200 > 450, '(control: without the sidebar rect the same tap goes right, under it)');
  // Nothing fits in the leftover strip: clamp INTO it.
  const narrow = T.boundsExcluding({ left: 0, top: 0, right: 400, bottom: 220 }, { left: 250, top: 0, right: 400, bottom: 220 }, 120, 110);
  r = T.placePopover(120, 110, 200, 190, narrow);
  ok(r.placement === 'clamped' && r.left + 200 <= 250 - 8 && r.left >= 8, 'nothing fits: clamped into the space left of the sidebar');
  // A bottom sheet: the strip above it contains the tap.
  b = T.boundsExcluding({ left: 0, top: 0, right: 390, bottom: 844 }, { left: 0, top: 500, right: 390, bottom: 844 }, 200, 300);
  ok(b.top === 0 && b.bottom === 500 && b.left === 0 && b.right === 390, 'bottom sheet: bounds end at its top edge');
  // Full-cover sidebar: nothing left -> the full bounds (card stays above it in z-order).
  b = T.boundsExcluding({ left: 0, top: 0, right: 390, bottom: 844 }, { left: 0, top: 0, right: 390, bottom: 844 }, 200, 300);
  ok(b.right === 390 && b.left === 0 && b.bottom === 844, 'sidebar covers everything: falls back to the full bounds');
  const src = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const z = +(src.match(/position: fixed; z-index: (\d+);/) || [])[1];
  const panelZ = +(html.match(/\.panel \{[^}]*z-index: (\d+)/) || [])[1];
  ok(z > panelZ, 'last resort: the card (z ' + z + ') stays ABOVE the sidebar (z ' + panelZ + ')');
}

console.log('control hit areas never overlap the slider');
{
  ok(T.hitOverlapPx(T.GEOM.coarse) <= 0, 'coarse: Close/Open and switch hit areas end at or above the slider (' + T.hitOverlapPx(T.GEOM.coarse) + 'px)');
  ok(T.hitOverlapPx(T.GEOM.fine) <= 0, 'fine: same (' + T.hitOverlapPx(T.GEOM.fine) + 'px)');
  ok(T.hitOverlapPx({ ibH: 34, ibHitY: 5, swH: 24, swHitY: 10, rangeGap: 2 }) === 3, '(control: the merged 2px gap overlapped by 3px)');
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

console.log('lightName: no duplicated room words');
{
  ok(T.lightName('Home office', 'ambient', 'Office ambience') === 'Home office ambience',
    '"Home office" + "Office ambience" -> "Home office ambience" (not "Home office office ambience")');
  ok(T.lightName('Living Room', 'ambient', 'Room glow') === 'Living room glow', 'one-word overlap at the end of the room name');
  ok(T.lightName('Home office', 'ambient', 'Home Office ambience') === 'Home office ambience', 'label with the whole room (any case): kept');
  ok(T.lightName('Home office', 'ambient', 'Desk ambience') === 'Home office desk ambience', 'no overlap: prefixed as before');
  ok(T.lightName('Hall', 'ambient', 'Hallway strip') === 'Hall hallway strip', 'whole words only: "Hall" does not overlap "Hallway"');
  ok(T.joinRoomName('Main bedroom', 'Bedroom wardrobe LED') === 'Main bedroom wardrobe LED', 'joinRoomName merges the overlap, keeps the rest');
  ok(T.joinRoomName('', 'Cove') === 'Cove' && T.joinRoomName('Lounge', '') === 'Lounge', 'joinRoomName with an empty side');
}

console.log('marqueePlan');
{
  const fit = T.marqueePlan(150, 176);
  ok(fit.mode === 'fit' && fit.distance === 0, 'a name that fits does not move');
  ok(T.marqueePlan(177, 176).mode === 'fit', 'a 1px sub-pixel overflow still counts as fitting (no twitch)');
  const sc = T.marqueePlan(300, 176);
  ok(sc.mode === 'scroll' && sc.distance === 124, 'overflow -> scroll by exactly the hidden width');
  ok(sc.offsets.length === 5 && sc.offsets[0] === 0 && sc.offsets[4] === 1 && sc.offsets.every((v, i, a) => !i || v >= a[i - 1]),
    'offsets run 0..1 in order');
  const pauseMs = sc.offsets[1] * sc.duration;
  ok(Math.abs(pauseMs - 1500) < 5, 'pauses ~1.5 s before moving (' + Math.round(pauseMs) + ' ms)');
  ok(Math.abs((sc.offsets[3] - sc.offsets[2]) * sc.duration - 1500) < 5, 'pauses ~1.5 s at the end before returning');
  ok(Math.abs((sc.offsets[2] - sc.offsets[1]) - (sc.offsets[4] - sc.offsets[3])) < 1e-3, 'slides out and back at the same speed');
  ok(T.marqueePlan(190, 176).duration >= 3000 + 800, 'a tiny overflow still slides slowly (>= 400 ms each way)');
  ok(T.marqueePlan(600, 176).duration > sc.duration, 'a longer name takes longer (constant speed)');
  const rm = T.marqueePlan(300, 176, { reducedMotion: true });
  ok(rm.mode === 'wrap', 'prefers-reduced-motion -> wrap to two lines, no motion');
  ok(T.marqueePlan(150, 176, { reducedMotion: true }).mode === 'fit', 'reduced motion + fits -> nothing changes');
}

console.log('popover markup: title + accent colour square');
{
  const dot = () => '';
  const base = { status: 'ok', na: false, haOff: false, on: true, bri: 17, name: 'Home office ambience' };
  const amb = T.popoverHtml.light(Object.assign({ colorable: true, color: '#00CCFF' }, base), dot);
  ok(/<span class="tp-name"><span class="tp-name-in">Home office ambience<\/span><\/span>/.test(amb), 'title wrapped for the marquee');
  ok(/<div class="tp-crow"><input class="tp-color" data-a="color" type="color" value="#00ccff"[^>]*><input class="tp-range/.test(amb),
    'accent: the colour square sits INLINE, left of the brightness slider, showing the current colour');
  ok(/aria-label="Colour"/.test(amb), 'colour square is labelled');
  const main = T.popoverHtml.light(Object.assign({ colorable: false }, base), dot);
  ok(!/type="color"/.test(main) && !/tp-crow/.test(main), 'main light: no colour square, unchanged layout');
  const off = T.popoverHtml.light(Object.assign({ colorable: true, color: '#00ccff' }, base, { haOff: true }), dot);
  ok(/data-a="color"[^>]*\sdisabled/.test(off), 'HA offline: colour square disabled');
  const na = T.popoverHtml.light(Object.assign({ colorable: true, color: '#00ccff' }, base, { na: true }), dot);
  ok(!/type="color"/.test(na), 'entity unavailable: no colour square (as with the slider)');
  const unk = T.popoverHtml.light(Object.assign({ colorable: true }, base), dot);
  ok(/value="#ff3300"/.test(unk), 'unknown colour: the scene default, never an invalid value (which shows black)');
  const white = T.popoverHtml.light(Object.assign({ colorable: false, color: '#00ccff' }, base), dot);
  ok(!/type="color"/.test(white) && /data-a="bri"/.test(white), 'white-only accent entity: slider, no colour square');
  const src = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  ok(!/text-overflow: ellipsis/.test(src), 'no ellipsis on the title');
  ok(/\.tp-name\.marq \{[\s\S]{0,300}?mask-image: linear-gradient/.test(src),'overflowing title fades its edges (mask)');
  ok(/\.tp-name\.wrap \{[^}]*-webkit-line-clamp: 2/.test(src), 'reduced motion wraps to two lines');
  ok(/if \(p\.hover \|\| p\.hold \|\| p\.ctl\.dragging\) p\.marq\.pause\(\); else p\.marq\.play\(\);/.test(src),
    'marquee pauses while hovered or while a slider is held/dragged');
  ok(/\$\{sel\} \.tp-color \{ --sq: 20px; --pad: 12px; \}/.test(src), 'coarse pointer: colour square hit area 20 + 2x12 = 44px');
}

if (failed) { console.log('\n' + failed + ' FAILED'); process.exit(1); }
console.log('\nall passed');
