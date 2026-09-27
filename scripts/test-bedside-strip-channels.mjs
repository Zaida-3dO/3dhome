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
 *   4. The fixture for a level, drawn from cabinet.channelStripBoxes()
 *      for a table standing against a wall, sits inside the table's
 *      footprint at the level's height -- one position (so one light) per
 *      level -- on the strip's front, with no mesh of its own and a short
 *      reach, and the house loader keeps both of those.
 *   5. light-parts.applyLightPart(): a lit level shows its strip in the
 *      light's colour and washes the drawer front below by brightness; an
 *      OFF level hides its strip and leaves the front plain (just the
 *      recess), whatever the other level does.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { HAClient } = await imp('src/ha-client.js');
const RP = await imp('src/room-panel.js');
const C = await imp('src/furniture/cabinet.js');
const { CABINET_PRESETS } = await imp('scripts/lib-cabinet-presets.mjs');
const LP = await imp('src/furniture/light-parts.js');
const { HouseLoader } = await imp('src/house-loader.js');
const THREE = await imp('vendor/three-r160/three.module.min.js');

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
      at: [+(WALL_X - b.lightAt[2]).toFixed(1), +(centreY + b.lightAt[0]).toFixed(1)],
      heightCm: b.lightAt[1], drawn: false, reachCm: 90, aim: [-1, 0], spreadDeg: 90,
      label: side + ' bedside, ' + ['top', 'bottom'][i],
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
      check(f.channel + ': on the table, along the wall (width)', pos.at[1] >= cy - p.width / 2 && pos.at[1] <= cy + p.width / 2, pos.at);
      check(f.channel + ': in the channel, within 2 cm behind the drawer fronts',
        pos.at[0] > WALL_X - p.depth && pos.at[0] <= WALL_X - p.depth + 2, pos.at[0]);
      check(f.channel + ': no mesh of its own (the table draws the strip), a short reach, aimed out of the table (west)',
        pos.drawn === false && pos.reachCm > 0 && pos.reachCm < 250 && pos.aim[0] < 0 && pos.aim[1] === 0, pos);
      check(f.channel + ': in a channel row, between the drawers', pos.heightCm > (p.plinth.height || 0) && pos.heightCm < p.height, pos.heightCm);
    });
  });
}

// ---- 4b. the house loader keeps `drawn` and `reachCm` ---------------------
{
  const doc = {
    kind: 'geometry', schemaVersion: '1.0', id: 'demo_bed', name: 'Demo', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01, planAxes: 'x_east_y_south' },
    defaults: { wallHeight: 245, wallThickness: 10 },
    walls: [{ id: 'w1', start: [0, 0], end: [500, 0] }],
    rooms: [{ id: 'bedroom', name: 'Bedroom', polygon: [[0, 0], [500, 0], [500, 400], [0, 400]] }],
    lights: [{ room: 'bedroom', fixtures: [
      { channel: 'bedside_north_top', fixtureType: 'strip', positions: [
        { at: [479, 120], heightCm: 38, drawn: false, reachCm: 90, aim: [-1, 0], spreadDeg: 90 }] },
      { channel: 'strip_plain', fixtureType: 'strip', positions: [{ at: [100, 20], heightCm: 200, size: [100, 1, 1] }] }] }],
  };
  const house = HouseLoader.compile(doc, 'houses/demo_bed/');
  const pos = house.lights.bedroom.bedside_north_top.positions[0];
  check('loader keeps drawn:false, reachCm, aim and spreadDeg', pos.drawn === false && pos.reachCm === 90 &&
    JSON.stringify(pos.aim) === '[-1,0]' && pos.spreadDeg === 90, pos);
  const plain = house.lights.bedroom.strip_plain.positions[0];
  check('...and adds none of them to a plain strip', !('drawn' in plain) && !('reachCm' in plain) &&
    !('aim' in plain) && !('spreadDeg' in plain), plain);
}

