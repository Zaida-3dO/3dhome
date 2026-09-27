#!/usr/bin/env node
/**
 * Furniture bound to a Home Assistant light, and where a room's Ambient row
 * comes from. No framework, no install - `node scripts/test-furniture-light.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. The binding mapping (src/furniture-light.js): a light state
 *      { on, bri, color } becomes the look a bound part shows -- off is a
 *      dim grey line with no glow, brightness scales the glow (with a floor
 *      so 1% still reads as lit), an HA colour replaces the authored one and
 *      no reading yet shows the authored colour, lit. Painted onto REAL
 *      three.js materials of both kinds a glowing part can have.
 *   2. Which parts follow: a builder's ledStrip-tagged parts only (the
 *      desk's strip, not its control-panel display), else every emissive part.
 *   3. roomAmbientSummary(): counting a room's ambient emitters from the
 *      profile files -- an office shaped like the one this feature was built
 *      for ends with EXACTLY two (its cornice and one desk strip), each on its
 *      own entity, no floor-level ambient fixture, and one Ambient row.
 *   4. ha-client's rooms.json sensors.furnitureLights kind: a bound entity resolves to
 *      { on, bri, color } for the item, fires only on a real change, one
 *      entity can drive a cornice AND a desk (or two desks), and none of it
 *      leaks into the room-light path.
 *   5. The Ambient row comes from the rooms.json binding, not from a
 *      geometry fixture: a room that binds ambient but draws no ambient
 *      fixture keeps its row; one that draws a fixture but binds nothing has
 *      none; with no rooms.json at all the geometry channel still counts.
 *      And index.html actually uses those two functions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const FL = await imp('src/furniture-light.js');
const { HAClient } = await imp('src/ha-client.js');
const RP = await imp('src/room-panel.js');
const Desk = await imp('src/furniture/standing-desk.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const hex = c => '#' + c.getHexString();

// ---- 1. state -> look ------------------------------------------------------
{
  const rest = '#ff9a45';
  const none = FL.lightLook(null, rest);
  check('no reading yet: authored colour, lit, full level', none.on && none.level === 1 && none.color === rest && none.shown === rest, none);

  const off = FL.lightLook({ on: false, bri: 80, color: '#00ff00' }, rest);
  check('off: level 0, shown as the dim off grey', !off.on && off.level === 0 && off.shown === FL.OFF_COLOR, off);

  const full = FL.lightLook({ on: true, bri: 100, color: null }, rest);
  check('on, no HA colour: authored colour at full level', full.level === 1 && full.shown === rest, full);

  const half = FL.lightLook({ on: true, bri: 50, color: '#00FF00' }, rest);
  check('HA colour replaces the authored one (normalised lower-case)', half.color === '#00ff00', half);
  check('brightness 50 -> level 0.5', half.level === 0.5, half);
  check('shown colour is the hue scaled by level', half.shown === '#008000', half);

  const dim = FL.lightLook({ on: true, bri: 1, color: '#ffffff' }, rest);
  check('brightness floor: 1% still reads as lit', dim.level === FL.MIN_ON_LEVEL, dim);
  const over = FL.lightLook({ on: true, bri: 250 }, rest);
  check('brightness above 100 clamps to 1', over.level === 1, over);
  const garbage = FL.lightLook({ on: true, bri: 60, color: 'red' }, rest);
  check('a malformed colour falls back to the authored one', garbage.color === rest, garbage);

  // Real materials: the lit emissive MeshStandard a builder makes ...
  const std = new THREE.MeshStandardMaterial({ color: 0xff9a45, emissive: 0xff9a45 });
  const mStd = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), std);
  check('apply reports a change', FL.applyLightLook([mStd], half) === true);
  check('standard: emissive is the hue', hex(std.emissive) === '#00ff00', hex(std.emissive));
  check('standard: emissiveIntensity is the level', std.emissiveIntensity === 0.5, std.emissiveIntensity);
  check('standard: base colour is the hue', hex(std.color) === '#00ff00', hex(std.color));
  check('re-applying the same look changes nothing (no render tick)', FL.applyLightLook([mStd], half) === false);
  FL.applyLightLook([mStd], off);
  check('standard off: no glow at all', hex(std.emissive) === '#000000' && std.emissiveIntensity === 0,
    [hex(std.emissive), std.emissiveIntensity]);
  check('standard off: base colour is the off grey', hex(std.color) === FL.OFF_COLOR, hex(std.color));
  // ... and an unlit MeshBasic (the glow bucket's kind of material).
  const basic = new THREE.MeshBasicMaterial({ color: 0xff9a45 });
  const mBasic = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), basic);
  FL.applyLightLook([mBasic], half);
  check('basic: colour is the scaled hue', hex(basic.color) === '#008000', hex(basic.color));
  FL.applyLightLook([mBasic], off);
  check('basic off: the off grey', hex(basic.color) === FL.OFF_COLOR, hex(basic.color));
}

// ---- 2. which parts follow --------------------------------------------------
{
  const desk = Desk.build(THREE, { ledStrip: true });
  const meshes = [];
  desk.traverse(o => { if (o.isMesh) meshes.push(o); });
  const bound = FL.boundParts(meshes).map(m => m.name).sort();
  check('a desk binds its strip and only its strip (not the control-panel display)',
    bound.join() === 'ledStripFront,ledStripLeft,ledStripRight', bound);
  const noStrip = Desk.build(THREE, {});
  const m2 = [];
  noStrip.traverse(o => { if (o.isMesh) m2.push(o); });
  const fallback = FL.boundParts(m2).map(m => m.name);
  check('with no tagged strip, every emissive part follows', fallback.join() === 'controlPanelDisplay', fallback);
}

// ---- 3. a room's ambient emitters, counted from the profile files --------
{
  // An office like the one this was built for: a lit cornice on its own
  // entity, one desk with an LED strip on its own entity, a second desk with
  // no strip, the room's ambient channel on an ambience GROUP, and no
  // geometry ambient fixture at all.
  const geometry = {
    lights: [{ room: 'office', fixtures: [{ channel: 'main', fixtureType: 'spot', count: 5 }] }],
    curtains: [{ id: 'office_curtain', room: 'office', wall: 4, centre: 100, width: 150, cornice: { depth: 17, height: 10 } }],
    furniture: [
      { id: 'desk_a', room: 'office', type: 'standing-desk', at: [0, 0], params: { ledStrip: true } },
      { id: 'desk_b', room: 'office', type: 'standing-desk', at: [0, 100], params: {} },
      { id: 'lounge_desk', room: 'lounge', type: 'standing-desk', at: [0, 0], params: { ledStrip: true } }
    ]
  };
  const roomsDoc = {
    rooms: { office: { main: ['light.demo_office'], ambient: ['light.demo_office_ambience'] } },
    sensors: {
      corniceLights: { office_curtain: ['light.demo_office_cornice'] },
      furnitureLights: { desk_a: ['light.demo_desk_a_strip'] }
    }
  };
  const sum = FL.roomAmbientSummary(geometry, roomsDoc, 'office', RP.hasAmbientRow);
  check('the office ends with exactly 2 ambient emitters', sum.emitters.length === 2, sum.emitters);
  check('...the cornice and the one desk strip',
    sum.emitters.map(e => e.kind + ':' + e.id).sort().join() === 'cornice:office_curtain,furniture:desk_a', sum.emitters);
  check('each follows its OWN entity, never the ambience group',
    sum.emitters.every(e => e.entities.length === 1 && e.entities[0] !== 'light.demo_office_ambience') &&
    new Set(sum.emitters.map(e => e.entities[0])).size === 2, sum.emitters);
  check('no floor-level ambient fixture', sum.floorFixtures.length === 0, sum.floorFixtures);
  check('exactly one Ambient row, with no geometry ambient fixture', sum.ambientRows === 1, sum);

  // The same office BEFORE the fix: two floor placeholders under the desks.
  const before = JSON.parse(JSON.stringify(geometry));
  before.lights[0].fixtures.push({ channel: 'ambient', fixtureType: 'strip', positions: [
    { at: [10, 50], heightCm: 28, label: 'under desk a' }, { at: [20, 50], heightCm: 28, label: 'under desk b' }] });
  const was = FL.roomAmbientSummary(before, roomsDoc, 'office', RP.hasAmbientRow);
  check('the placeholders counted as 2 more emitters, both floor-level',
    was.emitters.length === 4 && was.floorFixtures.length === 2, was);
  check('...and the row never depended on them', was.ambientRows === 1 && sum.ambientRows === 1);
  const offCornice = JSON.parse(JSON.stringify(geometry));
  offCornice.curtains[0].cornice.light = false;
  check('an unlit cornice is not an emitter', FL.roomAmbientSummary(offCornice, roomsDoc, 'office', RP.hasAmbientRow).emitters.length === 1);
  const bare = JSON.parse(JSON.stringify(geometry));
  delete bare.curtains[0].cornice;
  check('a curtain with no cornice key has the default LIT cornice (house-loader rule)',
    FL.roomAmbientSummary(bare, roomsDoc, 'office', RP.hasAmbientRow).emitters.length === 2);
}

// ---- 4. ha-client furnitureLights ------------------------------------------
{
  const ha = HAClient.create({
    url: 'http://ha.invalid', token: 'x',
    rooms: { study: { ambient: ['light.demo_study_cove'] } },
    sensors: {
      corniceLights: { study_curtain: ['light.demo_shared'] },
      furnitureLights: { desk_a: ['light.demo_desk'], desk_b: ['light.demo_desk'], desk_c: ['light.demo_shared'] }
    }
  });
  const furn = [], cornice = [], room = [];
  ha.onFurnitureLightChange((id, st) => furn.push([id, st]));
  ha.onCorniceChange((id, st) => cornice.push([id, st]));
  ha.onStateChange((r, g, st) => room.push([r, g, st]));

  const fired = ha._injectFittingState('light.demo_desk', { state: 'on', attributes: { brightness: 128, rgb_color: [0, 255, 102] } });
  check('a bound entity fires', fired === true);
  check('...for every item bound to it', furn.map(f => f[0]).sort().join() === 'desk_a,desk_b', furn);
  check('...with { on, bri, color }', furn.length && JSON.stringify(furn[0][1]) === '{"on":true,"bri":50,"color":"#00ff66"}', furn[0]);
  check('an attribute republish with the same values fires nothing',
    ha._injectFittingState('light.demo_desk', { state: 'on', attributes: { brightness: 128, rgb_color: [0, 255, 102], friendly_name: 'x' } }) === false && furn.length === 2, furn.length);
  ha._injectFittingState('light.demo_desk', { state: 'off', attributes: {} });
  check('off resolves to on:false, bri 0', furn.length === 4 && JSON.stringify(furn[3][1]) === '{"on":false,"bri":0,"color":null}', furn.slice(2));

  ha._injectFittingState('light.demo_shared', { state: 'on', attributes: { brightness: 255 } });
  check('one entity drives a cornice AND a desk', cornice.length === 1 && furn.some(f => f[0] === 'desk_c'), { cornice, furn });
  check('no furniture light leaks into the room-light path', room.length === 0, room);
}

// ---- 5. where the Ambient row comes from -----------------------------------
{
  const rooms = {
    office: { main: ['light.demo_office'], ambient: ['light.demo_office_ambience'] },
    hall: { main: ['light.demo_hall'] },
    den: { main: ['light.demo_den'], ambient: [] }
  };
  check('bound ambient, NO geometry fixture -> row', RP.hasAmbientRow(rooms, 'office', false) === true);
  check('bound ambient with a fixture -> row', RP.hasAmbientRow(rooms, 'office', true) === true);
  check('a fixture but no binding -> no row', RP.hasAmbientRow(rooms, 'hall', true) === false);
  check('an empty binding is not a binding', RP.hasAmbientRow(rooms, 'den', true) === false);
  check('a room rooms.json does not list -> no row', RP.hasAmbientRow(rooms, 'attic', true) === false);
  check('no rooms.json at all -> the geometry channel decides', RP.hasAmbientRow(null, 'office', true) === true && RP.hasAmbientRow(null, 'office', false) === false);
  const bc = RP.boundLightChannels(rooms);
  check('boundLightChannels lists every bound channel per room, skipping empty ones',
    JSON.stringify(bc) === '{"office":["main","ambient"],"hall":["main"],"den":["main"]}', bc);
  check('boundLightChannels(null) -> {}', JSON.stringify(RP.boundLightChannels(null)) === '{}');
  check('row label: the geometry channel name when there is one', RP.ambientRowLabel({ name: 'Study Glow' }, 'Study') === 'Study Glow');
  check('row label: "<Room> Ambience" with no geometry fixture', RP.ambientRowLabel(undefined, 'Home Office') === 'Home Office Ambience');

  // The page must actually use them: the scene is told the bound channels
  // (so lightState has an ambient entry without a fixture) and the row list
  // asks hasAmbientRow. Without either, removing a room's ambient fixture
  // silently removes its row -- the bug this guards.
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('index.html creates the scene with boundChannels from rooms.json', /boundChannels:\s*boundLightChannels\(rooms\)/.test(html));
  check('index.html gates the ambient row on hasAmbientRow', /hasAmbientRow\(rooms,\s*rid,/.test(html));
  const scene = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('the scene seeds lightState from opts.boundChannels', /const boundChannels = opts\.boundChannels \|\| \{\};/.test(scene) && /boundChannels\[id\]\)\s*\?\s*boundChannels\[id\]/.test(scene));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
if (failures > 0) process.exit(1);
