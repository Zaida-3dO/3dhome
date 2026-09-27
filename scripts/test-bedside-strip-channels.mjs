#!/usr/bin/env node
/**
 * Bedside table LED strips as ROOM LIGHT FIXTURES: two tables, two drawer
 * levels each, every level a `strip` fixture on its own channel bound to its
 * own entity, under the bedroom's ONE Ambient row. The pattern is the desk
 * strip's and the kitchen's (test-desk-strip-channel.mjs,
 * test-kitchen-strip-channels.mjs); this pins what is new about a bedroom:
 * four channels across two pieces of furniture, a room whose ambience group
 * ALSO holds a lit cornice, the placeholder `ambient` bars gone, and fixture
 * boxes taken from the cabinet builder so they land on the table's recess.
 * No framework, no install - `node scripts/test-bedside-strip-channels.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. Each level's entity drives exactly its own channel (brightness and
 *      colour); the ambience GROUP drives only `ambient`; a level turning off
 *      touches only its own channel.
 *   2. The room binds all four level channels, gets exactly ONE Ambient row
 *      (from the binding, with no ambient fixture), labelled
 *      "Bedroom Ambience".
 *   3. roomAccentSummary(): four level emitters plus the cornice, each on its
 *      OWN entity (never the group); the placeholder bars were the group.
 *   4. The fixture box for a level, drawn from cabinet.channelStripBoxes()
 *      for a table standing against a wall, sits inside the table's
 *      footprint at the level's height -- one position (so one light) per
 *      level.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HAClient } = await imp('src/ha-client.js');
const RP = await imp('src/room-panel.js');
const C = await imp('src/furniture/cabinet.js');
const { CABINET_PRESETS } = await imp('scripts/lib-cabinet-presets.mjs');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

const ENT = {
  main: 'light.demo_bedroom',
  ambient: 'light.demo_bedroom_ambience',
  bedside_north_top: 'light.demo_north_bedside_top',
  bedside_north_bottom: 'light.demo_north_bedside_bottom',
  bedside_south_top: 'light.demo_south_bedside_top',
  bedside_south_bottom: 'light.demo_south_bedside_bottom',
};
const LEVELS = ['bedside_north_top', 'bedside_north_bottom', 'bedside_south_top', 'bedside_south_bottom'];
const bedroomRooms = () => ({
  bedroom: Object.assign({ main: [ENT.main], ambient: [ENT.ambient] },
    Object.fromEntries(LEVELS.map(ch => [ch, [ENT[ch]]]))),
});

// ---- 1. each level's entity drives exactly its own channel ------------------
{
  const ha = HAClient.create({ url: 'http://ha.invalid', token: 'x', rooms: bedroomRooms(), sensors: {} });
  const seen = [];
  ha.onStateChange((room, group, st) => seen.push([room, group, st]));
  const colours = [[219, 232, 255], [255, 179, 71], [255, 64, 160], [48, 64, 255]];
  const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
  LEVELS.forEach((ch, i) => {
    const n = seen.length;
    ha._injectLightState(ENT[ch], { state: 'on', attributes: { brightness: 51 * (i + 1), rgb_color: colours[i] } });
    const got = seen.slice(n);
    check(ch + ': its entity fires exactly one reading, on its own channel',
      got.length === 1 && got[0][0] === 'bedroom' && got[0][1] === ch, got);
    check(ch + ': with its brightness and colour',
      got.length === 1 && got[0][2].on === true && got[0][2].bri === 20 * (i + 1) && got[0][2].color === hex(colours[i]), got);
  });
  const n = seen.length;
  ha._injectLightState(ENT.ambient, { state: 'on', attributes: { brightness: 255, rgb_color: [1, 2, 3] } });
  const grp = seen.slice(n);
  check('the ambience group drives ambient ONLY, never a level channel',
    grp.length === 1 && grp[0][1] === 'ambient', grp);
  const m = seen.length;
  ha._injectLightState(ENT.bedside_south_bottom, { state: 'off', attributes: {} });
  const off = seen.slice(m);
  check('a level turning off touches only its own channel',
    off.length === 1 && off[0][1] === 'bedside_south_bottom' && off[0][2].on === false, off);
}

// ---- 2. ONE Ambient row, from the binding -----------------------------------
{
  const rooms = bedroomRooms();
  check('bound ambient with NO ambient fixture -> the row', RP.hasAmbientRow(rooms, 'bedroom', false) === true);
  const bc = RP.boundLightChannels(rooms);
  check('the scene is told every bound channel (main, ambient, the four levels)',
    JSON.stringify(bc.bedroom) === JSON.stringify(['main', 'ambient'].concat(LEVELS)), bc);
  check('row label falls back to "Bedroom Ambience"', RP.ambientRowLabel(undefined, 'Bedroom') === 'Bedroom Ambience');
}

// ---- 3 + 4. the bedroom: four level emitters, boxes on the tables ----------
// A generic bedroom whose headboard wall is the room's EAST wall at x = 500,
// the two tables standing against it facing west (their front is -x), one
// each side of a bed. A table's local z (back 0 -> front) runs along -x in
// the plan and its width along the plan's y, so a box's plan size is
// [local z, height, local x].
const WALL_X = 500;
function levelFixtures(preset, centreY, side) {
  const p = CABINET_PRESETS[preset].params;
  const names = ['bedside_' + side + '_top', 'bedside_' + side + '_bottom'];
  return C.channelStripBoxes(p).map((b, i) => ({
    channel: names[i], fixtureType: 'strip', positions: [{
      at: [+(WALL_X - b.centre[2]).toFixed(1), +(centreY + b.centre[0]).toFixed(1)],
      heightCm: b.centre[1], size: [b.size[2], b.size[1], b.size[0]], label: side + ' bedside, ' + ['top', 'bottom'][i],
    }],
  }));
}
{
  const fixtures = [{ channel: 'main', fixtureType: 'downlight', positions: [{ at: [400, 200] }] }]
    .concat(levelFixtures('bedsideTableLedWide', 120, 'north'), levelFixtures('bedsideTableLedNarrow', 320, 'south'));
  const geometry = {
    lights: [{ room: 'bedroom', fixtures }],
    curtains: [{ id: 'demo_curtain', room: 'bedroom' }],
  };
  const roomsDoc = { rooms: bedroomRooms(), sensors: { corniceLights: { demo_curtain: ['light.demo_bedroom_curtain'] } } };
  const sum = RP.roomAccentSummary(geometry, roomsDoc, 'bedroom');
  check('five accent emitters: the four levels and the cornice',
    sum.emitters.map(e => e.kind + ':' + e.id).sort().join() ===
      LEVELS.map(c => 'channel:' + c).concat(['cornice:demo_curtain']).sort().join(), sum.emitters);
  check('each on its OWN entity, never the ambience group',
    sum.emitters.every(e => e.entities.length === 1 && e.entities[0] !== ENT.ambient) &&
    new Set(sum.emitters.map(e => e.entities[0])).size === 5, sum.emitters);
  check('one position per level: four fixture lights in all',
    fixtures.filter(f => f.channel !== 'main').reduce((s, f) => s + f.positions.length, 0) === 4);
  check('exactly one Ambient row, with no ambient fixture', sum.ambientRows === 1, sum);

  // The placeholder bars this replaces were an `ambient` fixture: an emitter
  // bound to the GROUP, drawing light nowhere near the tables.
  const before = JSON.parse(JSON.stringify(geometry));
  before.lights[0].fixtures = [fixtures[0], { channel: 'ambient', fixtureType: 'strip', positions: [
    { at: [300, 200], heightCm: 28, size: [2.5, 10, 2.5], label: 'old bar a' },
    { at: [450, 200], heightCm: 28, size: [2.5, 10, 2.5], label: 'old bar b' }] }];
  const was = RP.roomAccentSummary(before, roomsDoc, 'bedroom');
  check('with the old bars: the group was an emitter', was.emitters.some(e => e.id === 'ambient' && e.entities[0] === ENT.ambient), was.emitters);
  check('...and still one Ambient row', was.ambientRows === 1);

  // 4. Each box sits on its table: inside the footprint, at the level height.
  [['bedsideTableLedWide', 120, 'north'], ['bedsideTableLedNarrow', 320, 'south']].forEach(([k, cy, side]) => {
    const p = CABINET_PRESETS[k].params;
    const fx = fixtures.filter(f => f.channel.indexOf('bedside_' + side) === 0);
    check(side + ': two levels, top first', fx.length === 2 && fx[0].positions[0].heightCm > fx[1].positions[0].heightCm, fx);
    fx.forEach(f => {
      const pos = f.positions[0];
      const x0 = pos.at[0] - pos.size[0] / 2, x1 = pos.at[0] + pos.size[0] / 2;
      const y0 = pos.at[1] - pos.size[2] / 2, y1 = pos.at[1] + pos.size[2] / 2;
      check(f.channel + ': inside the footprint along the wall (width)', y0 >= cy - p.width / 2 && y1 <= cy + p.width / 2, [y0, y1]);
      check(f.channel + ': inside the footprint off the wall (depth), clear of the wall',
        x1 < WALL_X && x0 >= WALL_X - p.depth, [x0, x1]);
      check(f.channel + ': reaches to within 2 cm of the front, where the strip shows',
        x0 <= WALL_X - p.depth + 2, x0);
      check(f.channel + ': in a channel row, between the drawers', pos.heightCm > (p.plinth.height || 0) && pos.heightCm < p.height, pos.heightCm);
    });
  });
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
if (failures > 0) process.exit(1);