// ---- 4c. an aimed strip light keeps its aim through collapseEmitters -------
{
  const { collapseEmitters } = await imp('src/light-merge.js');
  const out = collapseEmitters([
    { x: 1, y: 0.38, z: 1, intensity: 1, distance: 0.9, decay: 2, aim: [-1, 0], spread: 90 },
    { x: 1, y: 0.18, z: 1, intensity: 1, distance: 0.9, decay: 2, aim: [-1, 0], spread: 90 },
  ], { minX: 0, maxX: 4, minZ: 0, maxZ: 4 }, { merge: false });
  check('strips stay one light each, each keeping its aim and spread', out.length === 2 &&
    out.every(m => JSON.stringify(m.aim) === '[-1,0]' && m.spread === 90 && m.distance === 0.9), out);
}

// ---- 5. light parts follow their channel ------------------------------------
{
  const p = JSON.parse(JSON.stringify(CABINET_PRESETS.bedsideTableLedWide.params));
  const chans = p.fronts.filter(r => r.channel);
  chans[0].channel.light = 'bedside_north_top';
  chans[1].channel.light = 'bedside_north_bottom';
  const g = C.build(THREE, p, { detail: 'full' });
  const parts = [];
  g.traverse(o => { if (o.isMesh && LP.isLightPart(o)) parts.push(o); });
  const of = (ch, role) => parts.filter(o => o.userData.lightChannel === ch && o.userData.lightRole === role);
  const hex = m => '#' + m.getHexString();
  const pose = (top, bottom) => parts.forEach(o =>
    LP.applyLightPart(o, o.userData.lightChannel === 'bedside_north_top' ? top : bottom));

  pose({ on: true, bri: 100, color: '#ff0000' }, { on: false, bri: 100, color: '#00ff00' });
  check('top ON: its strips show, in its colour, lit', of('bedside_north_top', 'strip').every(o =>
    o.visible && hex(o.material.color) === '#ff0000' && hex(o.material.emissive) === '#ff0000' && o.material.emissiveIntensity >= 0.99));
  const band = of('bedside_north_top', 'glow').find(o => o.userData.glowWeight === 1);
  const faint = of('bedside_north_top', 'glow').find(o => o.userData.glowWeight === 0.15);
  check('top ON: the wash fades down the drawer (the band at the channel is redder and brighter than the lowest)',
    band && faint && band.material.color.g < faint.material.color.g - 0.2 &&
    band.material.emissiveIntensity > faint.material.emissiveIntensity * 3, [hex(band.material.color), hex(faint.material.color)]);
  check('top ON: the drawer below is washed in its colour (red over white)', band &&
    band.material.color.r > band.material.color.g + 0.3 && band.material.emissiveIntensity > 0.9 &&
    hex(band.material.emissive) === hex(band.material.color), hex(band.material.color));
  check('bottom OFF: its strips are hidden (just the recess)', of('bedside_north_bottom', 'strip').every(o => !o.visible));
  const offBands = of('bedside_north_bottom', 'glow');
  check('bottom OFF: its drawer is the plain front, every band of it', offBands.length === 4 && offBands.every(b =>
    hex(b.material.color) === p.color && hex(b.material.emissive) === '#000000' && b.material.emissiveIntensity === 0),
    offBands.map(b => [hex(b.material.color), hex(b.material.emissive)]));

  const fullG = band.material.color.g, fullK = band.material.emissiveIntensity;
  pose({ on: true, bri: 10, color: '#ff0000' }, { on: true, bri: 100, color: '#0000ff' });
  const dim = band.material;
  check('top at 10%: the wash is weaker than at 100% (less red over the white, dimmer)',
    dim.color.g > fullG + 0.1 && dim.emissiveIntensity < fullK - 0.3, [hex(dim.color), dim.emissiveIntensity, fullG, fullK]);
  check('bottom back ON: its strips show again, in the new colour', of('bedside_north_bottom', 'strip').every(o =>
    o.visible && hex(o.material.color) === '#0000ff'));
  check('a dimmed strip still reads lit', of('bedside_north_top', 'strip').every(o => o.material.emissiveIntensity >= LP.STRIP_MIN_INTENSITY));
  check('a non-light mesh or a missing state is left alone',
    LP.applyLightPart({ userData: {} }, { on: true }) === false && LP.applyLightPart(parts[0], undefined) === false);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
if (failures > 0) process.exit(1);
