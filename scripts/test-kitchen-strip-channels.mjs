#!/usr/bin/env node
/**
 * Kitchen LED strips as ROOM LIGHT FIXTURES: three strip channels in one
 * room, each bound to its own entity, under ONE Ambient row that switches the
 * room's ambience group. The pattern is the desk strip's
 * (test-desk-strip-channel.mjs); this pins what is new about a kitchen: several
 * named channels in one room, a plinth strip that is legitimately floor-level,
 * and no ambient fixture at all. No framework, no install -
 * `node scripts/test-kitchen-strip-channels.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. Each strip entity drives exactly its own channel (brightness and
 *      colour); the ambience GROUP entity drives only `ambient`, never a
 *      strip channel; and no strip entity drives another strip.
 *   2. The room binds all four accent channels, gets exactly ONE Ambient row
 *      (from the binding, with no ambient fixture), labelled
 *      "<Room> Ambience".
 *   3. roomAccentSummary(): a kitchen shaped like the one this was built for
 *      (top strip, under-cabinet strip, three plinth runs) has exactly three
 *      channel emitters, each on its OWN entity, and its floor-level fixtures
 *      are exactly the plinth runs.
 */
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

const ENT = {
  main: 'light.demo_kitchen',
  ambient: 'light.demo_kitchen_ambience',
  strip_top: 'light.demo_kitchen_top_strip',
  strip_under: 'light.demo_kitchen_under_strip',
  strip_plinth: 'light.demo_kitchen_plinth_strip',
};
const STRIPS = ['strip_top', 'strip_under', 'strip_plinth'];
const kitchenRooms = () => ({
  kitchen: { main: [ENT.main], ambient: [ENT.ambient],
    strip_top: [ENT.strip_top], strip_under: [ENT.strip_under], strip_plinth: [ENT.strip_plinth] },
});

// ---- 1. each strip entity drives exactly its own channel --------------------
{
  const ha = HAClient.create({ url: 'http://ha.invalid', token: 'x', rooms: kitchenRooms(), sensors: {} });
  const seen = [];
  ha.onStateChange((room, group, st) => seen.push([room, group, st]));
  const colours = { strip_top: [255, 64, 160], strip_under: [48, 64, 255], strip_plinth: [255, 48, 0] };
  const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  STRIPS.forEach((ch, i) => {
    const n = seen.length;
    ha._injectLightState(ENT[ch], { state: 'on', attributes: { brightness: 51 * (i + 1), rgb_color: colours[ch] } });
    const got = seen.slice(n);
    check(ch + ': its entity fires exactly one reading, on its own channel',
      got.length === 1 && got[0][0] === 'kitchen' && got[0][1] === ch, got);
    check(ch + ': with its brightness and colour',
      got.length === 1 && got[0][2].on === true && got[0][2].bri === 20 * (i + 1) && got[0][2].color === hex(colours[ch]), got);
  });
  const n = seen.length;
  ha._injectLightState(ENT.ambient, { state: 'on', attributes: { brightness: 255, rgb_color: [1, 2, 3] } });
  const grp = seen.slice(n);
  check('the ambience group drives ambient ONLY, never a strip channel',
    grp.length === 1 && grp[0][1] === 'ambient', grp);
  const m = seen.length;
  ha._injectLightState(ENT.strip_plinth, { state: 'off', attributes: {} });
  const off = seen.slice(m);
  check('a strip turning off touches only its own channel',
    off.length === 1 && off[0][1] === 'strip_plinth' && off[0][2].on === false, off);
}

// ---- 2. ONE Ambient row, from the binding -----------------------------------
{
  const rooms = kitchenRooms();
  check('bound ambient with NO ambient fixture -> the row', RP.hasAmbientRow(rooms, 'kitchen', false) === true);
  const bc = RP.boundLightChannels(rooms);
  check('the scene is told every bound channel (main, ambient, the three strips)',
    JSON.stringify(bc.kitchen) === JSON.stringify(['main', 'ambient'].concat(STRIPS)), bc);
  check('row label falls back to "Kitchen Ambience"', RP.ambientRowLabel(undefined, 'Kitchen') === 'Kitchen Ambience');
}

// ---- 3. the kitchen: three emitters, each on its own entity -----------------
{
  // Generic plan numbers in the shape of an L kitchen with a fridge: each
  // strip tucked under/behind a cabinet lip (see docs/house-profile.md).
  const s = (at, heightCm, size, label) => ({ at, heightCm, size, label });
  const geometry = {
    lights: [{ room: 'kitchen', fixtures: [
      { channel: 'main', fixtureType: 'downlight', positions: [{ at: [100, 100] }] },
      { channel: 'strip_top', fixtureType: 'strip', positions: [s([170, 20], 210.5, [340, 1, 0.8], 'top')] },
      { channel: 'strip_under', fixtureType: 'strip', positions: [s([165, 28], 154.5, [110, 1, 0.8], 'under')] },
      { channel: 'strip_plinth', fixtureType: 'strip', positions: [
        s([164, 67.6], 12.1, [223, 1, 0.8], 'plinth a'),
        s([52.4, 118], 12.1, [0.8, 1, 102], 'plinth b'),
        s([308, 62.6], 12.1, [65, 1, 0.8], 'plinth fridge')] },
    ] }],
    curtains: [],
  };
  const roomsDoc = { rooms: kitchenRooms(), sensors: {} };
  const sum = RP.roomAccentSummary(geometry, roomsDoc, 'kitchen');
  check('exactly 3 accent emitters: the three strip channels',
    sum.emitters.map(e => e.kind + ':' + e.id).sort().join() === STRIPS.map(c => 'channel:' + c).sort().join(), sum.emitters);
  check('each on its OWN entity, never the ambience group',
    sum.emitters.every(e => e.entities.length === 1 && e.entities[0] !== ENT.ambient) &&
    new Set(sum.emitters.map(e => e.entities[0])).size === 3, sum.emitters);
  check('floor-level fixtures are exactly the three plinth runs',
    sum.floorFixtures.map(f => f.id).sort().join() === 'plinth a,plinth b,plinth fridge' &&
    sum.floorFixtures.every(f => f.channel === 'strip_plinth'), sum.floorFixtures);
  check('exactly one Ambient row, with no ambient fixture', sum.ambientRows === 1, sum);

  // The placeholder bars this replaces were an `ambient` fixture: the row
  // never depended on them, and dropping them leaves no ambient emitter.
  const before = JSON.parse(JSON.stringify(geometry));
  before.lights[0].fixtures.push({ channel: 'ambient', fixtureType: 'strip', positions: [
    s([170, 30], 240, [239, 2, 2], 'old top bar'), s([170, 30], 10, [239, 2, 2], 'old bottom bar')] });
  const was = RP.roomAccentSummary(before, roomsDoc, 'kitchen');
  check('with the old bars: 4 emitters, one of them the GROUP', was.emitters.length === 4 &&
    was.emitters.some(e => e.id === 'ambient' && e.entities[0] === ENT.ambient), was.emitters);
  check('...and still one Ambient row', was.ambientRows === 1);
  const unbound = { rooms: { kitchen: Object.assign({}, kitchenRooms().kitchen, { ambient: [] }) }, sensors: {} };
  check('no ambience binding -> no row, whatever the strips', RP.roomAccentSummary(geometry, unbound, 'kitchen').ambientRows === 0);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
if (failures > 0) process.exit(1);
