#!/usr/bin/env node
/**
 * Furniture item tap cards (src/item-cards.js), their fold into the client
 * (src/ha-client.js), their markup (src/tap-popovers.js) and the demo
 * house's bindings. Never a real HA: the client runs against
 * scripts/fake-ha-websocket.mjs. No framework, no install:
 * `node scripts/test-item-cards.mjs`.
 *
 *   1. normaliseItemBindings: one card or a list; wrong-domain rows dropped;
 *      a bad region or a card with no rows dropped; the entities a card reads.
 *   2. widthOffsetCm: the REGION CONVENTION -- cm from the item's LEFT edge
 *      seen from its FRONT -- at four rotations, and against a real cabinet
 *      built by src/furniture/cabinet.js and placed by src/furniture.js, so
 *      the convention cannot drift from the order `fronts[].cells` are drawn.
 *   3. pickItemCard / furnitureTapTarget: region cards, the whole-item card,
 *      the uncovered part falling through, clocks, radiators -> climate.
 *   4. Row models: a media player (power, volume, source, sound mode,
 *      Offline), a light, a reading -- OFFLINE IS NOT 0.
 *   5. Commands and applyCommand (the optimistic repaint / demo sample).
 *   6. The card markup: controls enabled while connected, all disabled while
 *      HA is offline; the clock card.
 *   7. The client against the fake HA: an item entity's raw state is
 *      recorded, an unbound one is not, and a light row's command goes out
 *      as the right call_service.
 *   8. The demo house binds every card kind, to furniture that exists.
 *   9. The card's wiring, as pure functions tap-popovers.js runs: which
 *      target a furniture hit becomes (a vacuum / plant beats an item
 *      binding; title-only clock / radiator titles; the clock's room), the
 *      item card's title and lead-row relabel, the clock / climate titles,
 *      the item sender's writeBlocked / mock / canSend gates, and the clock
 *      patching its time in place instead of rebuilding every second.
 *  10. A light row's power switch turns on with NO brightness (HA restores
 *      the last level); only the slider sends one.
 *  11. `switches` rows: a switch / input_boolean toggle with its power
 *      sensor's live draw; binding, model, command, markup, the client.
 *  12. The curtains card: one card per ROOM (every bound cover plus the
 *      cornice lights), its cornice sender's gates and commands, its markup.
 *  13. Last-known level: a light switched on (or given a colour while off)
 *      shows the level it will come back at, or "unknown" -- never 100%.
 *  14. Camera rows: binding, URLs, a model free of the rotating token (so
 *      a rotation never rebuilds the card), and the refresh loop's
 *      lifecycle -- one load at a time, back-off, nothing after stop or
 *      while hidden, Live only while on.
 *
 * Each check names the one-line mutation it catches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const IC = await imp('src/item-cards.js');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps) => a != null && Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A console like the one the design was written for: three cells, 50 | 80 | 50.
const CONSOLE = [
  { title: 'Cabinet', region: { from: 0, to: 50 }, readings: [
    { entity: 'sensor.demo_a_temperature', label: 'Box A', humidity: 'sensor.demo_a_humidity' },
    { entity: 'sensor.demo_b_temperature' }] },
  { title: 'Sound', region: { from: 50, to: 130 }, media: [
    { entity: 'media_player.demo_receiver', role: 'receiver' }, { entity: 'media_player.demo_cast', role: 'cast' }],
    readings: [{ entity: 'sensor.demo_cab_temperature' }] },
];

// ---- 1. normalisation -----------------------------------------------------------
{
  const m = IC.normaliseItemBindings({
    console: CONSOLE,
    tv: { media: [{ entity: 'media_player.demo_tv', role: 'tv' }, { entity: 'media_player.demo_tv_cast' }] },
    bedside: { lights: [{ entity: 'light.demo_bedside', label: 'All' }, { entity: 'switch.demo_nope' }] },
    wrong: { media: [{ entity: 'light.demo_not_media' }] },
    badregion: { region: { from: 50, to: 20 }, readings: [{ entity: 'sensor.demo_x' }] },
    negregion: { region: { from: -5, to: 20 }, readings: [{ entity: 'sensor.demo_x' }] },
    empty: {},
    junk: 7,
  });
  check('normalise: valid items kept, a list stays a list', m.get('console').length === 2 && m.get('tv').length === 1, [...m.keys()]);
  // Mutation: drop the domain check in normaliseRows -> 'wrong' survives -> fails.
  check('normalise: a row of the wrong domain is dropped (and its empty card with it)', !m.has('wrong') && m.get('bedside')[0].lights.length === 1);
  // Mutation: `from < to` -> `from <= to` or drop the region check -> fails.
  check('normalise: a region with from >= to is dropped', !m.has('badregion'));
  check('normalise: a negative region start is dropped', !m.has('negregion'));
  check('normalise: a card with no rows / a non-object is dropped', !m.has('empty') && !m.has('junk'));
  const c0 = m.get('console')[0], c1 = m.get('console')[1];
  check('normalise: region, title and index kept', c0.region.from === 0 && c0.region.to === 50 && c0.title === 'Cabinet' && c1.index === 1);
  check('normalise: a humidity partner kept, a missing one null', c0.readings[0].humidity === 'sensor.demo_a_humidity' && c0.readings[1].humidity === null);
  check('normalise: media role kept', c1.media[0].role === 'receiver' && m.get('tv')[0].media[1].role === null);
  // Mutation: forget the humidity entity in cardEntities -> fails.
  check('cardEntities: rows and humidity partners', JSON.stringify(IC.cardEntities(c0)) ===
    JSON.stringify(['sensor.demo_a_temperature', 'sensor.demo_a_humidity', 'sensor.demo_b_temperature']), IC.cardEntities(c0));
  const all = IC.itemBindingEntities(m);
  check('itemBindingEntities: every card of every item', all.has('media_player.demo_cast') && all.has('light.demo_bedside') && all.has('sensor.demo_a_humidity') && !all.has('switch.demo_nope'));
  check('normalise: nothing -> empty map', IC.normaliseItemBindings(undefined).size === 0);
}

// ---- 2. the region convention ---------------------------------------------------
{
  // An item 180 cm wide whose back-centre stands at the world origin.
  const item = r => ({ origin: [0, 0, 0], rotationDeg: r, width: 180 });
  // Rotation 0: the front faces +z (plan south), the width runs along +x, and
  // someone standing in front, facing it, has +x on their RIGHT. 65 cm left of
  // centre is 25 cm from the left edge.
  // Mutation: flip the convention (`w / 2 - localX * 100`) -> 155 -> fails.
  check('offset r=0: left of centre (-x) is near the LEFT edge', near(IC.widthOffsetCm({ x: -0.65, y: 0.3, z: 0.2 }, item(0)), 25));
  check('offset r=0: right of centre (+x) is near the right edge', near(IC.widthOffsetCm({ x: 0.65, y: 0.3, z: 0.2 }, item(0)), 155));
  check('offset: depth and height do not move it', near(IC.widthOffsetCm({ x: -0.65, y: 1.5, z: 0.45 }, item(0)), 25));
  // r=90: plan width vector (cos, sin) = (0, 1) -> world +z. Mutation: sign of
  // the sin term flipped -> 155 -> fails.
  check('offset r=90: the width runs along +z', near(IC.widthOffsetCm({ x: 0.2, y: 0, z: -0.65 }, item(90)), 25));
  check('offset r=180: the width runs along -x', near(IC.widthOffsetCm({ x: 0.65, y: 0, z: -0.2 }, item(180)), 25));
  check('offset r=270: the width runs along -z', near(IC.widthOffsetCm({ x: 0, y: 0, z: 0.65 }, item(270)), 25));
  check('offset: relative to the origin', near(IC.widthOffsetCm({ x: 3.35, y: 0, z: 1 }, { origin: [4, 0, 1], rotationDeg: 0, width: 180 }), 25));
  check('offset: unknown width -> null', IC.widthOffsetCm({ x: 0, y: 0, z: 0 }, { origin: [0, 0, 0], rotationDeg: 0 }) === null);

  // Against the REAL cabinet builder and placement: a 30 | 150 two-door
  // cabinet. The narrow door is cells[0]; wherever the cabinet stands and
  // however it is turned, a point on that door must land in 0..30.
  const THREE = await imp('vendor/three-r160/three.module.min.js');
  const Cab = await imp('src/furniture/cabinet.js');
  const F = await imp('src/furniture.js');
  const params = Object.assign({}, Cab.DEFAULTS, { width: 180, height: 60, depth: 40, plinth: { height: 0 },
    fronts: [{ height: 60, cells: [{ kind: 'door', width: 30 }, { kind: 'door', width: 150 }] }] });
  for (const rot of [0, 90, 180, 270, 35]) {
    const g = Cab.build(THREE, params, { detail: 'full' });
    g.updateMatrixWorld(true);
    const fronts = g.getObjectByName('cabinetFronts');
    let narrow = null, wide = null;
    fronts.traverse(o => {
      if (!o.isMesh) return;
      const s = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
      if (s.y < 0.4) return;   // a handle, a hinge: only the leaves
      if (s.x > 0.2 && s.x < 0.32 && !narrow) narrow = o;
      if (s.x > 1.3 && s.x < 1.52 && !wide) wide = o;
    });
    check('cabinet r=' + rot + ': found both door leaves', !!narrow && !!wide);
    if (!narrow || !wide) continue;
    const placement = { x: 400, y: 300, rotationDeg: rot, elevation: 0 };
    F.placeGroup(g, placement, x => (x - 100) * 0.01, y => (y - 50) * 0.01);
    const it = { origin: g.position.toArray(), rotationDeg: rot, width: 180 };
    const cN = new THREE.Box3().setFromObject(narrow).getCenter(new THREE.Vector3());
    const cW = new THREE.Box3().setFromObject(wide).getCenter(new THREE.Vector3());
    const oN = IC.widthOffsetCm(cN, it), oW = IC.widthOffsetCm(cW, it);
    // Mutation: flip the convention in widthOffsetCm -> the narrow door reads ~165 -> fails.
    check('cabinet r=' + rot + ': cells[0] (the narrow door) is at 0-30 from the left', oN > 0 && oN < 30, oN);
    check('cabinet r=' + rot + ': cells[1] is at 30-180', oW > 30 && oW < 180, oW);
  }
}

// ---- 3. picking ------------------------------------------------------------------
{
  const items = IC.normaliseItemBindings({
    console: CONSOLE,
    tv: { media: [{ entity: 'media_player.demo_tv' }] },
    mixed: [{ region: { from: 0, to: 40 }, readings: [{ entity: 'sensor.demo_m1' }] }, { title: 'Rest', readings: [{ entity: 'sensor.demo_m2' }] }],
  });
  const cards = items.get('console');
  // Mutation: `offsetCm >= c.region.from` -> `>` -> the 0 edge falls through -> fails.
  check('pick: the left region at its left edge', IC.pickItemCard(cards, 0) === cards[0]);
  check('pick: the left region', IC.pickItemCard(cards, 25) === cards[0]);
  check('pick: the middle region', IC.pickItemCard(cards, 90) === cards[1]);
  check('pick: a shared edge goes to the first listed', IC.pickItemCard(cards, 50) === cards[0]);
  // Mutation: fall back to cards[0] when nothing matches -> fails.
  check('pick: a part no card covers -> null (falls through)', IC.pickItemCard(cards, 155) === null);
  check('pick: unknown offset, region cards only -> null', IC.pickItemCard(cards, null) === null);
  const mixed = items.get('mixed');
  check('pick: a region card beats the whole-item card', IC.pickItemCard(mixed, 10) === mixed[0]);
  check('pick: outside every region -> the whole-item card', IC.pickItemCard(mixed, 100) === mixed[1]);
  check('pick: unknown offset -> the whole-item card', IC.pickItemCard(mixed, null) === mixed[1]);

  const climate = { lounge: 'climate.demo_lounge', study: 'climate.demo_study' };
  const ctx = { items, climate };
  const at = (id, type, x, room) => IC.furnitureTapTarget({ id, type, room, origin: [0, 0, 0], rotationDeg: 0, width: 180 }, { x, y: 0.2, z: 0.1 }, ctx);
  const left = at('console', 'cabinet', -0.65), mid = at('console', 'cabinet', 0), right = at('console', 'cabinet', 0.65);
  check('target: console left -> the readings card', left && left.kind === 'item' && left.card === cards[0] && left.itemId === 'console' &&
    left.entities.indexOf('sensor.demo_a_humidity') !== -1, left);
  check('target: console middle -> the media card', mid && mid.card === cards[1] && mid.id === 'console#1', mid);
  check('target: region cards get distinct ids', left.id !== mid.id);
  check('target: console right door -> null (a plain furniture tap)', right === null);
  const tv = at('tv', 'tv', 0.8);
  check('target: a single-card item, anywhere on it', tv && tv.kind === 'item' && tv.id === 'tv' && tv.entities[0] === 'media_player.demo_tv');
  // Mutation: drop the wall-clock branch -> null -> fails.
  const clock = at('hall_clock', 'wall-clock', 0);
  check('target: a wall clock needs no binding', clock && clock.kind === 'clock' && clock.id === 'hall_clock' && clock.entities.length === 0, clock);
  const rad = at('study_rad', 'radiator', 0, 'study');
  // Mutation: key the climate lookup by the item id instead of its room -> fails.
  check('target: a radiator opens its ROOM\'s climate card', rad && rad.kind === 'climate' && rad.id === 'study' && rad.entities[0] === 'climate.demo_study', rad);
  check('target: a radiator in a room with no climate -> null', at('bath_rad', 'radiator', 0, 'bathroom') === null);
  check('target: an unbound sofa -> null', at('sofa', 'sofa', 0) === null);
  check('target: a bound clock is its binding, not a clock', at('tv', 'wall-clock', 0).kind === 'item');

  const ids = IC.tappableFurnitureIds([
    { id: 'hall_clock', type: 'wall-clock', room: 'hall' }, { id: 'study_rad', type: 'radiator', room: 'study' },
    { id: 'bath_rad', type: 'radiator', room: 'bathroom' }, { id: 'sofa', type: 'sofa', room: 'lounge' }], items, climate);
  check('tappable: bound items, clocks, radiators in bound rooms -- nothing else',
    ids.has('console') && ids.has('tv') && ids.has('hall_clock') && ids.has('study_rad') && !ids.has('bath_rad') && !ids.has('sofa'), [...ids]);
}

// ---- 4. row models ---------------------------------------------------------------
{
  const F = IC.MEDIA_FEATURE;
  const recv = { state: 'on', attributes: { supported_features: F.VOLUME_SET | F.TURN_ON | F.TURN_OFF | F.SELECT_SOURCE | F.SELECT_SOUND_MODE,
    volume_level: 0.42, source: 'TV', source_list: ['TV', 'Game'], sound_mode: 'Stereo', sound_mode_list: ['Stereo', 'Night'] } };
  const m = IC.mediaRowModel(recv);
  check('media: a receiver -- on, volume %, sources, sound modes', m.on && m.volume === 42 && m.sources.length === 2 && m.source === 'TV' &&
    m.soundModes[1] === 'Night' && m.canPower && !m.na, m);
  const off = IC.mediaRowModel({ state: 'off', attributes: { supported_features: F.TURN_ON | F.TURN_OFF | F.VOLUME_SET } });
  // Mutation: treat 'off' as on -> fails.
  check('media: off -- no volume or pickers while off, power can turn it on', !off.on && off.stateText === 'Off' && off.volume === null && off.canPower, off);
  check('media: standby counts as off', !IC.mediaRowModel({ state: 'standby', attributes: {} }).on);
  const noOn = IC.mediaRowModel({ state: 'off', attributes: { supported_features: F.TURN_OFF } });
  check('media: a device that cannot be turned on says so', noOn.canPower === false);
  const playing = IC.mediaRowModel({ state: 'playing', attributes: { media_title: 'News', supported_features: F.TURN_OFF } });
  check('media: playing shows its title', playing.on && playing.stateText === 'Playing' && playing.title === 'News');
  check('media: idle shows no title', IC.mediaRowModel({ state: 'idle', attributes: { media_title: 'Old' } }).title === null);
  check('media: no volume support, no level -> no slider', IC.mediaRowModel({ state: 'on', attributes: { supported_features: F.TURN_OFF } }).volume === null);
  // Mutation: back to Math.round((vol != null ? vol : 0) * 100) -> volume 0 -> fails.
  const noLevel = IC.mediaRowModel({ state: 'on', attributes: { supported_features: F.VOLUME_SET | F.TURN_ON | F.TURN_OFF } });
  check('media: takes a volume but reported none -> UNKNOWN, never 0', noLevel.volume === null && noLevel.volumeUnknown === true, noLevel);
  check('media: a reported level is known', recv.attributes && m.volumeUnknown === false && m.volume === 42);
  check('media: an off device has no unknown volume either', off.volumeUnknown === false);
  check('media: sources not offered without SELECT_SOURCE', IC.mediaRowModel({ state: 'on', attributes: { supported_features: F.TURN_OFF, source_list: ['A'] } }).sources.length === 0);
  const un = IC.mediaRowModel({ state: 'unavailable', attributes: {} });
  check('media: unavailable -> Offline, no controls', un.na && un.stateText === 'Offline' && !un.canPower && un.volume === null);
  check('media: never heard from -> Unavailable', IC.mediaRowModel(null).stateText === 'Unavailable');

  const r = IC.readingRowModel({ state: '38.24', attributes: { unit_of_measurement: '°C' } }, { state: '45.6', attributes: {} });
  check('reading: value + unit, humidity rounded', r.text === '38.2°C' && r.humidity === '46%' && !r.na, r);
  check('reading: a non-temperature integer stays an integer', IC.readingRowModel({ state: '21', attributes: { unit_of_measurement: 'W' } }).text === '21 W');
  // Mutation: drop the isTemperatureUnit branch (back to fmtNumber) -> '31°C' -> fails.
  check('reading: a whole temperature keeps one decimal, as the climate card does',
    IC.readingRowModel({ state: '31', attributes: { unit_of_measurement: '°C' } }).text === '31.0°C' &&
    IC.readingRowModel({ state: '70', attributes: { unit_of_measurement: '°F' } }).text === '70.0°F');
  const ro = IC.readingRowModel({ state: 'unavailable', attributes: { unit_of_measurement: '°C' } }, { state: 'unavailable' });
  // Mutation: render Number(state) || 0 -> '0°C' -> fails.
  check('reading: OFFLINE, never 0', ro.na && ro.text === 'Offline' && ro.humidity === null && !/\d/.test(ro.text), ro);
  check('reading: unknown -> Unavailable', IC.readingRowModel({ state: 'unknown', attributes: {} }).text === 'Unavailable');
  check('reading: never heard from -> No reading', IC.readingRowModel(null).text === 'No reading');

  const l = IC.lightRowModel({ state: 'on', attributes: { brightness: 128 } }, false, null);
  check('light: brightness 128 -> 50%', l.on && l.bri === 50 && !l.colorable, l);
  check('light: off keeps a 100% slider position', IC.lightRowModel({ state: 'off', attributes: {} }).bri === 100);
  check('light: unavailable', IC.lightRowModel({ state: 'unavailable', attributes: {} }).na);
  check('light: colour only when told it is colourable', IC.lightRowModel({ state: 'on', attributes: {} }, true, '#ff0000').color === '#ff0000');
  check('rowLabel: label, then friendly_name, then the id', IC.rowLabel({ entity: 'light.a_b', label: 'Top' }) === 'Top' &&
    IC.rowLabel({ entity: 'light.a_b' }, { attributes: { friendly_name: 'Drawer' } }) === 'Drawer' && IC.rowLabel({ entity: 'light.a_b' }, null) === 'A b');
}

// ---- 5. commands -----------------------------------------------------------------
{
  const p = IC.mediaPowerCommand('media_player.demo_tv', true);
  check('command: media power on', p.domain === 'media_player' && p.service === 'turn_on' && p.target.entity_id === 'media_player.demo_tv');
  check('command: media power off', IC.mediaPowerCommand('media_player.demo_tv', false).service === 'turn_off');
  check('command: volume % -> volume_level', IC.mediaVolumeCommand('media_player.x', 37).data.volume_level === 0.37 &&
    IC.mediaVolumeCommand('media_player.x', 140).data.volume_level === 1);
  check('command: source / sound mode', IC.mediaSourceCommand('media_player.x', 'Game').data.source === 'Game' &&
    IC.mediaSoundModeCommand('media_player.x', 'Night').service === 'select_sound_mode');
  const lon = IC.lightRowCommand('light.x', { on: true, bri: 50 });
  // Mutation: forget the * 2.55 -> brightness 50 -> fails.
  check('command: light on at 50% -> brightness 127 (the sidebar rounding)', lon.service === 'turn_on' && lon.data.brightness === 127 && !lon.data.rgb_color, lon);
  check('command: light off', IC.lightRowCommand('light.x', { on: false, bri: 50 }).service === 'turn_off');
  check('command: colour only when asked', JSON.stringify(IC.lightRowCommand('light.x', { on: true, bri: 100, color: '#ff8000' }, true).data.rgb_color) === '[255,128,0]');

  const s0 = { state: 'off', attributes: { volume_level: 0.1 } };
  const s1 = IC.applyCommand(s0, IC.mediaPowerCommand('media_player.x', true));
  check('applyCommand: power on, input not mutated', s1.state === 'on' && s0.state === 'off');
  check('applyCommand: volume', IC.applyCommand(s1, IC.mediaVolumeCommand('media_player.x', 60)).attributes.volume_level === 0.6);
  check('applyCommand: light on with brightness', IC.applyCommand({ state: 'off', attributes: {} }, lon).attributes.brightness === 127);
  check('applyCommand: an unknown command changes nothing', IC.applyCommand(s0, { domain: 'x', service: 'y' }) === s0);
  check('clockText: 24-hour, zero-padded', (() => { const c = IC.clockText(new Date(2026, 0, 5, 7, 4, 9), 'en-GB');
    return c.time === '07:04' && c.seconds === '09' && /5/.test(c.date) && /January/.test(c.date); })());
  check('mock: a receiver sample has sources', IC.mockItemState('media', { role: 'receiver' }, 0).attributes.source_list.length > 0);
  check('mock: readings are numbers, never 0', ['reading', 'humidity'].every(k => +IC.mockItemState(k, {}, 3).state > 0));
}

// ---- 5b. card copy: titles, icon, first-row label ------------------------------
{
  // Mutation: return the whole label from shortLabel -> fails.
  check('shortLabel: an authoring note is cut at the first " ("', IC.shortLabel('Word clock (study, above the desk)') === 'Word clock');
  check('shortLabel: ... or at the first " - "', IC.shortLabel('Panel TV - DRAFT POSITION') === 'Panel TV');
  check('shortLabel: whichever comes first', IC.shortLabel('Wall TV, 50-inch (matte) - DRAFT') === 'Wall TV, 50-inch');
  check('shortLabel: a plain label is kept, nothing -> empty', IC.shortLabel('Sideboard') === 'Sideboard' && IC.shortLabel(undefined) === '');
  // Mutation: separator ' - ' -> '-' cuts 'Hi-fi' at its hyphen -> 'Hi' -> fails.
  check('shortLabel: a hyphen inside a word is not a cut', IC.shortLabel('Hi-fi cabinet (left)') === 'Hi-fi cabinet');
  // Mutation: separator ' (' -> '(' cuts '(spare) shelf' to '' -> fails.
  check('shortLabel: a label that opens with "(" is kept whole', IC.shortLabel('(spare) shelf') === '(spare) shelf');
  // Mutation: prefer the label over card.title -> fails.
  check('cardTitle: the binding title wins', IC.cardTitle({ title: 'Den TV' }, 'Wall TV, 50-inch (matte)', 'tv') === 'Den TV');
  check('cardTitle: no title -> the short label', IC.cardTitle({ title: null }, 'Wall TV, 50-inch (matte)', 'tv') === 'Wall TV, 50-inch');
  check('cardTitle: no label either -> the id humanised', IC.cardTitle({}, null, 'hall_tv') === 'Hall tv');
  const raw = { k_clock: { title: 'Kitchen clock' }, list: [{ title: 'x' }], tv: { media: [] } };
  check('bindingTitle: a title-only binding', IC.bindingTitle(raw, 'k_clock') === 'Kitchen clock');
  check('bindingTitle: a list or no title -> null', IC.bindingTitle(raw, 'list') === null && IC.bindingTitle(raw, 'tv') === null && IC.bindingTitle(null, 'x') === null);
  // Mutation: fall back to the furniture label in clockTitle -> not reachable; a
  // mutation returning 'Clock' always fails the room case.
  // Mutation: drop the lower-casing in roomThingTitle -> 'Home Office clock' -> fails.
  check('clock and radiator titles share one room rule', IC.clockTitle(null, 'Home Office') === 'Home office clock' &&
    IC.radiatorTitle(null, 'Home Office') === 'Home office radiator' && IC.radiatorTitle(null, '') === 'Radiator');
  // Mutation: sentence-case a bound title -> 'Home Office heater' becomes 'Home office heater' -> fails.
  check('a bound title shows exactly as written', IC.radiatorTitle('Home Office heater', 'Home Office') === 'Home Office heater' &&
    IC.clockTitle('The BIG Clock', 'Hall') === 'The BIG Clock');
  check('clockTitle: binding title, else "<Room> clock", else "Clock"', IC.clockTitle('Gold clock', 'Office') === 'Gold clock' &&
    IC.clockTitle(null, 'Office') === 'Office clock' && IC.clockTitle(null, '') === 'Clock');
  const items = IC.normaliseItemBindings({ k_clock: { title: 'Kitchen clock' } });
  check('a title-only binding is not a card: the clock stays a clock', !items.has('k_clock') &&
    IC.furnitureTapTarget({ id: 'k_clock', type: 'wall-clock', room: 'kitchen' }, null, { items }).kind === 'clock');
  const card = media => ({ media: media.map(role => ({ entity: 'media_player.demo_x', role })), lights: [], readings: [] });
  // Mutation: always return 'tv' for a media card -> fails.
  check('cardIcon: a receiver card gets the speaker', IC.cardIcon(card(['receiver', 'cast'])) === 'speaker');
  check('cardIcon: speaker / cast / tv / no role', IC.cardIcon(card(['speaker'])) === 'speaker' && IC.cardIcon(card(['cast'])) === 'cast' &&
    IC.cardIcon(card(['tv', 'cast'])) === 'tv' && IC.cardIcon(card([null])) === 'tv');
  check('cardIcon: lights -> bulb, readings -> thermometer', IC.cardIcon({ media: [], lights: [{}], readings: [] }) === 'bulb' &&
    IC.cardIcon({ media: [], lights: [], readings: [{}] }) === 'thermometer');
  // Mutation: return the label unchanged -> 'TV' under 'TV' -> fails.
  check('first row: a label equal to the title becomes its role', IC.rowLabelUnderTitle('Soundbar', 'soundbar', 'receiver', 'media') === 'Receiver');
  check('first row: a TV under a "TV" title reads Television', IC.rowLabelUnderTitle('TV', 'TV', 'tv', 'media') === 'Television');
  check('first row: a different label is kept', IC.rowLabelUnderTitle('TV', 'Living room', 'tv', 'media') === 'TV');
  check('first row: no role -> the kind', IC.rowLabelUnderTitle('Lamp', 'Lamp', null, 'light') === 'Light');
}

// ---- 6. markup -------------------------------------------------------------------
{
  const T = await imp('src/tap-popovers.js');
  const dot = k => '<i data-st="' + k + '"></i>';
  const F = IC.MEDIA_FEATURE;
  const recv = IC.mediaRowModel({ state: 'on', attributes: { supported_features: F.VOLUME_SET | F.TURN_ON | F.TURN_OFF | F.SELECT_SOURCE | F.SELECT_SOUND_MODE,
    volume_level: 0.3, source: 'TV', source_list: ['TV', 'Game'], sound_mode: 'Stereo', sound_mode_list: ['Stereo', 'Night'] } });
  const model = haOff => ({ name: 'Console', status: 'ok', haOff,
    media: [Object.assign({ label: 'Receiver', role: 'receiver' }, recv)],
    lights: [Object.assign({ label: 'Top' }, IC.lightRowModel({ state: 'on', attributes: { brightness: 255 } }, false))],
    readings: [Object.assign({ label: 'Box' }, IC.readingRowModel({ state: 'unavailable' }))] });
  const on = T.popoverHtml.item(model(false), dot), offl = T.popoverHtml.item(model(true), dot);
  const controls = h => h.match(/<(button class="tp-sw|input|select)[^>]*>/g) || [];
  check('card: power, volume, source, sound mode, light power and brightness', controls(on).length === 6 &&
    /data-a="mpower"/.test(on) && /data-a="mvol"/.test(on) && /data-a="msrc"/.test(on) && /data-a="mmode"/.test(on) &&
    /data-a="lpower"/.test(on) && /data-a="lbri"/.test(on), controls(on));
  check('card: every control enabled while connected', controls(on).every(c => !/\sdisabled\b/.test(c)), controls(on));
  // Mutation: drop `(off ? ' disabled' : '')` from any control -> fails.
  check('card: every control DISABLED while HA offline', controls(offl).length === 6 && controls(offl).every(c => /\sdisabled\b/.test(c)),
    controls(offl).filter(c => !/\sdisabled\b/.test(c)));
  check('card: HA offline line only while offline', /data-offline>HA offline</.test(offl) && !/data-offline/.test(on));
  check('card: the current source is selected', /<option value="TV" selected>/.test(on));
  // Mutation: drop the caption span from select() -> fails.
  check('card: each picker has a visible caption in its <label>', /<label class="tp-selw"><span>Source<\/span><select[^>]*data-a="msrc"/.test(on) &&
    /<label class="tp-selw"><span>Sound mode<\/span><select[^>]*data-a="mmode"/.test(on), on);
  const iconOf = h => (h.match(/<div class="tp-head"><svg[^>]*><path d="([^"]+)"/) || [])[1];
  const ICONS = (await imp('src/ui-icons.js')).ICONS;
  check('card: the header icon is the model icon', iconOf(T.popoverHtml.item(Object.assign(model(false), { icon: 'speaker' }), dot)) === ICONS.speaker);
  check('card: an offline reading says Offline, no number', /<b>Offline<\/b>/.test(on));
  const tv = T.popoverHtml.item({ name: 'TV', status: 'ok', haOff: false, lights: [], readings: [],
    media: [Object.assign({ label: 'Television', role: 'tv' }, IC.mediaRowModel({ state: 'off', attributes: { supported_features: F.TURN_ON | F.TURN_OFF } }))] }, dot);
  check('card: an off TV -- a power switch, no volume', /data-a="mpower"[^>]*aria-checked="false"/.test(tv) && !/data-a="mvol"/.test(tv) && !/\sdisabled/.test(tv), tv);
  const tvRow = extra => Object.assign({ label: 'Television', role: 'tv' },
    IC.mediaRowModel({ state: 'on', attributes: Object.assign({ supported_features: F.VOLUME_SET | F.TURN_ON | F.TURN_OFF }, extra) }));
  const unk = T.popoverHtml.item({ name: 'TV', status: 'ok', haOff: false, lights: [], readings: [], media: [tvRow({})] }, dot);
  const volInput = h => (h.match(/<input[^>]*data-a="mvol"[^>]*>/) || [''])[0];
  // Mutation: drop the volumeUnknown branch -> no slider at all -> fails; render it as value="0" -> fails.
  check('card: an unreported volume is an indeterminate slider, not 0', /data-vol-unknown/.test(unk) && /class="tp-range unknown"/.test(volInput(unk)) &&
    /aria-valuetext="Unknown"/.test(volInput(unk)) && !/value="0"/.test(volInput(unk)), volInput(unk));
  const known = T.popoverHtml.item({ name: 'TV', status: 'ok', haOff: false, lights: [], readings: [], media: [tvRow({ volume_level: 0.25 })] }, dot);
  check('card: a reported volume is an ordinary slider at its level', /value="25"/.test(volInput(known)) && !/unknown/.test(volInput(known)) &&
    !/data-vol-unknown/.test(known), volInput(known));
  const unkOff = T.popoverHtml.item({ name: 'TV', status: 'ok', haOff: true, lights: [], readings: [], media: [tvRow({})] }, dot);
  check('card: the unknown-volume slider is disabled while HA is offline', /\sdisabled\b/.test(volInput(unkOff)), volInput(unkOff));
  const esc = T.popoverHtml.item({ name: '<b>x</b>', status: 'ok', haOff: false, media: [], lights: [],
    readings: [Object.assign({ label: '<img>' }, IC.readingRowModel({ state: '20', attributes: {} }))] }, dot);
  check('card: names are escaped', esc.indexOf('<img>') === -1 && esc.indexOf('<b>x</b>') === -1);
  const clock = T.popoverHtml.clock({ name: 'Kitchen clock', time: '07:04', seconds: '09', date: 'Monday 5 January 2026' });
  check('clock card: time, seconds and date, no controls', /<b data-time>07:04<\/b><small data-sec>:09<\/small>/.test(clock) && /Monday 5 January 2026/.test(clock) &&
    !/<(button|input|select)\b/.test(clock), clock);
}

// ---- 7. the client, against the fake HA ------------------------------------------
{
  const { HAClient } = await imp('src/ha-client.js');
  const st = (entity_id, state, attributes) => ({ entity_id, state: String(state), attributes: attributes || {}, last_changed: '', last_updated: '' });
  const states = [st('light.demo_bedside_top', 'on', { brightness: 200 }), st('sensor.demo_a_temperature', '36.5', { unit_of_measurement: '°C' }),
    st('media_player.demo_tv', 'off'), st('sensor.demo_unrelated', '5')];
  const fake = installFakeHA({ states });
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, wsReconnectMs: 15,
      sensors: { items: {
        bedside: { lights: [{ entity: 'light.demo_bedside_top' }] },
        console: CONSOLE,
        tv: { media: [{ entity: 'media_player.demo_tv' }] },
      } } });
    ha.connect();
    await fake.whenConnected(ha);
    // Mutation: drop `itemEntityIds.has(...)` from noteRaw -> null -> fails.
    check('client: an item light\'s raw state is recorded', (ha.getRawState('light.demo_bedside_top') || {}).state === 'on');
    check('client: an item reading and media player too', (ha.getRawState('sensor.demo_a_temperature') || {}).state === '36.5' &&
      (ha.getRawState('media_player.demo_tv') || {}).state === 'off');
    check('client: an unbound entity is not', ha.getRawState('sensor.demo_unrelated') === null);
    fake.sockets[fake.sockets.length - 1].emitStateChanged(st('media_player.demo_tv', 'on'));
    await sleep(10);
    check('client: a live change updates the raw state', ha.getRawState('media_player.demo_tv').state === 'on');
    // The card sends through the client exactly like this (tap-popovers.js itemSend).
    const c = IC.lightRowCommand('light.demo_bedside_top', { on: true, bri: 40 });
    ha.callServiceDebounced(c.domain, c.service, c.data, c.target, 'item:light:light.demo_bedside_top', 0);
    const off = IC.lightRowCommand('light.demo_bedside_top', { on: false });
    ha.callServiceDebounced(off.domain, off.service, off.data, off.target, 'item:light:light.demo_bedside_top', 0);
    await sleep(10);
    const calls = fake.calls;
    check('client: the light row\'s commands reach HA as light.turn_on / turn_off', calls.length === 2 &&
      calls[0].service === 'light/turn_on' && calls[0].body.brightness === 102 && calls[0].body.entity_id === 'light.demo_bedside_top' &&
      calls[1].service === 'light/turn_off', calls);
    check('client: nothing over REST', fake.fetches.length === 0);
    ha.disconnect();
  } finally {
    console.log = log; console.warn = warn;
    fake.restore();
  }
}

// ---- 8. the demo house -----------------------------------------------------------
{
  const read = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  const rooms = read('houses/demo/rooms.json'), geo = read('houses/demo/geometry.json');
  const items = IC.normaliseItemBindings(rooms.sensors && rooms.sensors.items);
  const byId = new Map((geo.furniture || []).map(f => [f.id, f]));
  const raw = (rooms.sensors && rooms.sensors.items) || {};
  check('demo: every sensors.items id is a furniture item', Object.keys(raw).length > 0 && Object.keys(raw).every(id => byId.has(id)), Object.keys(raw));
  check('demo: no binding was dropped by normalisation', Object.keys(raw).every(id => items.has(id) &&
    items.get(id).length === (Array.isArray(raw[id]) ? raw[id].length : 1)));
  const cards = [...items.values()].flat();
  check('demo: media, lights, readings and a region card are all bound', cards.some(c => c.media.length) && cards.some(c => c.lights.length) &&
    cards.some(c => c.readings.length) && cards.some(c => c.region) && cards.some(c => c.media.some(m => m.role === 'receiver')));
  const climate = (rooms.sensors && rooms.sensors.climate) || {};
  check('demo: a wall clock and a radiator in a climate-bound room', (geo.furniture || []).some(f => f.type === 'wall-clock') &&
    (geo.furniture || []).some(f => f.type === 'radiator' && typeof climate[f.room] === 'string'));
  const ver = String(rooms.schemaVersion).split('.').map(Number);
  check('demo: rooms.json declares at least 1.8 (sensors.items with switches)', ver[0] > 1 || (ver[0] === 1 && ver[1] >= 8), rooms.schemaVersion);
  check('demo: a switches card with a power partner is bound', cards.some(c => c.switches.length && c.switches.some(w => w.power)));
}

// ---- 9. the card wiring (pure parts of src/tap-popovers.js) --------------------------
{
  const T = await imp('src/tap-popovers.js');
  const tpSrc = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  const VP = await imp('src/vacuum-control.js'), PP = await imp('src/plant-status.js');
  const vacuums = VP.normaliseVacuumBindings({ robo: { entity: 'vacuum.demo_robo' } });
  const plants = PP.normalisePlantBindings({ fern: { moisture: 'sensor.demo_fern_moisture' } });
  // The same ids also carry an item binding: the vacuum / plant must win.
  const TVB = { media: [{ entity: 'media_player.demo_tv', role: 'tv' }] }, LAMP = { title: 'Lamp', lights: [{ entity: 'light.demo_lamp' }] };
  const rawItems = { robo: TVB, fern: LAMP, tv: TVB, kclock: { title: 'Kitchen Wall Clock' }, rad: { title: 'Radiator by the Window' } };
  const items = IC.normaliseItemBindings(rawItems);
  const ctx = { vacuums, plants, items, climate: { den: 'climate.demo_den' }, rawItems };
  const obj = { name: 'mesh' };
  const at = it => T.furnitureTarget(it, { x: 0, y: 0, z: 0 }, obj, ctx);
  // Mutation: ask furnitureTapTarget before deviceTarget -> 'item' -> fails.
  check('target: a vacuum binding beats an item binding on the same id', (at({ id: 'robo', type: 'cabinet' }) || {}).kind === 'vacuum');
  check('target: a plant binding beats an item binding on the same id', (at({ id: 'fern', type: 'cabinet' }) || {}).kind === 'plant');
  check('target: an item binding alone is an item card', (at({ id: 'tv', type: 'tv' }) || {}).kind === 'item');
  check('target: the hit mesh rides along', at({ id: 'tv', type: 'tv' }).object === obj && at({ id: 'robo' }).object === obj);
  const clk = at({ id: 'kclock', type: 'wall-clock', room: 'kitchen' });
  // Mutation: drop `t.room = it.room` -> no room -> fails; drop the bindingTitle lookup -> no label -> fails.
  check('target: a clock carries its room', clk && clk.kind === 'clock' && clk.room === 'kitchen', clk);
  check('target: a title-only clock binding becomes its label', clk && clk.label === 'Kitchen Wall Clock', clk);
  const rad = at({ id: 'rad', type: 'radiator', room: 'den' });
  check('target: a title-only radiator binding becomes its label', rad && rad.kind === 'climate' && rad.id === 'den' && rad.label === 'Radiator by the Window', rad);
  check('target: no title -> no label', at({ id: 'other_clock', type: 'wall-clock', room: 'hall' }).label === undefined);
  check('target: nothing bound, nothing typed -> null', at({ id: 'chair', type: 'chair' }) === null && T.furnitureTarget(null, null, obj, ctx) === null);

  const roomName = id => ({ kitchen: 'Kitchen', den: 'Home Den' }[id] || id);
  // Mutation: clockCardName ignores t.label -> 'Kitchen clock' -> fails.
  check('clock title: the bound title exactly as written', T.clockCardName(clk, roomName) === 'Kitchen Wall Clock');
  check('clock title: no binding -> "<Room> clock" from the target room', T.clockCardName({ room: 'kitchen' }, roomName) === 'Kitchen clock' &&
    T.clockCardName({}, roomName) === 'Clock');
  // Mutation (the review's): radiatorTitle(null, ...) -> 'Home den radiator' -> fails.
  check('climate title: the bound title exactly as written', T.climateCardName(rad, roomName) === 'Radiator by the Window');
  check('climate title: no binding -> "<Room> radiator" from the room id', T.climateCardName({ id: 'den' }, roomName) === 'Home den radiator');

  const tvCard = items.get('tv')[0];
  const rows = { media: [{ label: 'TV', role: 'tv' }], lights: [], readings: [] };
  const head = T.itemCardHead(tvCard, rows, 'TV (matte) - DRAFT', 'tv');
  // Mutation: drop the relabel line -> 'TV' under 'TV' -> fails.
  check('item head: the short label is the title, the lead row is relabelled', head.name === 'TV' && rows.media[0].label === 'Television' && head.icon === 'tv', [head, rows]);
  const lrows = { media: [], lights: [{ label: 'Bedside' }, { label: 'Bedside' }], readings: [] };
  T.itemCardHead({ title: 'Bedside', media: [], lights: [{}], readings: [] }, lrows, null, 'b');
  check('item head: only the LEAD row is relabelled', lrows.lights[0].label === 'Light' && lrows.lights[1].label === 'Bedside', lrows);
  check('item head: a binding title wins over the label', T.itemCardHead({ title: 'Den TV', media: [], lights: [], readings: [] }, {}, 'TV', 'tv').name === 'Den TV');

  // Wiring: the runtime calls these, and nothing else, for the same answers.
  check('wiring: deviceAt is furnitureTarget', /return it \? furnitureTarget\(it, h\.point, h\.object, deviceCtx\) : null;/.test(tpSrc));
  check('wiring: the climate card title is climateCardName', /name: climateCardName\(t, roomName\) \};/.test(tpSrc));
  check('wiring: the clock card title is clockCardName', /name: clockCardName\(t, roomName\) \}, clockText\(new Date\(\)\)/.test(tpSrc));
  check('wiring: the item card head is itemCardHead', /const head = itemCardHead\(card, \{ media, lights, switches, readings, cameras \}, furnitureLabels\.get\(t\.itemId\), t\.itemId\);/.test(tpSrc) &&
    /name: head\.name, icon: head\.icon, media, lights, switches, readings, cameras \};/.test(tpSrc));

  // The item sender's gates.
  const cmd = IC.mediaPowerCommand('media_player.demo_tv', true);
  const mk = over => {
    const log = { calls: [], mock: [], opt: [] };
    const d = Object.assign({ writeBlocked: () => false, canSend: () => true, mockMode: () => false,
      ha: () => ({ callServiceDebounced: (...a) => log.calls.push(a) }), getRaw: () => ({ state: 'off', attributes: {} }),
      setMock: (e, r) => log.mock.push([e, r]), setOptimistic: (e, r) => log.opt.push([e, r]) }, over);
    return { send: T.createItemSender(d), log };
  };
  let x = mk({});
  x.send(cmd, 'power', 0);
  check('item sender: connected -> one call and an optimistic state', x.log.calls.length === 1 && x.log.calls[0][1] === 'turn_on' &&
    x.log.calls[0][4] === 'item:power:media_player.demo_tv' && x.log.opt.length === 1 && x.log.opt[0][1].state === 'on', x.log);
  x = mk({ canSend: () => false });
  x.send(cmd, 'power', 0);
  // Mutation: delete `if (!d.canSend()) return;` -> a call goes out -> fails.
  check('item sender: canSend false -> nothing sent, nothing optimistic', x.log.calls.length === 0 && x.log.opt.length === 0 && x.log.mock.length === 0, x.log);
  x = mk({ writeBlocked: () => true, mockMode: () => true });
  x.send(cmd, 'power', 0);
  check('item sender: writeBlocked -> nothing at all, not even the sample', x.log.calls.length === 0 && x.log.mock.length === 0 && x.log.opt.length === 0, x.log);
  x = mk({ mockMode: () => true, canSend: () => false });
  x.send(cmd, 'power', 0);
  check('item sender: no HA configured -> the sample moves, nothing sent', x.log.mock.length === 1 && x.log.mock[0][1].state === 'on' && x.log.calls.length === 0, x.log);

  // The clock ticks without a rebuild.
  const clockView = { sig: T.clockTick.sig, patch: T.clockTick.patch };
  const m1 = { name: 'Kitchen clock', time: '07:04', seconds: '09', date: 'Monday' };
  const m2 = Object.assign({}, m1, { seconds: '10' });
  const first = T.repaintAction(clockView, m1, null, false, true, false);
  const tick = T.repaintAction(clockView, m2, first.sig, false, false, false);
  // Mutation: sig includes the time (or drop sig) -> 'rebuild' every second -> fails.
  check('clock: a tick patches, never rebuilds', first.action === 'rebuild' && tick.action === 'patch', [first, tick]);
  check('clock: a new title rebuilds', T.repaintAction(clockView, Object.assign({}, m2, { name: 'Hall clock' }), first.sig, false, false, false).action === 'rebuild');
  check('repaint: a view with no sig rebuilds on any change, else nothing', T.repaintAction({}, { a: 2 }, JSON.stringify({ a: 1 }) + false, false, false, false).action === 'rebuild' &&
    T.repaintAction({}, { a: 1 }, JSON.stringify({ a: 1 }) + false, false, false, false).action === 'none');
  check('repaint: never under a drag unless forced', T.repaintAction({}, { a: 2 }, 'x', false, false, true).action === 'none' &&
    T.repaintAction({}, { a: 2 }, 'x', false, true, true).action === 'rebuild');
  const nodes = { '[data-time]': { textContent: '07:04' }, '[data-sec]': { textContent: ':09' }, '[data-date]': { textContent: 'Monday' } };
  T.clockTick.patch({ querySelector: q => nodes[q] || null }, { time: '07:05', seconds: '00', date: 'Tuesday' });
  check('clock: the patch rewrites the time, seconds and date text', nodes['[data-time]'].textContent === '07:05' &&
    nodes['[data-sec]'].textContent === ':00' && nodes['[data-date]'].textContent === 'Tuesday', nodes);
  check('wiring: render goes through repaintAction and the view\'s patch', /const next = repaintAction\(v, m, pop\.sig, tipOpen, force, pop\.ctl\.dragging\);\s*if \(next\.action === 'patch'\) v\.patch\(pop\.el, m\);\s*if \(next\.action !== 'rebuild'\) return;/.test(tpSrc));
  check('wiring: the clock view carries clockTick', /sig: clockTick\.sig,\s*patch: clockTick\.patch,/.test(tpSrc));
}

// ---- 10. a light row's power switch -------------------------------------------
{
  const offRow = IC.lightRowModel({ state: 'off', attributes: {} });
  const on = IC.lightRowToggleCommand('light.demo_bedside', offRow);
  // Mutation: pass the row's bri through (the old { on, bri: r.bri }) -> brightness 255 -> fails.
  check('light switch: off -> turn_on with NO brightness (HA restores the last level)', on.service === 'turn_on' && !('brightness' in on.data) &&
    on.target.entity_id === 'light.demo_bedside', on);
  check('light switch: on -> turn_off', IC.lightRowToggleCommand('light.demo_bedside', IC.lightRowModel({ state: 'on', attributes: { brightness: 40 } })).service === 'turn_off');
  check('light slider: still sends its brightness', IC.lightRowCommand('light.demo_bedside', { on: true, bri: 40 }).data.brightness === 102);
  const tpSrc = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  check('wiring: the item card switch sends lightRowToggleCommand', /itemSend\(lightRowToggleCommand\(card\.lights\[i\]\.entity, r\), 'light', 0\)/.test(tpSrc) &&
    !/lightRowCommand\(card\.lights\[i\]\.entity, \{ on: !r\.on/.test(tpSrc));
  check('wiring: the item card slider sends its value as brightness', /itemSend\(lightRowCommand\(card\.lights\[i\]\.entity, \{ on: true, bri: \+r\.value \}\), 'light', 200\)/.test(tpSrc));
  const after = IC.applyCommand({ state: 'off', attributes: { brightness: 90 } }, on);
  check('light switch: the optimistic state keeps the known level', after.state === 'on' && after.attributes.brightness === 90, after);
}

// ---- 11. switches rows ---------------------------------------------------------
{
  const T = await imp('src/tap-popovers.js');
  const tpSrc = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  const card = IC.normaliseCard({ title: 'Desk', switches: [
    { entity: 'switch.demo_desk_a', label: 'Monitor', power: 'sensor.demo_desk_a_power' },
    { entity: 'input_boolean.demo_desk_b', power: 'light.demo_wrong' },
    { entity: 'light.demo_not_a_switch' }] }, 0);
  // Mutation: drop 'input_boolean' from SWITCH_DOMAINS -> 1 row -> fails; accept any domain -> 3 rows -> fails.
  check('switches: switch and input_boolean rows kept, a light dropped', card && card.switches.length === 2 &&
    card.switches[0].power === 'sensor.demo_desk_a_power' && card.switches[1].power === null, card);
  check('switches: a card of only switches is a card', !!IC.normaliseCard({ switches: [{ entity: 'switch.demo_x' }] }));
  check('switches: the card reads the switch and its power sensor', IC.cardEntities(card).join() === 'switch.demo_desk_a,sensor.demo_desk_a_power,input_boolean.demo_desk_b');
  const on = IC.switchRowModel({ state: 'on', attributes: {} }, { state: '41.53', attributes: { unit_of_measurement: 'W' } });
  // Mutation: drop the power text -> null -> fails.
  check('switch row: on, with the live draw to one decimal', on.on && !on.na && on.stateText === 'On' && on.power === '41.5 W', on);
  check('switch row: off at 0 W reads 0.0 W (a real reading)', IC.switchRowModel({ state: 'off' }, { state: '0', attributes: {} }).power === '0.0 W');
  const offPow = IC.switchRowModel({ state: 'on', attributes: {} }, { state: 'unavailable', attributes: { unit_of_measurement: 'W' } });
  // Mutation: Number(state) || 0 -> '0.0 W' -> fails.
  check('switch row: an offline power sensor shows nothing, never 0 W', offPow.power === null && offPow.on, offPow);
  check('switch row: no partner -> no power', IC.switchRowModel({ state: 'off', attributes: {} }, null).power === null);
  const un = IC.switchRowModel({ state: 'unavailable', attributes: {} }, null);
  check('switch row: unavailable -> Offline', un.na && !un.on && un.stateText === 'Offline');
  const c1 = IC.switchCommand('switch.demo_desk_a', true), c2 = IC.switchCommand('input_boolean.demo_desk_b', false);
  // Mutation: hard-code the 'switch' domain -> input_boolean fails.
  check('switch command: its own domain, turn_on / turn_off', c1.domain === 'switch' && c1.service === 'turn_on' && c1.target.entity_id === 'switch.demo_desk_a' &&
    c2.domain === 'input_boolean' && c2.service === 'turn_off', [c1, c2]);
  check('applyCommand: a switch goes on and off', IC.applyCommand({ state: 'off', attributes: {} }, c1).state === 'on' &&
    IC.applyCommand({ state: 'on', attributes: {} }, c2).state === 'off');
  check('cardIcon: a switches card is a plug', IC.cardIcon(card) === 'plug');
  const rows = { media: [], lights: [], switches: [{ label: 'Desk' }], readings: [{ label: 'x' }] };
  T.itemCardHead({ title: 'Desk', media: [], lights: [], switches: [{}], readings: [{}] }, rows, null, 'd');
  check('item head: a switch can be the lead row', rows.switches[0].label === 'Switch' && rows.readings[0].label === 'x', rows);
  const dot = () => '';
  const sw = (extra, haOff) => T.popoverHtml.item({ name: 'Desk', status: 'ok', haOff: !!haOff, media: [], lights: [], readings: [],
    switches: [Object.assign({ label: 'Monitor' }, extra)] }, dot);
  const hOn = sw(on), hOff = sw(on, true), hNoPow = sw(IC.switchRowModel({ state: 'off', attributes: {} }, null));
  check('switch markup: a switch control, on, with the draw beside it', /data-a="spower" data-i="0" role="switch" aria-checked="true"/.test(hOn) &&
    /data-power[^>]*>.*41\.5 W<\/span>/.test(hOn) && !/\sdisabled/.test(hOn), hOn);
  check('switch markup: disabled while HA is offline', /data-a="spower"[^>]*\sdisabled/.test(hOff));
  check('switch markup: no power span with no reading', !/data-power/.test(hNoPow) && /aria-checked="false"/.test(hNoPow));
  check('switch markup: an unavailable switch is disabled', /data-a="spower"[^>]*\sdisabled/.test(sw(un)));
  check('wiring: the switch sends switchCommand through itemSend', /itemSend\(switchCommand\(card\.switches\[i\]\.entity, !r\.on\), 'switch', 0\)/.test(tpSrc));
  check('wiring: the item model builds switch rows from switchRowModel', /switchRowModel\(r, pr\)/.test(tpSrc) &&
    /name: head\.name, icon: head\.icon, media, lights, switches, readings, cameras \};/.test(tpSrc));

  // The client records a switch and its power sensor; a toggle reaches HA.
  const { HAClient } = await imp('src/ha-client.js');
  const st = (entity_id, state, attributes) => ({ entity_id, state: String(state), attributes: attributes || {}, last_changed: '', last_updated: '' });
  const fake = installFakeHA({ states: [st('switch.demo_desk_a', 'off'), st('sensor.demo_desk_a_power', '12.5', { unit_of_measurement: 'W' })] });
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, wsReconnectMs: 15,
      sensors: { items: { desk: { switches: [{ entity: 'switch.demo_desk_a', power: 'sensor.demo_desk_a_power' }] } } } });
    ha.connect();
    await fake.whenConnected(ha);
    check('client: a switch and its power sensor are recorded', (ha.getRawState('switch.demo_desk_a') || {}).state === 'off' &&
      (ha.getRawState('sensor.demo_desk_a_power') || {}).state === '12.5');
    const c = IC.switchCommand('switch.demo_desk_a', true);
    ha.callServiceDebounced(c.domain, c.service, c.data, c.target, 'item:switch:switch.demo_desk_a', 0);
    await sleep(10);
    check('client: the toggle reaches HA as switch.turn_on', fake.calls.length === 1 && fake.calls[0].service === 'switch/turn_on' &&
      fake.calls[0].body.entity_id === 'switch.demo_desk_a', fake.calls);
    ha.disconnect();
  } finally {
    console.log = log; console.warn = warn;
    fake.restore();
  }
}

// ---- 12. the curtains card -------------------------------------------------------
{
  const T = await imp('src/tap-popovers.js');
  const tpSrc = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  const curtains = [{ id: 'lr_sheer', name: 'Living sheer', room: 'living' }, { id: 'lr_curtain', name: 'Living curtain', room: 'living' },
    { id: 'lr_spare', name: 'Spare', room: 'living' }, { id: 'bed_curtain', name: 'Bed curtain', room: 'bed' }, { id: 'loose', name: 'Loose' }];
  const covers = { lr_sheer: ['cover.demo_lr_sheer'], lr_curtain: ['cover.demo_lr_a', 'cover.demo_lr_b'], bed_curtain: ['cover.demo_bed'], loose: ['cover.demo_loose'] };
  const cornice = { lr_curtain: ['light.demo_lr_cornice'], bed_curtain: ['light.demo_bed_cornice'] };
  const g = T.curtainRoomGroup('lr_sheer', curtains, covers, cornice);
  // Mutation: members = only the tapped curtain -> one cover -> fails.
  check('curtains card: every bound cover in the room, profile order', g.room === 'living' && g.covers.map(c => c.id).join() === 'lr_sheer,lr_curtain' &&
    g.covers[1].entities.length === 2, g);
  // Mutation: lights from the tapped curtain only -> none (the sheer has none) -> fails.
  check('curtains card: the room\'s cornice light, whichever curtain was tapped', g.lights.length === 1 && g.lights[0].id === 'lr_curtain' &&
    g.lights[0].entities[0] === 'light.demo_lr_cornice', g.lights);
  const b = T.curtainRoomGroup('bed_curtain', curtains, covers, cornice);
  check('curtains card: a one-curtain room is the same card, one cover and its light', b.covers.length === 1 && b.lights.length === 1 && b.room === 'bed');
  const l = T.curtainRoomGroup('loose', curtains, covers, cornice);
  check('curtains card: a curtain with no room is its own card', l.room === null && l.covers.length === 1 && l.covers[0].id === 'loose' && !l.lights.length);
  check('curtains card: the entity lists are copies', (g.covers[1].entities.push('x'), covers.lr_curtain.length === 2));
  check('curtains card title: "<Room> curtains", else the curtain', T.curtainCardTitle('Living Room', 'x') === 'Living room curtains' &&
    T.curtainCardTitle('', 'Loose curtain') === 'Loose curtain');

  const pw = T.corniceCommand(['light.demo_a', 'light.demo_b'], { on: true, bri: 40 }, true);
  // Mutation: pass `power: false` -> brightness 102 -> fails.
  check('cornice switch: turn_on with NO brightness, to every cornice entity', pw.domain === 'light' && pw.service === 'turn_on' &&
    !('brightness' in pw.data) && pw.target.entity_id.join() === 'light.demo_a,light.demo_b', pw);
  check('cornice slider: sends its brightness', T.corniceCommand(['light.demo_a'], { on: true, bri: 40 }, false).data.brightness === 102);
  check('cornice off: turn_off', T.corniceCommand(['light.demo_a'], { on: false }, true).service === 'turn_off');
  const mk = over => {
    const log = { calls: [], previews: [] };
    const d = Object.assign({ writeBlocked: () => false, canSend: () => true,
      ha: () => ({ callServiceDebounced: (...a) => log.calls.push(a) }), preview: (...a) => log.previews.push(a) }, over);
    return { send: T.createCorniceSender(d), log };
  };
  let x = mk({});
  x.send('lr_curtain', ['light.demo_lr_cornice'], { on: true }, true, 0);
  check('cornice sender: connected -> preview then one call under cornice-<id>', x.log.previews.length === 1 && x.log.calls.length === 1 &&
    x.log.calls[0][0] === 'light' && x.log.calls[0][1] === 'turn_on' && !('brightness' in x.log.calls[0][2]) && x.log.calls[0][4] === 'cornice-lr_curtain' &&
    x.log.calls[0][5] === 0, x.log);
  x = mk({ canSend: () => false });
  x.send('lr_curtain', ['light.demo_lr_cornice'], { on: true, bri: 30 }, false, 200);
  // Mutation: delete `if (!d.canSend()) return;` -> a call -> fails.
  check('cornice sender: no connected client -> a preview only, nothing sent', x.log.previews.length === 1 && x.log.calls.length === 0, x.log);
  x = mk({ writeBlocked: () => true });
  x.send('lr_curtain', ['light.demo_lr_cornice'], { on: true }, true, 0);
  // Mutation: delete the writeBlocked line -> preview + call -> fails.
  check('cornice sender: HA offline -> nothing at all', x.log.previews.length === 0 && x.log.calls.length === 0, x.log);

  const dot = () => '';
  const m = haOff => ({ name: 'Living room curtains', status: 'ok', haOff,
    lights: [{ id: 'lr_curtain', label: 'Living curtain light', na: false, on: true, bri: 60 }],
    covers: [{ id: 'lr_sheer', label: 'Living sheer', na: false, pct: 30 }, { id: 'lr_curtain', label: 'Living curtain', na: true, pct: 0 }] });
  const h = T.popoverHtml.curtain(m(false), dot), hOff = T.popoverHtml.curtain(m(true), dot);
  check('curtains markup: the light first, then the covers', h.indexOf('data-row="cornice"') > -1 && h.indexOf('data-row="cornice"') < h.indexOf('data-row="cover"') &&
    (h.match(/data-row="cover"/g) || []).length === 2, h);
  check('curtains markup: each cover its own slider and buttons, keyed by curtain', /data-a="pos" data-c="lr_sheer"[^>]*value="30"/.test(h) &&
    /data-a="close" data-c="lr_sheer"/.test(h) && /data-a="open" data-c="lr_sheer"/.test(h), h);
  check('curtains markup: a cover whose motor is down says so, no slider, buttons disabled', /Motor unavailable/.test(h) &&
    !/data-a="pos" data-c="lr_curtain"/.test(h) && /data-a="open" data-c="lr_curtain"[^>]*\sdisabled/.test(h), h);
  check('curtains markup: the cornice light has its switch and brightness', /data-a="cpower" data-c="lr_curtain"[^>]*aria-checked="true"/.test(h) &&
    /data-a="cbri" data-c="lr_curtain"[^>]*value="60"/.test(h));
  const ctl = html => (html.match(/<(button class="tp-(sw|ib)|input)[^>]*>/g) || []);
  check('curtains markup: every control disabled while HA is offline', ctl(hOff).length === 7 && ctl(hOff).every(c => /\sdisabled\b/.test(c)), ctl(hOff));
  check('wiring: the curtain view is built from curtainRoomGroup', /const curtainGroup = t => curtainRoomGroup\(t\.id, o\.house && o\.house\.curtains, bindings\.curtains, corniceBindings\);/.test(tpSrc) &&
    /const rn = g\.room \? roomName\(g\.room\) : '';/.test(tpSrc) &&
    /name: curtainCardTitle\(rn, curtainNames\.get\(t\.id\) \|\| t\.id\), lights, covers \};/.test(tpSrc));
  // Mutation: the switch passes `false` (not a power switch) -> fails.
  check('wiring: the cornice switch is a power switch, the slider is not', /sendCornice\(l\.id, l\.entities, \{ on: !st\.on \}, true, 0\);/.test(tpSrc) &&
    /sendCornice\(l\.id, l\.entities, \{ on: true, bri: \+r\.value \}, false, 200\);/.test(tpSrc));
  check('wiring: covers go through the sidebar sender, per curtain', /sender\.input\(id, pct\)/.test(tpSrc) && /sender\.commit\(id, \+r\.value\)/.test(tpSrc) &&
    /sender\.press\(cv\.id, o\.HAClient\.coverOpenCloseCommand\(cmd, cv\.entities\)\)/.test(tpSrc));

  // The client records a cornice light's raw state (the row's 'unavailable').
  const { HAClient } = await imp('src/ha-client.js');
  const st = (entity_id, state, attributes) => ({ entity_id, state: String(state), attributes: attributes || {}, last_changed: '', last_updated: '' });
  const fake = installFakeHA({ states: [st('light.demo_lr_cornice', 'unavailable')] });
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, wsReconnectMs: 15,
      sensors: { corniceLights: { lr_curtain: ['light.demo_lr_cornice'] } } });
    ha.connect();
    await fake.whenConnected(ha);
    // Mutation: drop `!fittingIndex.has(...)` from noteRaw -> null -> fails.
    check('client: a cornice light\'s raw state is recorded', (ha.getRawState('light.demo_lr_cornice') || {}).state === 'unavailable');
    ha.disconnect();
  } finally {
    console.log = log; console.warn = warn;
    fake.restore();
  }
}

// ---- 13. last-known level --------------------------------------------------------
{
  const T = await imp('src/tap-popovers.js');
  const tpSrc = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  // The review's case: an off light (HA reports brightness null), switched on.
  const offRaw = { state: 'off', attributes: { brightness: null } };
  const after = IC.applyCommand(offRaw, IC.lightRowToggleCommand('light.demo_x', IC.lightRowModel(offRaw)));
  const shown = IC.lightRowModel(after, false, null, 40);
  // Mutation: ignore lastBri (back to 100) -> fails.
  check('level: switched on, HA not echoed yet -> the last known level, not 100', shown.on && shown.bri === 40 && !shown.briUnknown, shown);
  const blind = IC.lightRowModel(after, false, null, null);
  check('level: ... and with none known, UNKNOWN (never a made-up 100%)', blind.on && blind.briUnknown === true, blind);
  check('level: HA\'s own brightness wins over the memory', IC.lightRowModel({ state: 'on', attributes: { brightness: 255 } }, false, null, 40).bri === 100);
  check('level: an off light\'s slider rests at its last level', IC.lightRowModel(offRaw, false, null, 25).bri === 25 && !IC.lightRowModel(offRaw, false, null, 25).briUnknown);

  // Colour picks.
  const offRow = IC.lightRowModel(offRaw, true, '#ff0000');
  const pick = IC.lightColorCommand('light.demo_x', offRow, '#ff8000', true);
  // Mutation: send row.bri while restoring -> brightness 255 -> fails.
  check('colour pick on an OFF light: the colour, no brightness', pick.service === 'turn_on' && !('brightness' in pick.data) &&
    JSON.stringify(pick.data.rgb_color) === '[255,128,0]', pick);
  const onRow = IC.lightRowModel({ state: 'on', attributes: { brightness: 102 } }, true, '#ff0000');
  check('colour pick on an ON light: keeps the level it shows', IC.lightColorCommand('light.demo_x', onRow, '#ff8000', false).data.brightness === 102);
  check('colour pick while the level is unknown: no brightness', !('brightness' in IC.lightColorCommand('light.demo_x', blind, '#ff8000', false).data));

  // The memory.
  let now = 1000;
  const L = T.createLevelMemory(() => now);
  L.see('k', true, 60); L.see('k', false, 0); L.see('k', true, 0);
  check('memory: remembers the last level seen ON (off / 0 never overwrite it)', L.last('k') === 60 && L.last('other') === null);
  L.pend('p', 100, 3000);
  L.see('p', true, 100);
  // Mutation: remember the stand-in -> last('p') === 100 -> fails.
  check('memory: the stand-in level is never remembered, and reads unknown', L.last('p') === null && L.unknown('p', true, 100) && !L.unknown('p', false, 100));
  L.see('p', true, 35);
  check('memory: the light reporting a real level ends the unknown', L.last('p') === 35 && !L.unknown('p', true, 100));
  L.pend('q', 100, 3000); now += 3001;
  check('memory: ... as does time running out', !L.unknown('q', true, 100));
  L.pend('r', 100, 3000); L.clear('r');
  check('memory: a level the user set ends it', !L.unknown('r', true, 100));

  // Markup.
  const dot = () => '';
  const item = T.popoverHtml.item({ name: 'Lamp', status: 'ok', haOff: false, media: [], switches: [], readings: [],
    lights: [Object.assign({ label: 'Lamp' }, blind)] }, dot);
  check('item light markup: an unknown level reads "On", an indeterminate slider', /<small>On<\/small>/.test(item) &&
    /class="tp-range unknown" data-a="lbri"[^>]*aria-valuetext="Unknown"/.test(item) && !/On · 100%/.test(item), item);
  const pop = T.popoverHtml.light({ status: 'ok', na: false, haOff: false, on: true, bri: 100, briUnknown: true, name: 'Hall light' }, dot);
  check('light card markup: an unknown level reads "On", an indeterminate slider', /<b>On<\/b><\/span>/.test(pop) && /class="tp-range unknown" data-a="bri"/.test(pop), pop);
  const cor = T.popoverHtml.curtain({ name: 'x', status: 'ok', haOff: false, covers: [],
    lights: [{ id: 'c', label: 'Cornice', na: false, on: true, bri: 100, briUnknown: true }] }, dot);
  check('cornice markup: an unknown level reads "On", an indeterminate slider', /<small data-v>On<\/small>/.test(cor) && /class="tp-range unknown" data-a="cbri"/.test(cor), cor);

  // Wiring.
  check('wiring: the item light rows are given the last level', /lightRowModel\(r, colorable, colorFromAttributes\(a\), levels\.last\(key\)\)/.test(tpSrc));
  check('wiring: the item colour pick uses lightColorCommand with the pick\'s restoring flag',
    /itemSend\(lightColorCommand\(card\.lights\[i\]\.entity, cur, cp\.value, restoring\), 'light', 200\)/.test(tpSrc) && /if \(restoring === null\) restoring = !cur\.on;/.test(tpSrc));
  check('wiring: the light card colour pick on an off light is a no-brightness send', /o\.sendLight\(t\.roomId, t\.channel, st, 200, true, restoring\);/.test(tpSrc) &&
    /if \(restoring === null\) restoring = !st\.on;/.test(tpSrc));
  check('wiring: the light card switch-on restores the last level', /if \(st\.on && !st\.bri\) restoreLevel\(st\);/.test(tpSrc) &&
    /briUnknown: levels\.unknown\(key, !!st\.on, st\.bri\),/.test(tpSrc));
}

// ---- 14. camera rows -----------------------------------------------------------
{
  const T = await imp('src/tap-popovers.js');
  const tpSrc = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  const icSrc = fs.readFileSync(path.join(root, 'src/item-cards.js'), 'utf8');
  const card = IC.normaliseCard({ title: 'Crate', cameras: [{ entity: 'camera.demo_crate', label: 'Crate cam' },
    { entity: 'camera.demo_fast', refreshMs: 100 }, { entity: 'camera.demo_slow', refreshMs: 999999 }, { entity: 'image.demo_not_a_camera' }] }, 0);
  // Mutation: drop the cameras check from the empty-card test -> null -> fails.
  check('camera: a cameras-only card is a card; a non-camera row dropped', card && card.cameras.length === 3, card);
  // Mutation: no clamp -> 100 / 999999 -> fails.
  check('camera: refreshMs defaults to 2000, clamped to 500-60000', card.cameras[0].refreshMs === 2000 && card.cameras[1].refreshMs === 500 &&
    card.cameras[2].refreshMs === 60000, card.cameras);
  check('camera: the card reads its camera entities (so the client records them)', IC.cardEntities(card).includes('camera.demo_crate'));
  check('camera: a cameras card gets the camera icon', IC.cardIcon(card) === 'camera');

  const rawA = { state: 'idle', attributes: { access_token: 'tokA', entity_picture: '/api/camera_proxy/camera.demo_crate?token=tokA', friendly_name: 'Crate' } };
  const rawB = { state: 'idle', attributes: { access_token: 'tokB', entity_picture: '/api/camera_proxy/camera.demo_crate?token=tokB', friendly_name: 'Crate' } };
  const mA = IC.cameraRowModel(rawA), mB = IC.cameraRowModel(rawB);
  // Mutation: put the picture URL (or token) in the model -> the rotation changes it -> fails.
  check('camera model: no URL, no token -- a token rotation leaves it identical', JSON.stringify(mA) === JSON.stringify(mB) &&
    !/tok|camera_proxy/.test(JSON.stringify(mA)) && mA.canLive === true && mA.stateText === 'Idle', mA);
  const sig = T.repaintAction({}, { cameras: [mA] }, null, false, true, false).sig;
  check('camera: a token rotation never rebuilds the card', T.repaintAction({}, { cameras: [mB] }, sig, false, false, false).action === 'none');
  check('camera model: offline / never heard from', IC.cameraRowModel({ state: 'unavailable', attributes: {} }).stateText === 'Offline' &&
    IC.cameraRowModel(null).na && !IC.cameraRowModel({ state: 'idle', attributes: {} }).canLive);

  const snap = IC.cameraSnapshotUrl('https://ha.invalid/', rawA, 123);
  check('snapshot URL: HA base + entity_picture + a cache-bust', snap === 'https://ha.invalid/api/camera_proxy/camera.demo_crate?token=tokA&_=123', snap);
  check('snapshot URL: an absolute picture is kept; no picture or unavailable -> null',
    IC.cameraSnapshotUrl('https://ha.invalid', { state: 'idle', attributes: { entity_picture: 'https://cdn.invalid/p.jpg' } }, 1) === 'https://cdn.invalid/p.jpg?_=1' &&
    IC.cameraSnapshotUrl('https://ha.invalid', { state: 'idle', attributes: {} }, 1) === null &&
    IC.cameraSnapshotUrl('https://ha.invalid', { state: 'unavailable', attributes: rawA.attributes }, 1) === null);
  const stream = IC.cameraStreamUrl('https://ha.invalid', 'camera.demo_crate', rawA);
  check('stream URL: the MJPEG proxy with the access token', stream === 'https://ha.invalid/api/camera_proxy_stream/camera.demo_crate?token=tokA', stream);
  check('stream URL: none without a token or for a non-camera', IC.cameraStreamUrl('https://ha.invalid', 'camera.demo_crate', { state: 'idle', attributes: {} }) === null &&
    IC.cameraStreamUrl('https://ha.invalid', 'light.demo_x', rawA) === null);

  // The refresh loop, on fake timers.
  const mk = over => {
    const t = { now: 0, id: 0, timers: new Map(), shown: [], probes: [], stale: [] };
    const d = Object.assign({
      refreshMs: 2000,
      snapshotUrl: bust => 'https://ha.invalid/api/camera_proxy/camera.demo_x?token=T&_=' + bust,
      streamUrl: () => 'https://ha.invalid/api/camera_proxy_stream/camera.demo_x?token=T',
      probe: (src, ok, fail) => t.probes.push({ src, ok, fail }),
      show: src => t.shown.push(src), stale: s => t.stale.push(s),
      schedule: (fn, ms) => { const id = ++t.id; t.timers.set(id, { fn, at: t.now + ms }); return id; },
      cancel: id => { t.timers.delete(id); }, now: () => t.now,
    }, over);
    const advance = ms => {
      const end = t.now + ms;
      for (;;) {
        const due = [...t.timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        t.timers.delete(due[0]); t.now = due[1].at; due[1].fn();
      }
      t.now = end;
    };
    return { feed: IC.createCameraFeed(d), t, advance };
  };
  let x = mk({});
  x.feed.start();
  check('feed: start loads a frame at once', x.t.probes.length === 1 && x.t.shown.length === 0);
  x.t.probes[0].ok();
  check('feed: a loaded frame is shown', x.t.shown[0] === x.t.probes[0].src && x.t.stale.at(-1) === false);
  x.advance(1999);
  // Mutation: schedule the next refresh at 0 -> a second probe -> fails.
  check('feed: nothing before refreshMs', x.t.probes.length === 1);
  x.advance(1);
  check('feed: the next frame at refreshMs', x.t.probes.length === 2);
  x.advance(10000);
  check('feed: one load at a time (no new request while one is pending)', x.t.probes.length === 2);
  x.advance(5000);   // 15 s after the second probe: the watchdog fails it
  check('feed: a load that never settles fails after 15 s, the last frame dimmed', x.t.stale.at(-1) === true && x.t.probes.length === 2);
  x.advance(3999);
  check('feed: failures back off (2 x refreshMs)', x.t.probes.length === 2);
  x.advance(1);
  check('feed: ... then retries', x.t.probes.length === 3);
  x.t.probes[2].fail();
  x.advance(7999);
  // Mutation: no back-off (retry at refreshMs) -> a 4th probe at 2000 -> fails.
  check('feed: a second failure backs off further (4 x refreshMs)', x.t.probes.length === 3);
  x.advance(1);
  check('feed: ... then retries again', x.t.probes.length === 4);
  check('feed: a failed frame is never shown (no broken image)', x.t.shown.length === 1);
  x.feed.stop();
  // Mutation: stop without clearing the image -> fails.
  check('feed: stop clears the image and every timer', x.t.shown.at(-1) === '' && x.t.timers.size === 0);
  x.t.probes[3].ok();
  x.advance(120000);
  // Mutation: stop() leaves the timer running -> more probes -> fails.
  check('feed: after stop, no request and a late load is not shown', x.t.probes.length === 4 && x.t.shown.at(-1) === '');

  x = mk({});
  x.feed.start();
  x.feed.hidden(false);   // a spurious "visible" while a load is pending
  // Mutation: drop `pending` from tick's guard -> a second, overlapping load -> fails.
  check('feed: never a second load while one is pending', x.t.probes.length === 1);
  x.t.probes[0].ok();
  x.feed.hidden(true);
  // Mutation: hidden() does not cancel -> a refresh timer is left armed -> fails.
  check('feed: hidden cancels the armed refresh at once', x.t.timers.size === 0);
  x.advance(60000);
  // Mutation: hidden() does not cancel -> probes continue -> fails.
  check('feed: hidden -> no requests at all', x.t.probes.length === 1 && x.t.timers.size === 0);
  x.feed.hidden(false);
  check('feed: visible again -> a frame at once', x.t.probes.length === 2);
  x.t.probes[1].ok();
  const on = x.feed.setLive(true);
  check('feed: Live shows the MJPEG stream and stops the snapshots', on && /camera_proxy_stream/.test(x.t.shown.at(-1)) && x.t.timers.size === 0);
  x.advance(60000);
  check('feed: no snapshot requests while Live', x.t.probes.length === 2);
  x.feed.hidden(true);
  // Mutation: keep the stream while hidden -> fails.
  check('feed: hidden while Live ends the stream (the last frame put back)', !/stream/.test(x.t.shown.at(-1)));
  x.feed.hidden(false);
  check('feed: visible again resumes Live', /camera_proxy_stream/.test(x.t.shown.at(-1)));
  x.feed.setLive(false);
  check('feed: Live off ends the stream and goes back to snapshots', !/stream/.test(x.t.shown.at(-1)) && x.t.probes.length === 3);
  x.feed.setLive(true); x.feed.streamFailed();
  check('feed: a failed stream falls back to snapshots, dimmed, backing off', !x.feed.state().live && x.t.stale.at(-1) === true && x.t.probes.length === 3);
  x.feed.setLive(true); x.feed.stop();
  check('feed: close while Live ends the stream', x.t.shown.at(-1) === '' && !x.feed.state().live);
  x = mk({ streamUrl: () => null });
  x.feed.start();
  check('feed: Live is refused with no stream URL', x.feed.setLive(true) === false && !x.feed.state().live);
  x = mk({ snapshotUrl: () => null });
  x.feed.start();
  check('feed: no picture URL -> no request, dimmed, backing off', x.t.probes.length === 0 && x.t.stale.at(-1) === true && x.t.timers.size === 1);
  x = mk({});
  x.feed.hidden(true); x.feed.start();
  check('feed: opened while hidden -> nothing until visible', x.t.probes.length === 0);

  // Round 2 (ea54a0e0). A probe that can be aborted.
  const aborts = [];
  const mkA = over => mk(Object.assign({ probe: (src, ok, fail) => { const p = { src, ok, fail, aborted: false }; aborts.push(p); return () => { p.aborted = true; }; } }, over));
  // 1. Live off before any frame: the stream must not stay on the <img>.
  x = mkA({});
  x.feed.start();
  x.feed.setLive(true);
  x.feed.setLive(false);
  // Mutation: back to `if (lastGood) d.show(lastGood)` -> the stream URL stays shown -> fails.
  check('live: off before the first frame ends the stream (the image is cleared)', x.t.shown.at(-1) === '' && !x.feed.state().live && !x.feed.state().streaming, x.t.shown);
  // Hidden while Live with no frame yet: Live stays ON (honest), the stream ends, and it comes back.
  x = mkA({});
  x.feed.start(); x.feed.setLive(true);
  x.feed.hidden(true);
  x.feed.streamFailed();   // clearing the <img> fires 'error' in a browser
  // Mutation: streamFailed ignores `streaming` -> Live silently dropped -> fails.
  check('live: hidden ends the stream but Live stays on (a clearing error is not a stream failure)', x.t.shown.at(-1) === '' && x.feed.state().live, x.feed.state());
  x.feed.hidden(false);
  check('live: visible again -> the stream is back', /camera_proxy_stream/.test(x.t.shown.at(-1)) && x.feed.state().streaming);
  // 2. Live ends when the camera can no longer stream, and is not resumed.
  x = mkA({});
  x.feed.start(); x.feed.setLive(true);
  x.feed.allowLive(false);
  // Mutation: allowLive does nothing -> still streaming -> fails.
  check('live: HA disconnect (no Live toggle) ends Live and the stream', !x.feed.state().live && !/stream/.test(x.t.shown.at(-1)));
  x.feed.allowLive(true);
  check('live: ... and it is not resumed on reconnect', !x.feed.state().live && !/stream/.test(x.t.shown.at(-1)));
  check('wiring: every rebuild tells the feed whether a Live toggle is there', /cam\.feed\.allowLive\(!!b\);/.test(tpSrc));
  // 3. Abandoned loads are aborted.
  aborts.length = 0;
  x = mkA({});
  x.feed.start();
  x.advance(15000);
  // Mutation: the watchdog does not abort -> the hung load stays open -> fails.
  check('probe: a load that times out is aborted', aborts.length === 1 && aborts[0].aborted === true);
  x.advance(4000);
  check('probe: ... and the retry is a fresh load', aborts.length === 2 && !aborts[1].aborted);
  x.feed.stop();
  // Mutation: stop() leaves the probe running -> fails.
  check('probe: close aborts the load in flight', aborts[1].aborted === true);
  aborts.length = 0;
  x = mkA({});
  x.feed.start(); x.feed.hidden(true);
  check('probe: hiding the tab aborts the load in flight', aborts[0].aborted === true);
  check('wiring: the runtime probe can be aborted (src cleared, callbacks dropped)', /return \(\) => \{ im\.onload = im\.onerror = null; im\.src = ''; \};/.test(tpSrc));
  // 4. A late load (after its watchdog) is ignored.
  x = mk({});
  x.feed.start();
  const late = x.t.probes[0];
  x.advance(15000);   // timed out: failed, retry armed at 4 s
  const armed = x.t.timers.size;
  late.ok();
  // Mutation: drop `if (id !== pending) return;` -> the late frame is shown and the timer reset -> fails.
  check('feed: a load landing after its watchdog is ignored', !x.t.shown.includes(late.src) && x.t.stale.at(-1) === true && x.t.timers.size === armed, x.t.shown);
  // The back-off stops at 60 s.
  x = mk({ snapshotUrl: () => null });
  x.feed.start();
  for (let i = 0; i < 12; i++) x.advance(60000);
  const before = x.t.timers.size;
  const next = [...x.t.timers.values()][0];
  // Mutation: raise the 60000 cap -> the next retry is further than 60 s away -> fails.
  check('feed: the back-off is capped at 60 s', before === 1 && next.at - x.t.now <= 60000 && next.at - x.t.now > 30000, next && next.at - x.t.now);

  // Markup.
  const dot = () => '';
  const html = haOff => T.popoverHtml.item({ name: 'Crate', status: 'ok', haOff, media: [], lights: [], switches: [], readings: [],
    cameras: [Object.assign({ entity: 'camera.demo_crate', label: 'Crate cam' }, mA)] }, dot);
  const h = html(false);
  check('camera markup: a picture box, and no image URL or token in the markup', /<div class="tp-cam" data-cam="0"><\/div>/.test(h) &&
    !/<img|token|camera_proxy/.test(h), h);
  check('camera markup: a Live toggle when the camera can stream; disabled while HA is offline', /data-a="clive" data-i="0" aria-pressed="false"/.test(h) &&
    /data-a="clive"[^>]*\sdisabled/.test(html(true)));
  check('camera markup: no Live toggle without a token', !/clive/.test(T.popoverHtml.item({ name: 'x', status: 'ok', haOff: false,
    cameras: [Object.assign({ label: 'c' }, IC.cameraRowModel({ state: 'idle', attributes: {} }))] }, dot)));

  // Wiring.
  check('wiring: the camera rows are built from cameraRowModel only', /Object\.assign\(\{ entity: row\.entity, label: rowLabel\(row, r\) \}, cm,/.test(tpSrc));
  check('wiring: close stops every camera', /stopCameras\(p\);/.test(tpSrc) && /p\.cams\.forEach\(cam => cam\.feed\.stop\(\)\);/.test(tpSrc));
  check('wiring: a rebuild re-attaches the same <img>', /v\.bind\(pop\.target, pop\.el, pop\.ctl\);\s*attachCameras\(pop\);/.test(tpSrc) &&
    /if \(!cam\) \{ cam = makeCamera\(row\); p\.cams\.set\(i, cam\); cam\.feed\.start\(\); \}\s*box\.appendChild\(cam\.img\);/.test(tpSrc));
  check('wiring: the tab going hidden pauses the cameras (and the listener is removed on dispose)',
    /document\.addEventListener\('visibilitychange', onVisibility\);/.test(tpSrc) && /document\.removeEventListener\('visibilitychange', onVisibility\);/.test(tpSrc) &&
    /cam\.feed\.hidden\(document\.hidden\)/.test(tpSrc));
  check('no fetch(), and nothing camera-related is logged', !/\bfetch\(/.test(tpSrc) && !/\bfetch\(/.test(icSrc) && !/console\./.test(icSrc) &&
    !/console\.[a-z]+\([^)]*(token|src|Url)/i.test(tpSrc));

  // The client records a camera's raw state (its picture and token).
  const { HAClient } = await imp('src/ha-client.js');
  const st = (entity_id, state, attributes) => ({ entity_id, state: String(state), attributes: attributes || {}, last_changed: '', last_updated: '' });
  const fake = installFakeHA({ states: [st('camera.demo_crate', 'idle', rawA.attributes)] });
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, wsReconnectMs: 15,
      sensors: { items: { crate: { cameras: [{ entity: 'camera.demo_crate' }] } } } });
    ha.connect();
    await fake.whenConnected(ha);
    check('client: a camera\'s raw state (picture, token) is recorded', ((ha.getRawState('camera.demo_crate') || {}).attributes || {}).entity_picture === rawA.attributes.entity_picture);
    fake.sockets[fake.sockets.length - 1].emitStateChanged(st('camera.demo_crate', 'idle', rawB.attributes));
    await sleep(10);
    check('client: the rotated token replaces the old one', ha.getRawState('camera.demo_crate').attributes.access_token === 'tokB');
    ha.disconnect();
  } finally {
    console.log = log; console.warn = warn;
    fake.restore();
  }
}

// ---- 15. the curtains card: one light one row; no invented cornice reading ------
{
  const T = await imp('src/tap-popovers.js');
  const tpSrc = fs.readFileSync(path.join(root, 'src/tap-popovers.js'), 'utf8');
  const curtains = [{ id: 'w_blind', name: 'Window blind', room: 'r' }, { id: 'w_curtain', name: 'Window curtain', room: 'r' },
    { id: 'w_other', name: 'Other', room: 'r' }];
  const covers = { w_blind: ['cover.demo_b'], w_curtain: ['cover.demo_c'], w_other: ['cover.demo_o'] };
  const g = T.curtainRoomGroup('w_blind', curtains, covers,
    { w_blind: ['light.demo_cornice'], w_curtain: ['light.demo_cornice'], w_other: ['light.demo_other'] });
  // Mutation: back to one row per curtain -> 3 rows -> fails.
  check('curtains card: one cornice light bound under two curtains is ONE row, marked shared', g.lights.length === 2 &&
    g.lights[0].entities.join() === 'light.demo_cornice' && g.lights[0].shared === true && g.lights[1].shared === false, g.lights);
  const sub = T.curtainRoomGroup('w_blind', curtains, covers, { w_blind: ['light.demo_a', 'light.demo_b'], w_curtain: ['light.demo_b'] });
  check('curtains card: a curtain whose cornice is part of an earlier row adds none', sub.lights.length === 1 && sub.lights[0].shared);
  const two = T.curtainRoomGroup('w_blind', curtains, covers, { w_blind: ['light.demo_a'], w_curtain: ['light.demo_a', 'light.demo_b'] });
  check('curtains card: a cornice with a light of its own keeps its row', two.lights.length === 2);
  check('wiring: a shared light is the room\'s curtain light; its preview reaches every curtain it lights',
    /label: l\.shared && g\.room \? 'Curtain light' : rowLabelInRoom\(sentenceCase\(l\.name \+ ' light'\), rn\)/.test(tpSrc) &&
    /same\.forEach\(k => home\.setCorniceLight\(k,/.test(tpSrc));

  // Visual-review follow-ups (8b510fcd).
  // Mutation: return the label unchanged -> 'Living room blinds' -> fails.
  check('row labels under a room title drop the room', T.rowLabelInRoom('Living room blinds', 'Living room') === 'Blinds' &&
    T.rowLabelInRoom('Living Room curtain light', 'Living room') === 'Curtain light');
  // Mutation: strip a trailing room word (the old overlap rule) -> 'Divider' / 'Curtain' -> fails.
  check('row labels: only the WHOLE room name, as whole words, is stripped', T.rowLabelInRoom('Room divider', 'Living room') === 'Room divider' &&
    T.rowLabelInRoom('Office curtain', 'Home office') === 'Office curtain' && T.rowLabelInRoom('Living roomy blind', 'Living room') === 'Living roomy blind');
  check('row labels: a label that IS the room, or does not start with it, is kept', T.rowLabelInRoom('Living room', 'Living room') === 'Living room' &&
    T.rowLabelInRoom('Bay blind', 'Living room') === 'Bay blind' && T.rowLabelInRoom('Officer', 'Home office') === 'Officer');
  check('wiring: cover labels drop the room', /label: rowLabelInRoom\(sentenceCase\(cv\.name\), rn\),/.test(tpSrc));
  // Mutation: drop the coarse kind widths -> the curtain card shrinks to 216px on touch -> fails.
  check('touch sizing keeps each kind\'s own width', /\.tp-force-coarse \.tp-pop\[data-kind=vacuum\], \.tp-force-coarse \.tp-pop\[data-kind=curtain\] \{ --w: 236px; \}/.test(T.STYLE) &&
    /\.tp-force-coarse \.tp-pop\[data-kind=item\] \{ --w: 252px; \}/.test(T.STYLE));
  // Mutation: back to #60a5fa -> fails.
  check('the droplets use the --wet token', /\.tp-ireading \.hum svg \{[^}]*fill: var\(--wet\);/.test(T.STYLE) && /\.tp-pmoist svg \{[^}]*fill: var\(--wet\);/.test(T.STYLE));

  const REST = { on: true, bri: 100, color: null, rest: true };
  const off = T.corniceRowState({ opt: null, now: 0, last: null, live: false, raw: null, scene: REST, haConfigured: true });
  // Mutation: drop the rest check -> "On · 100%" and 100 remembered -> fails.
  check('cornice: HA configured but offline, never reported -> Unknown, nothing remembered', off.row.na && off.row.noReading &&
    !off.row.on && off.seen === null, off);
  const demo = T.corniceRowState({ opt: null, now: 0, last: null, live: false, raw: null, scene: REST, haConfigured: false });
  check('cornice: the demo (no HA) shows its sample rest state as before', !demo.row.na && demo.row.on && demo.row.bri === 100);
  const known = T.corniceRowState({ opt: null, now: 0, last: null, live: false, raw: null, scene: { on: true, bri: 40, color: null }, haConfigured: true });
  check('cornice: HA offline after a real reading -> that reading, remembered', known.row.on && known.row.bri === 40 && known.seen === 40);
  const live = T.corniceRowState({ opt: null, now: 0, last: 30, live: true, raw: { state: 'on', attributes: {} }, scene: REST, haConfigured: true });
  check('cornice: live, on with no level reported -> the last level, not 100', live.row.on && live.row.bri === 30 && live.seen === null, live);
  const unav = T.corniceRowState({ opt: null, now: 0, last: null, live: true, raw: { state: 'unavailable', attributes: {} }, scene: REST, haConfigured: true });
  check('cornice: live and unavailable -> Unavailable', unav.row.na && !unav.row.noReading);
  const sent = T.corniceRowState({ opt: { on: true, bri: null, until: 10 }, now: 5, last: null, live: true, raw: null, scene: REST, haConfigured: true });
  check('cornice: just switched on, no level known -> unknown', sent.row.on && sent.row.briUnknown);
  const html = T.popoverHtml.curtain({ name: 'x', status: 'haOffline', haOff: true, covers: [],
    lights: [Object.assign({ id: 'c', label: 'Cornice' }, off.row)] }, () => '');
  check('cornice markup: no reading reads Unknown, no slider, the switch disabled', /<small data-v>Unknown<\/small>/.test(html) &&
    !/data-a="cbri"/.test(html) && /data-a="cpower"[^>]*\sdisabled/.test(html) && !/100%/.test(html), html);
  check('wiring: corniceRow is corniceRowState, feeding only real levels to the memory',
    /const r = corniceRowState\(\{ opt: corniceOptimistic\.get\(l\.id\), now: Date\.now\(\), last: levels\.last\(key\), live: isLive\(c\),/.test(tpSrc) &&
    /haConfigured: !!ha\(\) \}\);\s*if \(r\.seen != null\) levels\.see\(key, true, r\.seen\);/.test(tpSrc));
}

console.log(failures ? 'FAILED -- ' + failures + ' failed, ' + passes + ' passed' : 'ok -- ' + passes + ' passed, 0 failed');
process.exit(failures ? 1 : 0);
