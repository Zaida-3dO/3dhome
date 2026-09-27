#!/usr/bin/env node
/**
 * A desk LED strip as a ROOM LIGHT FIXTURE on its own channel and entity, and
 * where a room's Ambient row comes from. No framework, no install -
 * `node scripts/test-desk-strip-channel.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. A named light channel (e.g. `desk_strip`, bound in rooms.json to its
 *      own entity) follows that entity's on/off, BRIGHTNESS and COLOUR --
 *      before this, any channel other than main/ambient/galaxy followed
 *      on/off only. main, ambient and galaxy are unchanged. A cornice entity
 *      and a desk-strip entity never drive each other.
 *   2. The Ambient row comes from the rooms.json ambient binding, not from a
 *      geometry fixture; a named channel never gets a row of its own. And the
 *      page and scene actually use those functions.
 *   3. roomAccentSummary(): an office shaped like the one this was built for
 *      (cornice + desk strip channel, ambient bound to a group, no ambient
 *      fixture) has exactly two accent emitters, each on its own entity, no
 *      floor-level fixture and one Ambient row.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HAClient } = await imp('src/ha-client.js');
const RP = await imp('src/room-panel.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// ---- 1. a named channel follows brightness and colour ----------------------
{
  const ha = HAClient.create({
    url: 'http://ha.invalid', token: 'x',
    rooms: {
      office: { main: ['light.demo_office'], ambient: ['light.demo_office_ambience'], desk_strip: ['light.demo_desk_strip'] },
      bedroom: { galaxy: ['light.demo_stars'] }
    },
    sensors: { corniceLights: { office_curtain: ['light.demo_office_cornice'] } }
  });
  const seen = [], cornice = [];
  ha.onStateChange((room, group, st) => seen.push([room, group, st]));
  ha.onCorniceChange((id, st) => cornice.push([id, st]));
  const last = () => seen[seen.length - 1];

  ha._injectLightState('light.demo_desk_strip', { state: 'on', attributes: { brightness: 128, rgb_color: [0, 255, 102] } });
  check('a desk-strip entity drives its own channel', last() && last()[0] === 'office' && last()[1] === 'desk_strip', last());
  check('...with brightness', last() && last()[2].bri === 50, last());
  check('...and colour', last() && last()[2].color === '#00ff66', last());
  ha._injectLightState('light.demo_desk_strip', { state: 'on', attributes: { brightness: 255 } });
  check('no rgb_color: colour left alone (not reset)', last()[2].color === undefined && last()[2].bri === 100, last());
  ha._injectLightState('light.demo_desk_strip', { state: 'on', attributes: {} });
  check('on with no brightness attribute -> full brightness', last()[2].bri === 100, last());
  ha._injectLightState('light.demo_desk_strip', { state: 'off', attributes: {} });
  check('off -> on:false, bri 0', last()[2].on === false && last()[2].bri === 0, last());
  check('the desk strip never reaches the cornice path', cornice.length === 0, cornice);
  const nSeen = seen.length;

  ha._injectFittingState('light.demo_office_cornice', { state: 'on', attributes: { brightness: 255 } });
  check('the cornice follows ITS entity', cornice.length === 1, cornice);
  check('...and never reaches the room-light path', seen.length === nSeen, seen.length);

  ha._injectLightState('light.demo_office_ambience', { state: 'on', attributes: { brightness: 204, rgb_color: [255, 0, 0] } });
  check('ambient unchanged: bri + colour', JSON.stringify(last()) === '["office","ambient",{"on":true,"bri":80,"color":"#ff0000"}]', last());
  ha._injectLightState('light.demo_office_ambience', { state: 'on', attributes: {} });
  check('ambient unchanged: default colour when none reported', last()[2].color === '#ff3300', last());
  ha._injectLightState('light.demo_stars', { state: 'on', attributes: { brightness: 255, rgb_color: [1, 2, 3] } });
  check('galaxy unchanged: brightness, no colour', last()[1] === 'galaxy' && last()[2].bri === 100 && last()[2].color === undefined, last());
  ha._injectLightState('light.demo_office', { state: 'on', attributes: { brightness: 255, color_temp_kelvin: 3000 } });
  check('main unchanged: temp, no colour', last()[2].temp === 3000 && last()[2].color === undefined, last());
}

// ---- 2. where the Ambient row comes from -----------------------------------
{
  const rooms = {
    office: { main: ['light.demo_office'], ambient: ['light.demo_office_ambience'], desk_strip: ['light.demo_desk_strip'] },
    hall: { main: ['light.demo_hall'] },
    den: { main: ['light.demo_den'], ambient: [] }
  };
  check('bound ambient, NO geometry fixture -> row', RP.hasAmbientRow(rooms, 'office', false) === true);
  check('a fixture but no binding -> no row', RP.hasAmbientRow(rooms, 'hall', true) === false);
  check('an empty binding is not a binding', RP.hasAmbientRow(rooms, 'den', true) === false);
  check('no rooms.json at all -> the geometry channel decides',
    RP.hasAmbientRow(null, 'office', true) === true && RP.hasAmbientRow(null, 'office', false) === false);
  const bc = RP.boundLightChannels(rooms);
  check('boundLightChannels lists every bound channel, skipping empty ones',
    JSON.stringify(bc) === '{"office":["main","ambient","desk_strip"],"hall":["main"],"den":["main"]}', bc);
  check('row label: the geometry channel name when there is one', RP.ambientRowLabel({ name: 'Study Glow' }, 'Study') === 'Study Glow');
  check('row label: "<Room> Ambience" with no geometry fixture', RP.ambientRowLabel(undefined, 'Home Office') === 'Home Office Ambience');

  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('index.html creates the scene with boundChannels from rooms.json', /boundChannels:\s*boundLightChannels\(rooms\)/.test(html));
  check('index.html gates the ambient row on hasAmbientRow', /hasAmbientRow\(rooms,\s*rid,/.test(html));
  const keysFn = html.slice(html.indexOf('function roomRowKeys'), html.indexOf('function roomRowHtml'));
  check('roomRowKeys adds rows only for main/ambient/galaxy (a desk strip gets none)',
    keysFn.length > 0 && !/Object\.keys\(s\)/.test(keysFn) && (keysFn.match(/keys\.push\('(main|ambient|galaxy)'\)/g) || []).length === 3, keysFn.slice(0, 400));
  check('index.html copies colour for every non-main channel',
    /state\.color !== undefined && group !== 'main'\) ls\[group\]\.color = state\.color/.test(html));
  const scene = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  // The seeding itself is unit-tested in scripts/test-light-state.mjs.
  check('the scene seeds lightState from opts.boundChannels',
    /const lightState = seedLightState\(ROOMS,\s*LIGHTS,\s*opts\.boundChannels\)/.test(scene));
}

// ---- 3. the office: exactly two accent emitters -----------------------------
{
  const strip = (at, size) => ({ at, heightCm: 71.5, size });
  const geometry = {
    lights: [{ room: 'office', fixtures: [
      { channel: 'main', fixtureType: 'spot', count: 5 },
      { channel: 'desk_strip', label: 'Desk strip', fixtureType: 'strip',
        positions: [strip([240, 115], [78.8, 1, 1.2]), strip([200, 175], [1.2, 1, 120]), strip([240, 235], [78.8, 1, 1.2])] }
    ] }],
    curtains: [{ id: 'office_curtain', room: 'office', wall: 4, centre: 100, width: 150, cornice: { depth: 17, height: 10 } }]
  };
  const roomsDoc = {
    rooms: { office: { main: ['light.demo_office'], ambient: ['light.demo_office_ambience'], desk_strip: ['light.demo_desk_strip'] } },
    sensors: { corniceLights: { office_curtain: ['light.demo_office_cornice'] } }
  };
  const sum = RP.roomAccentSummary(geometry, roomsDoc, 'office');
  check('the office has exactly 2 accent emitters', sum.emitters.length === 2, sum.emitters);
  check('...the desk strip channel and the cornice',
    sum.emitters.map(e => e.kind + ':' + e.id).sort().join() === 'channel:desk_strip,cornice:office_curtain', sum.emitters);
  check('each on its OWN entity, never the ambience group',
    sum.emitters.every(e => e.entities.length === 1 && e.entities[0] !== 'light.demo_office_ambience') &&
    new Set(sum.emitters.map(e => e.entities[0])).size === 2, sum.emitters);
  check('no floor-level fixture', sum.floorFixtures.length === 0, sum.floorFixtures);
  check('exactly one Ambient row, with no geometry ambient fixture', sum.ambientRows === 1, sum);

  const before = JSON.parse(JSON.stringify(geometry));
  before.lights[0].fixtures.push({ channel: 'ambient', fixtureType: 'strip', positions: [
    { at: [10, 50], heightCm: 28, label: 'under desk a' }, { at: [20, 50], heightCm: 28, label: 'under desk b' }] });
  const was = RP.roomAccentSummary(before, roomsDoc, 'office');
  check('the old floor placeholders are caught as floor-level', was.floorFixtures.length === 2 && was.emitters.length === 3, was);
  check('...and the row never depended on them', was.ambientRows === 1);
  const proj = JSON.parse(JSON.stringify(geometry));
  proj.lights[0].fixtures.push({ channel: 'galaxy', fixtureType: 'projector', count: 1 });
  check('a projector draws nothing and is not an emitter', RP.roomAccentSummary(proj, roomsDoc, 'office').emitters.length === 2);
  const unlit = JSON.parse(JSON.stringify(geometry));
  unlit.curtains[0].cornice.light = false;
  check('an unlit cornice is not an emitter', RP.roomAccentSummary(unlit, roomsDoc, 'office').emitters.length === 1);
  const bare = JSON.parse(JSON.stringify(geometry));
  delete bare.curtains[0].cornice;
  check('a curtain with no cornice key has the default LIT cornice', RP.roomAccentSummary(bare, roomsDoc, 'office').emitters.length === 2);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
if (failures > 0) process.exit(1);
