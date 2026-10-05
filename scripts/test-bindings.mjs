/**
 * Home Assistant bindings (plan B3) and the room sidebar config (plan B4).
 *
 *   node scripts/test-bindings.mjs
 *   node scripts/test-bindings.mjs --write <dir>
 *       also writes an export carrying a static curtain, a static light, a
 *       legacy-slot binding, a `bindings` entry, an item row and a sidebar
 *       config over the two JSON files in <dir> -- a temp COPY of
 *       houses/demo -- for CI's house-profiles job to run
 *       `validate-house.py --strict` on. <dir> must be outside the repo.
 *
 * WHAT THIS GUARDS
 *   1. The closed transform set, and reading a raw HA state through a binding.
 *   2. The normaliser (src/bindings.js): legacy slots and the `bindings`
 *      block are one map of targets; a target bound in BOTH is refused.
 *   3. Writers put a binding in its legacy slot first, `bindings` only when
 *      the slot cannot say it; the other members of a slot survive; a write
 *      never leaves a target bound twice. Item rows and the sidebar config.
 *   4. The entity picker keeps ONLY { entity_id, friendly_name, domain } in
 *      the supported domains.
 *   5. The HA client: a curtain bound ONLY through `bindings` moves on a
 *      state_changed (plan review #9); its transform applies; a light
 *      binding's channels read their own entities; listEntities is its OWN
 *      get_states (plan review #10); a watched entity is recorded.
 *   6. sidebarRows: no config is exactly today's rows; hide / show (opt-in)
 *      / extra; Ope's target config; the extra script row is the room
 *      script's two-step confirm.
 *   7. Entity ids never land in geometry.json; static values never in
 *      rooms.json. Static and entity choices round-trip through the draft
 *      and the export, and the export changes only the edited lines.
 *   8. A light fixture's geometry `static` look applies only while unbound.
 *
 * Fake Home Assistant only (scripts/fake-ha-websocket.mjs): never a real one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = v => JSON.parse(JSON.stringify(v));

const B = await imp('src/bindings.js');
const P = await imp('src/room-panel.js');
const RS = await imp('src/room-script.js');
const E = await imp('src/edit-ops.js');
const D = await imp('src/profile-draft.js');
const X = await imp('src/profile-export.js');
const LS = await imp('src/light-state.js');
const { HAClient } = await imp('src/ha-client.js');

const geoText = read('houses/demo/geometry.json');
const roomsText = read('houses/demo/rooms.json');
const geo = JSON.parse(geoText);
const rooms = JSON.parse(roomsText);

// ---- 1. transforms ------------------------------------------------------------
console.log('1. transforms');
{
  const T = B.applyTransform;
  check('the set is closed: identity, pct255, invert, onOff, rgb', JSON.stringify(B.TRANSFORMS) === '["identity","pct255","invert","onOff","rgb"]');
  check('identity: a number as reported', T(42, 'identity') === 42 && T('42', 'identity') === 42);
  check('pct255: 255 -> 100, 128 -> 50, 0 -> 0', T(255, 'pct255') === 100 && T(128, 'pct255') === 50 && T(0, 'pct255') === 0);
  check('invert: 30 -> 70', T(30, 'invert') === 70);
  check('onOff: on / open -> true, off / closed -> false', T('on', 'onOff') === true && T('open', 'onOff') === true && T('off', 'onOff') === false && T('closed', 'onOff') === false);
  check('rgb: [255, 0, 16] -> #ff0010', T([255, 0, 16], 'rgb') === '#ff0010');
  check('anything else (an expression) -> null', T(5, 'x * 2') === null && T(5, 'eval') === null);
  check('readBinding: attribute then transform', B.readBinding({ state: 'open', attributes: { current_position: 30 } }, { attribute: 'current_position', transform: 'invert' }) === 70);
  check('readBinding: no attribute reads the state', B.readBinding({ state: 'on', attributes: {} }, { attribute: null, transform: 'onOff' }) === true);
  check('readBinding: unavailable -> null', B.readBinding({ state: 'unavailable', attributes: { current_position: 30 } }, { attribute: 'current_position', transform: 'identity' }) === null);
}

// ---- 2. normaliser --------------------------------------------------------------
console.log('2. normaliser');
{
  const n = B.normaliseBindings(rooms);
  check('the demo has no errors and no `bindings` block', n.errors.length === 0 && n.block.size === 0, n.errors);
  const c = n.targets.get('curtain:lounge_curtain');
  check('sensors.curtains[id] IS curtain:id.openPct (current_position, identity)', c && c.source === 'legacy' &&
    c.channels.openPct.entity === 'cover.demo_lounge_curtain' && c.channels.openPct.attribute === 'current_position' && c.channels.openPct.transform === 'identity', c);
  const l = n.targets.get('light:lounge/main');
  check('rooms[r][ch] IS light:r/ch.{on, brightness, color} on that entity', l && l.source === 'legacy' &&
    ['on', 'brightness', 'color'].every(ch => l.channels[ch].entity === 'light.demo_lounge_ceiling') &&
    l.channels.brightness.transform === 'pct255' && l.channels.on.transform === 'onOff', l);
  const both = Object.assign(clone(rooms), { bindings: { 'curtain:lounge_curtain': { openPct: { entity: 'cover.demo_other' } } } });
  const nb = B.normaliseBindings(both);
  check('a target bound in BOTH places is refused (an error)', nb.errors.length === 1 && /both/.test(nb.errors[0].message), nb.errors);
  check('... the legacy slot is kept, the `bindings` entry dropped', nb.targets.get('curtain:lounge_curtain').channels.openPct.entity === 'cover.demo_lounge_curtain' && nb.block.size === 0);
  const bad = B.normaliseBindings({ rooms: {}, bindings: { 'curtain:x': { openPct: { entity: 'light.demo_x' } }, 'fan:y': {}, 'light:a/b': { on: { entity: 'light.demo_a', transform: 'x*2' } } } });
  check('wrong domain, unknown target kind, unknown transform: each refused', bad.errors.length === 3 && bad.block.size === 0, bad.errors);
  const ok = B.normaliseBindings({ rooms: {}, bindings: { 'curtain:x': { openPct: { entity: 'cover.demo_x', transform: 'invert' } } } });
  check('a bindings-only curtain is a target from the block', ok.block.has('curtain:x') && ok.targets.get('curtain:x').source === 'bindings');
  const f = B.foldBindings({ rooms: { a: { main: ['light.demo_a'] } }, sensors: {}, bindings: {
    'curtain:x': { openPct: { entity: 'cover.demo_x', transform: 'invert' } },
    'light:a/ambient': { on: { entity: 'light.demo_b' }, brightness: { entity: 'light.demo_b', transform: 'identity' } } } });
  check('foldBindings: the page finds a block curtain in sensors.curtains', JSON.stringify(f.sensors.curtains.x) === '["cover.demo_x"]');
  check('foldBindings: ... and a block light in rooms[room][channel]', JSON.stringify(f.rooms.a.ambient) === '["light.demo_b"]' && JSON.stringify(f.rooms.a.main) === '["light.demo_a"]');
}

// ---- 3. writers -----------------------------------------------------------------------
console.log('3. writers: legacy slot first');
{
  let r = B.setTargetBinding(rooms, 'curtain:lounge_sheer', { openPct: { entity: 'cover.demo_new' } });
  check('a default curtain binding goes to sensors.curtains', JSON.stringify(r.sensors.curtains.lounge_sheer) === '["cover.demo_new"]' && !r.bindings);
  check('... and does not bump schemaVersion', r.schemaVersion === rooms.schemaVersion);
  check('... the input document is not mutated', rooms.sensors.curtains.lounge_sheer[0] === 'cover.demo_lounge_sheer');
  check('... untouched slots are the SAME objects (byte-identical export)', r.rooms === rooms.rooms && r.sensors.presence === rooms.sensors.presence);
  r = B.setTargetBinding(rooms, 'curtain:lounge_sheer', { openPct: { entity: 'cover.demo_new', transform: 'invert' } });
  check('an inverted curtain cannot be said by the slot: it goes to `bindings`', r.bindings['curtain:lounge_sheer'].openPct.transform === 'invert' &&
    !('lounge_sheer' in r.sensors.curtains), r.bindings);
  check('... only non-default fields are written', JSON.stringify(r.bindings['curtain:lounge_sheer'].openPct) === '{"entity":"cover.demo_new","transform":"invert"}');
  check('... schemaVersion goes to 1.11', r.schemaVersion === '1.11');
  check('... and the target is bound exactly once', B.normaliseBindings(r).errors.length === 0);
  const back = B.setTargetBinding(r, 'curtain:lounge_sheer', { openPct: { entity: 'cover.demo_new' } });
  check('back to a default binding: the slot again, the block emptied away', JSON.stringify(back.sensors.curtains.lounge_sheer) === '["cover.demo_new"]' && !back.bindings);
  const un = B.setTargetBinding(rooms, 'curtain:lounge_sheer', null);
  check('unbinding (Static) removes it from both places', !('lounge_sheer' in un.sensors.curtains) && !un.bindings);
  const multi = B.setTargetBinding({ rooms: {}, sensors: { curtains: { c: ['cover.demo_a', 'cover.demo_b'] } } }, 'curtain:c', { openPct: { entity: 'cover.demo_a' } });
  check('a multi-motor slot keeps its other motors when its first entity is kept', JSON.stringify(multi.sensors.curtains.c) === '["cover.demo_a","cover.demo_b"]');
  let l = B.setTargetBinding(rooms, 'light:study/galaxy', { on: { entity: 'light.demo_g' }, brightness: { entity: 'light.demo_g' }, color: { entity: 'light.demo_g' } });
  check('a light on one entity at the defaults goes to rooms[room][channel]', JSON.stringify(l.rooms.study.galaxy) === '["light.demo_g"]' && !l.bindings);
  l = B.setTargetBinding(rooms, 'light:study/galaxy', { on: { entity: 'light.demo_g' }, brightness: { entity: 'light.demo_g', transform: 'identity' }, color: { entity: 'light.demo_g' } });
  check('a non-default brightness transform goes to `bindings`', l.bindings['light:study/galaxy'].brightness.transform === 'identity' && !('galaxy' in l.rooms.study));
  l = B.setTargetBinding(rooms, 'light:study/main', { on: { entity: 'light.demo_a' }, brightness: { entity: 'light.demo_b' }, color: { entity: 'light.demo_a' } });
  check('channels on different entities go to `bindings` (and leave the slot)', !!l.bindings['light:study/main'] && !('main' in l.rooms.study) && B.normaliseBindings(l).errors.length === 0);
  let threw = false;
  try { B.setTargetBinding(rooms, 'curtain:lounge_sheer', { openPct: { entity: 'light.demo_x' } }); } catch (e) { threw = true; }
  check('a wrong-domain entity is refused', threw);
  // Item rows.
  let it = B.addItemRow(rooms, 'kitchen_robot', 'light', 'light.demo_shelf');
  check('addItemRow makes a card for an unbound item', JSON.stringify(it.sensors.items.kitchen_robot) === '{"lights":[{"entity":"light.demo_shelf"}]}', it.sensors.items.kitchen_robot);
  it = B.addItemRow(it, 'kitchen_robot', 'switch', 'input_boolean.demo_shelf');
  const rows = B.itemRows(it, 'kitchen_robot');
  check('itemRows lists them by kind', rows.length === 2 && rows[0].kind === 'light' && rows[1].kind === 'switch', rows);
  it = B.setItemRowEntity(it, 'kitchen_robot', rows[0], 'light.demo_other');
  check('setItemRowEntity repoints one row', B.itemRows(it, 'kitchen_robot')[0].entity === 'light.demo_other');
  it = B.removeItemRow(B.removeItemRow(it, 'kitchen_robot', B.itemRows(it, 'kitchen_robot')[1]), 'kitchen_robot', { card: 0, kind: 'light', index: 0 });
  check('removing the last row removes the item entry', !('kitchen_robot' in (it.sensors.items || {})));
  threw = false;
  try { B.addItemRow(rooms, 'kitchen_robot', 'media', 'light.demo_x'); } catch (e) { threw = true; }
  check('an item row of the wrong domain is refused', threw);
  // Sidebar.
  const s = B.setRoomSidebar(rooms, 'lounge', { hide: ['ambient', 'ambient'], show: [], extra: [{ kind: 'script', entity: 'script.demo_kill', label: ' Kill room ', confirm: true }] });
  check('setRoomSidebar: deduped hide, trimmed label, empty lists left out', JSON.stringify(s.sidebar.lounge) ===
    '{"hide":["ambient"],"extra":[{"kind":"script","entity":"script.demo_kill","label":"Kill room","confirm":true}]}', s.sidebar);
  check('... schemaVersion goes to 1.11', s.schemaVersion === '1.11');
  check('... an empty config removes the room and the block', !B.setRoomSidebar(s, 'lounge', {}).sidebar);
  threw = false;
  try { B.setRoomSidebar(rooms, 'lounge', { extra: [{ kind: 'cover', entity: 'light.demo_x', label: 'x' }] }); } catch (e) { threw = true; }
  check('an extra of the wrong domain is refused', threw);
  check('confirm is a script-only field', !('confirm' in B.setRoomSidebar(rooms, 'lounge', { extra: [{ kind: 'light', entity: 'light.demo_x', label: 'x', confirm: true }] }).sidebar.lounge.extra[0]));
}

// ---- 4. the picker list ------------------------------------------------------------------
console.log('4. the entity picker');
const STATES = [
  { entity_id: 'light.demo_lounge_cove', state: 'on', attributes: { friendly_name: 'Lounge cove', brightness: 100 }, context: { id: 'x' }, last_changed: 't' },
  { entity_id: 'cover.demo_lounge_curtain', state: 'open', attributes: { friendly_name: 'Lounge curtain', current_position: 40 } },
  { entity_id: 'sensor.demo_temp', state: '21', attributes: { friendly_name: 'Temp' } },
  { entity_id: 'binary_sensor.demo_motion', state: 'off', attributes: { friendly_name: 'Motion' } },
  { entity_id: 'script.demo_kill', state: 'off', attributes: { friendly_name: 'Kill lounge' } },
  { entity_id: 'switch.demo_plug', state: 'on', attributes: {} },
  { entity_id: 'media_player.demo_tv', state: 'off', attributes: { friendly_name: 'TV' } },
  { entity_id: 'climate.demo_t', state: 'heat', attributes: { friendly_name: 'Thermostat' } },
  { entity_id: 'input_boolean.demo_mode', state: 'off', attributes: { friendly_name: 'Guest mode' } },
];
{
  const list = B.pickerEntities(STATES);
  check('only the supported domains (no sensor, binary_sensor, climate)', list.map(e => e.domain).sort().join() === 'cover,input_boolean,light,media_player,script,switch', list);
  check('each entry keeps ONLY entity_id, friendly_name and domain', list.every(e => Object.keys(e).sort().join() === 'domain,entity_id,friendly_name'));
  check('friendly names (the id when there is none), sorted by name', list[0].friendly_name === 'Guest mode' && list.find(e => e.entity_id === 'switch.demo_plug').friendly_name === 'switch.demo_plug');
  check('a domain filter narrows it', B.pickerEntities(STATES, ['cover']).map(e => e.entity_id).join() === 'cover.demo_lounge_curtain');
  check('a filter cannot widen it past the supported domains', B.pickerEntities(STATES, ['sensor']).length === 0);
  check('search: every word in the name or the id', B.filterEntities(list, 'lounge cur').map(e => e.entity_id).join() === 'cover.demo_lounge_curtain' &&
    B.filterEntities(list, 'demo_tv').length === 1);
}

// ---- 5. the HA client ------------------------------------------------------------------------
console.log('5. the HA client (fake Home Assistant)');
{
  const realLog = console.log, realWarn = console.warn;
  const fake = installFakeHA({ states: STATES.concat([{ entity_id: 'cover.demo_bound', state: 'open', attributes: { current_position: 80 } },
    { entity_id: 'light.demo_bri', state: 'on', attributes: { brightness: 40 } }, { entity_id: 'light.demo_on', state: 'on', attributes: {} },
    { entity_id: 'light.demo_watch', state: 'off', attributes: {} }]) });
  console.log = () => {}; console.warn = () => {};
  try {
    // A curtain bound ONLY through `bindings` (no sensors.curtains entry).
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: {},
      bindings: { 'curtain:lounge_curtain': { openPct: { entity: 'cover.demo_bound', transform: 'invert' } },
        'light:lounge/ambient': { on: { entity: 'light.demo_on' }, brightness: { entity: 'light.demo_bri', transform: 'identity' } } },
      watch: ['light.demo_watch'] });
    const curtain = [], lights = [], watched = [];
    ha.onCurtainChange((id, st) => curtain.push([id, st.pct]));
    ha.onStateChange((room, group, st) => lights.push([room, group, st.on, st.bri]));
    ha.onWatchedChange((id, raw) => watched.push([id, raw.state]));
    ha.connect();
    await fake.whenConnected(ha);
    check('snapshot: the bindings-only curtain reads its cover, inverted (80 -> 20)', curtain.some(c => c[0] === 'lounge_curtain' && c[1] === 20), curtain);
    fake.sockets[fake.sockets.length - 1].emitStateChanged({ entity_id: 'cover.demo_bound', state: 'open', attributes: { current_position: 30 } });
    await sleep(20);
    check('state_changed: the bindings-only curtain MOVES (30 -> 70)', curtain[curtain.length - 1][0] === 'lounge_curtain' && curtain[curtain.length - 1][1] === 70, curtain);
    check('its availability follows the cover like a legacy curtain', ha.getCurtainAvailable('lounge_curtain') === true);
    check('the light binding reads on from one entity and brightness from another (identity: 40)',
      lights.some(l => l[0] === 'lounge' && l[1] === 'ambient' && l[2] === true && l[3] === 40), lights);
    fake.sockets[fake.sockets.length - 1].emitStateChanged({ entity_id: 'light.demo_bri', state: 'on', attributes: { brightness: 75 } });
    await sleep(20);
    check('... and follows a state_changed on the brightness entity', lights[lights.length - 1][3] === 75, lights[lights.length - 1]);
    check('a watched entity is recorded raw', ha.getRawState('light.demo_watch') && ha.getRawState('light.demo_watch').state === 'off');
    fake.sockets[fake.sockets.length - 1].emitStateChanged({ entity_id: 'light.demo_watch', state: 'on', attributes: { brightness: 10 } });
    await sleep(20);
    check('... and announced on a change', watched.length >= 2 && watched[watched.length - 1][1] === 'on', watched);
    // listEntities: its OWN get_states.
    const before = fake.sent.filter(m => m.type === 'get_states').length;
    const list = await ha.listEntities(['light', 'cover']);
    check('listEntities sends its own get_states', fake.sent.filter(m => m.type === 'get_states').length === before + 1);
    check('... and returns only the asked domains, as { entity_id, friendly_name, domain }',
      list.length > 0 && list.every(e => (e.domain === 'light' || e.domain === 'cover') && Object.keys(e).length === 3), list);
    check('... with friendly names', list.some(e => e.friendly_name === 'Lounge curtain'));
    check('no command was ever sent', fake.calls.length === 0, fake.calls);
    ha.disconnect();
    let rejected = false;
    try { await ha.listEntities(['light']); } catch (e) { rejected = true; }
    check('listEntities refuses while disconnected', rejected);

    // A target bound in BOTH places: only the legacy slot drives it.
    const ha2 = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {},
      sensors: { curtains: { lounge_curtain: ['cover.demo_lounge_curtain'] } },
      bindings: { 'curtain:lounge_curtain': { openPct: { entity: 'cover.demo_bound' } } } });
    const c2 = [];
    ha2.onCurtainChange((id, st) => c2.push(st.pct));
    ha2.connect();
    await fake.whenConnected(ha2);
    check('bound twice: the legacy cover drives it (40), the `bindings` one (80) is ignored', c2.length === 1 && c2[0] === 40, c2);
    ha2.disconnect();
  } finally { console.log = realLog; console.warn = realWarn; fake.restore(); }
}

// ---- 6. sidebar rows --------------------------------------------------------------------------
console.log('6. sidebar rows');
{
  const derived = ['main', 'ambient', 'galaxy', 'door:front_door', 'door:store_door', 'motion', 'curtain:lounge_curtain', 'curtain:lounge_sheer', 'climate', 'room-script'];
  check('no config: EXACTLY the derived rows (a profile without `sidebar` is unchanged)', JSON.stringify(P.sidebarRows(derived, null)) === JSON.stringify(derived));
  check('normaliseSidebar of no block gives no config for any room', P.normaliseSidebar(undefined).size === 0 && P.normaliseSidebar(rooms.sidebar).size === 0);
  const cfg = raw => P.normaliseSidebar({ r: raw }).get('r');
  check('an empty room config is still exactly the derived rows', JSON.stringify(P.sidebarRows(derived, cfg({}))) === JSON.stringify(derived));
  check('hide: a derived row disappears', P.sidebarRows(derived, cfg({ hide: ['ambient'] })).indexOf('ambient') === -1);
  check('hide: one door by id', JSON.stringify(P.sidebarRows(derived, cfg({ hide: ['door:store_door'] })).filter(k => k.startsWith('door:'))) === '["door:front_door"]');
  check('hide: every curtain by group', !P.sidebarRows(derived, cfg({ hide: ['curtains'] })).some(k => k.startsWith('curtain:')));
  check('the HA-offline note can never be hidden', P.sidebarRows(['ha-offline', 'main'], cfg({ hide: ['ha-offline', 'main'] })).join() === 'ha-offline');
  check('item rows appear ONLY when opted in', !P.sidebarRows(derived, cfg({ hide: ['main'] })).some(k => k.startsWith('item:')) &&
    P.sidebarRows(derived, cfg({ show: ['item:desk_lamp'] })).indexOf('item:desk_lamp') !== -1);
  check('extras come after the item rows and before the room script', P.sidebarRows(['main', 'room-script'],
    cfg({ show: ['item:a'], extra: [{ kind: 'light', entity: 'light.demo_x', label: 'X' }] })).join() === 'main,item:a,extra:0,room-script');
  check('a malformed extra is dropped', cfg({ extra: [{ kind: 'fan', entity: 'fan.demo_x', label: 'x' }, { kind: 'light', entity: 'cover.demo_x', label: 'x' },
    { kind: 'light', entity: 'light.demo_x', label: ' ' }, { kind: 'cover', entity: 'cover.demo_x', label: 'Blind' }] }).extra.length === 1);
  // Ope's target: no individual light rows, no ambient; a kill-room script
  // button and the ambient light GROUP as extras.
  const ope = cfg({ hide: ['main', 'ambient', 'galaxy'], extra: [
    { kind: 'script', entity: 'script.demo_kill_lounge', label: 'Kill room', confirm: true },
    { kind: 'light', entity: 'light.demo_lounge_ambient_group', label: 'Ambient' }] });
  const rows = P.sidebarRows(derived, ope);
  check('Ope\'s target config: no light rows, the two extras, everything else kept',
    JSON.stringify(rows) === JSON.stringify(['door:front_door', 'door:store_door', 'motion', 'curtain:lounge_curtain', 'curtain:lounge_sheer', 'climate', 'extra:0', 'extra:1', 'room-script']), rows);
  check('... and it is a config setRoomSidebar writes and normaliseSidebar reads back', JSON.stringify(P.normaliseSidebar(B.setRoomSidebar(rooms, 'lounge', {
    hide: ['main', 'ambient', 'galaxy'], extra: [{ kind: 'script', entity: 'script.demo_kill_lounge', label: 'Kill room', confirm: true },
      { kind: 'light', entity: 'light.demo_lounge_ambient_group', label: 'Ambient' }] }).sidebar).get('lounge').extra.map(x => x.kind)) === '["script","light"]');
  // The extra script row is the room script's row under its own key.
  const html = RS.roomScriptRowHtml({ label: 'Kill room' }, 'idle', 'ok', { rowKey: 'extra:0', action: 'x-script' });
  check('an extra script row: the room-script button under data-row="extra:0", action x-script', /data-row="extra:0"/.test(html) && /data-action="x-script"/.test(html) && /room-script-btn idle/.test(html));
  check('the room script row itself is unchanged', /data-row="room-script"/.test(RS.roomScriptRowHtml({ label: 'Kill room' }, 'idle', 'ok')) &&
    /data-action="room-script"/.test(RS.roomScriptRowHtml({ label: 'Kill room' }, 'idle', 'ok')));
  // ...and its confirm is the same two-step state machine.
  let t = 0; let sent = 0;
  const c = RS.createTwoStepConfirm({ send: () => { sent++; return true; }, writable: () => true, now: () => t, setTimer: () => 1, clearTimer: () => {} });
  c.press({}); t = 600; c.press({});
  check('two-step: the first tap arms, the second sends ONE call', sent === 1);
  const page = read('index.html');
  const wire = page.slice(page.indexOf("if (action === 'x-script') {"), page.indexOf("// Curtain Open / Close buttons"));
  check('index: a confirm extra goes through extraScriptConfirm(...).press (the two-step), others one tap', /if \(b\.confirm\) \{[\s\S]*extraScriptConfirm\(rid, key, b\)\.press\(/.test(wire));
  check('index: extraScriptConfirm is createTwoStepConfirm over sendScript', /function extraScriptConfirm[\s\S]{0,300}createTwoStepConfirm\(\{[\s\S]{0,200}sendScript\(ha, \{ entity: b\.entity, variables: b\.variables \}/.test(page));
  check('index: roomRowKeys is sidebarRows over the derived rows', /function roomRowKeys\(rid\) \{\s*return sidebarRows\(derivedRowKeys\(rid\), sidebarConfig\(rid\)\);/.test(page));
  check('index: the client gets the raw slots + bindings + the watched extras', /rooms: haConfig\.rawRooms,\s*sensors: haConfig\.rawSensors,\s*bindings: haConfig\.bindings,/.test(page) && /watch: sidebarWatchEntities\(\)/.test(page));
  // Row markup: disabled offline, an unavailable light says so.
  const lr = P.extraLightRowHtml('extra:1', 'Ambient', { na: false, on: true, bri: 40 }, true);
  check('extra light row: toggle + brightness, every control disabled offline', /data-action="x-toggle"/.test(lr) && /data-action="x-bri"/.test(lr) && (lr.match(/ disabled/g) || []).length === 2);
  check('extra light row: unavailable says so', /Unavailable/.test(P.extraLightRowHtml('extra:1', 'A', { na: true, on: false, bri: 100 }, false)));
  check('extra cover row: open / close / position', /data-cmd="open"/.test(P.extraCoverRowHtml('extra:2', 'Blind', P.coverRowModel({ state: 'open', attributes: { current_position: 30 } }), false)) &&
    /Open: 30%/.test(P.extraCoverRowHtml('extra:2', 'Blind', P.coverRowModel({ state: 'open', attributes: { current_position: 30 } }), false)));
  check('labels are escaped', !/<b>/.test(P.extraSwitchRowHtml('extra:3', '<b>x</b>', { na: false, on: false, stateText: 'Off' }, false)));
}

// ---- 7. the privacy line and the round trip --------------------------------------------------
console.log('7. entity ids only in rooms.json; round trip through the draft and the export');
let edited = null;
{
  check('(fixture) the demo geometry has no entity ids', B.findEntityIds(geo).length === 0, B.findEntityIds(geo));
  let g = E.setCurtainOpenPct(geo, 'lounge_sheer', 35);
  g = E.setFixtureStatic(g, 'study', 'ambient', { on: true, brightness: 40, color: '#00CCFF' });
  let r = B.setTargetBinding(rooms, 'curtain:lounge_sheer', null);                                     // the sheer: static
  r = B.setTargetBinding(r, 'curtain:bedroom_curtain', { openPct: { entity: 'cover.demo_bedroom_curtain', transform: 'invert' } });
  r = B.setTargetBinding(r, 'light:study/ambient', null);                                              // the strip: static
  r = B.addItemRow(r, 'lounge_corn_plant', 'light', 'light.demo_plant_lamp');
  r = B.setRoomSidebar(r, 'lounge', { hide: ['main', 'ambient'], show: ['item:lounge_corn_plant'],
    extra: [{ kind: 'script', entity: 'script.demo_kill_lounge', label: 'Kill room', confirm: true }, { kind: 'light', entity: 'light.demo_lounge_group', label: 'Ambient' }] });
  check('after every edit-mode write, geometry.json carries NO entity id', B.findEntityIds(g).length === 0, B.findEntityIds(g));
  check('... and rooms.json carries no static value', !JSON.stringify(r).includes('"openPct":35') && !JSON.stringify(r).includes('#00ccff'));
  check('the static writers refuse an entity id passed as a value', !('color' in E.setFixtureStatic(geo, 'study', 'ambient', { color: 'light.demo_x' }).lights
    .find(l => l.room === 'study').fixtures.find(f => f.channel === 'ambient').static) && (() => { try { E.setCurtainOpenPct(geo, 'lounge_sheer', 'cover.demo_x'); return false; } catch (e) { return true; } })());
  const src = read('src/edit-bindings.js');
  const geoWrites = [...src.matchAll(/api\.setGeometry\(([a-zA-Z]+)\(/g)].map(m => m[1]);
  check('edit-bindings writes geometry ONLY through the static writers', geoWrites.length >= 2 && geoWrites.every(f => f === 'setCurtainOpenPct' || f === 'setFixtureStatic'), geoWrites);
  check('fixture static raises geometry to 1.5', g.schemaVersion === '1.5');
  // Round trip through the draft (localStorage) and back.
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  D.writeDraft(storage, D.makeDraft({ houseId: 'demo', baseHash: D.baseHashOf(geoText, roomsText), geometry: g, rooms: r }));
  const d = D.readDraft(storage, 'demo');
  check('draft: the static curtain survives', d.geometry.curtains.find(c => c.id === 'lounge_sheer').openPct === 35);
  check('draft: the static light survives', JSON.stringify(E.fixtureStatic(d.geometry, 'study', 'ambient')) === '{"on":true,"brightness":40,"color":"#00ccff"}');
  check('draft: the static ones are unbound', B.bindingOf(d.rooms, 'curtain:lounge_sheer') === null && B.bindingOf(d.rooms, 'light:study/ambient') === null);
  const bb = B.bindingOf(d.rooms, 'curtain:bedroom_curtain');
  check('draft: the entity binding survives, transform and all', bb && bb.source === 'bindings' && bb.channels.openPct.transform === 'invert');
  check('draft: the item row and the sidebar config survive', B.itemRows(d.rooms, 'lounge_corn_plant')[0].entity === 'light.demo_plant_lamp' &&
    JSON.stringify(P.sidebarRows(['main', 'ambient', 'motion', 'room-script'], P.normaliseSidebar(d.rooms.sidebar).get('lounge'))) === '["motion","item:lounge_corn_plant","extra:0","extra:1","room-script"]');
  // The export.
  edited = X.exportProfile({ geometryText: geoText, roomsText }, d);
  check('export parses back to the draft', JSON.stringify(JSON.parse(edited.geometry)) === JSON.stringify(d.geometry) && JSON.stringify(JSON.parse(edited.rooms)) === JSON.stringify(d.rooms));
  const changed = (a, b) => { const A = a.split('\n'), Bl = new Set(b.split('\n')); return A.filter(x => !Bl.has(x)); };
  const gGone = changed(geoText, edited.geometry);
  // (A removed member takes its separator with it, so its neighbour's line
  // changes too: the study's main light, the lounge curtain.)
  check('geometry export: only the edited lines change (the sheer openPct, the version)', gGone.length <= 3 &&
    gGone.every(l => /"openPct"|lounge_sheer|"channel": "ambient"|schemaVersion/.test(l)), gGone);
  const rGone = changed(roomsText, edited.rooms);
  check('rooms export: only the edited lines change', rGone.length <= 6 &&
    rGone.every(l => /demo_study_|lounge_curtain|lounge_sheer|bedroom_curtain|schemaVersion/.test(l)), rGone);
  const NL = String.fromCharCode(10);
  check('rooms export: every line it does not touch is still there', roomsText.split(NL).length - rGone.length ===
    roomsText.split(NL).filter(l => edited.rooms.split(NL).includes(l)).length);
  const noop = X.exportProfile({ geometryText: geoText, roomsText }, { geometry: geo, rooms });
  check('an unedited export is byte-identical', noop.geometry === geoText && noop.rooms === roomsText);
}

// ---- 8. a fixture's static look ---------------------------------------------------------------------
console.log('8. static light look: a binding beats it, it beats the default');
{
  const lights = { study: { ambient: { static: { on: true, bri: 40, color: '#00ccff' } }, main: { static: { on: true, bri: 30 } } } };
  const unbound = LS.seedLightState({ study: {} }, lights, {});
  check('unbound: the static look', unbound.study.ambient.on === true && unbound.study.ambient.bri === 40 && unbound.study.ambient.color === '#00ccff' && unbound.study.main.bri === 30);
  const bound = LS.seedLightState({ study: {} }, lights, { study: ['ambient'] });
  check('bound: the static look is ignored (the binding wins), defaults until HA reports', bound.study.ambient.on === false && bound.study.ambient.bri === 80 && bound.study.main.bri === 30);
  const none = LS.seedLightState({ study: {} }, { study: { ambient: {} } }, {});
  check('no static: the defaults', none.study.ambient.on === false && none.study.ambient.bri === 80);
  const { HouseLoader } = await imp('src/house-loader.js');
  const h = HouseLoader.compile(E.setFixtureStatic(geo, 'study', 'ambient', { on: true, brightness: 55, color: '#112233' }), 'houses/demo/');
  check('the loader carries a fixture\'s static to its light group', JSON.stringify(h.lights.study.ambient.static) === '{"on":true,"bri":55,"color":"#112233"}', h.lights.study.ambient.static);
}

const at = process.argv.indexOf('--write');
if (at > 0) {
  const dir = path.resolve(process.argv[at + 1] || '');
  if (!process.argv[at + 1] || dir.startsWith(root + path.sep)) { console.error('--write needs a directory outside the repo'); process.exit(2); }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'geometry.json'), edited.geometry);
  fs.writeFileSync(path.join(dir, 'rooms.json'), edited.rooms);
  console.log('  wrote the edited export to ' + dir);
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
