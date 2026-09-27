#!/usr/bin/env node
/**
 * The robot vacuum's Home Assistant control (src/vacuum-control.js) and its
 * fold into the client (src/ha-client.js). Never a real HA: the client runs
 * against scripts/fake-ha-websocket.mjs, and every command is RECORDED, not
 * sent. No framework, no install: `node scripts/test-vacuum-control.mjs`.
 *
 *   1. normaliseVacuumBindings: keeps a valid binding, drops a non-vacuum
 *      entity, a bad segment and a malformed service.
 *   2. parseVacuum: state, status, battery (sensor wins over the attribute),
 *      error, unavailable.
 *   3. vacuumActions / vacuumCommand: each button enabled only when it would
 *      change something; the command refuses (null) otherwise.
 *   4. vacuumSegmentCommand: the segment service, the default, refusals.
 *   5. The client: the snapshot fires one reading per robot, an
 *      attribute-only republish fires nothing, a battery change fires, a
 *      reconnect re-emits, the resync sends no command, and a button's
 *      command goes out as exactly one call_service of the right shape.
 *   6. Picking: furnitureItemAt picks the smallest containing box;
 *      pickFromHits asks deviceAt about the first SOLID hit only; the card
 *      enables each button only when it applies and disables all offline.
 *
 * Each check names the one-line mutation it catches.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const V = await imp('src/vacuum-control.js');
const { HAClient } = await imp('src/ha-client.js');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 1. bindings ---------------------------------------------------------------
{
  const m = V.normaliseVacuumBindings({
    dock: { entity: 'vacuum.demo_robot', battery: 'sensor.demo_robot_battery', segments: { kitchen: 7, lounge: 8, bad: -1, worse: 1.5 } },
    notvac: { entity: 'light.demo_x' },
    oddsvc: { entity: 'vacuum.demo_two', segmentService: 'not a service', battery: 'light.nope' }
  });
  // Mutation: drop the isEntity(b.entity, 'vacuum') guard -> 'notvac' kept -> fails.
  check('bindings: non-vacuum entity dropped', m.size === 2 && !m.has('notvac'), [...m.keys()]);
  const d = m.get('dock');
  // Mutation: `n >= 0` -> `n >= -5` -> the -1 segment kept -> fails.
  check('bindings: only integer segments >= 0', JSON.stringify(d.segments) === JSON.stringify([{ roomId: 'kitchen', segment: 7 }, { roomId: 'lounge', segment: 8 }]), d.segments);
  check('bindings: battery kept', d.battery === 'sensor.demo_robot_battery');
  check('bindings: default segment service', d.segmentService === V.DEFAULT_SEGMENT_SERVICE);
  const o = m.get('oddsvc');
  check('bindings: malformed service -> default; non-sensor battery dropped', o.segmentService === V.DEFAULT_SEGMENT_SERVICE && o.battery === null, o);
  check('bindings: nothing bound -> empty', V.normaliseVacuumBindings(undefined).size === 0);
}

// ---- 2. parseVacuum ------------------------------------------------------------
{
  const r = V.parseVacuum({ state: 'docked', attributes: { status: 'charging_completed', battery_level: 90 } }, { state: '100' });
  // Mutation: prefer attributes.battery_level over the sensor -> 90 -> fails.
  check('parse: battery sensor wins', r.battery === 100, r);
  check('parse: state + status', r.available && r.state === 'docked' && r.status === 'charging_completed', r);
  check('parse: battery from the attribute when no sensor', V.parseVacuum({ state: 'cleaning', attributes: { battery_level: 55.4 } }).battery === 55);
  const u = V.parseVacuum({ state: 'unavailable', attributes: {} });
  // Mutation: available = typeof st === 'string' -> 'unavailable' counts -> fails.
  check('parse: unavailable', !u.available && u.state === null, u);
  const e = V.parseVacuum({ state: 'error', attributes: { error: 'right_wheel_motor' } });
  check('parse: error names its fault', e.state === 'error' && e.error === 'right_wheel_motor', e);
  check('parse: "no_error" is not an error', V.parseVacuum({ state: 'docked', attributes: { error: 'no_error' } }).error === null);
  check('parse: an unknown state string is not a state', V.parseVacuum({ state: 'dancing' }).state === null);
  check('status text: error', V.vacuumStatusText(e) === 'Error: Right wheel motor', V.vacuumStatusText(e));
  check('status text: status wins over state', V.vacuumStatusText(r) === 'Charging completed');
  check('status text: unavailable', V.vacuumStatusText(u) === 'Unavailable');
}

// ---- 3. actions and commands ---------------------------------------------------
{
  const R = V.MOCK_VACUUM_READINGS;
  const a = s => V.vacuumActions(R[s]);
  // Mutation: start: true always -> cleaning allows start -> fails.
  check('actions: cleaning -> pause + dock only', !a('cleaning').start && a('cleaning').pause && a('cleaning').dock, a('cleaning'));
  // Mutation: dock: true always -> fails.
  check('actions: docked -> start only', a('docked').start && !a('docked').pause && !a('docked').dock, a('docked'));
  check('actions: paused -> resume', a('paused').start && a('paused').resume && !a('paused').pause && a('paused').dock);
  check('actions: returning -> pause and start', a('returning').pause && a('returning').start && a('returning').dock);
  check('actions: unavailable -> nothing', !a('unavailable').start && !a('unavailable').pause && !a('unavailable').dock);
  check('actions: no reading -> nothing', !V.vacuumActions(null).start);

  const c = V.vacuumCommand('dock', 'vacuum.demo_robot', R.cleaning);
  // Mutation: SERVICE.dock 'return_to_base' -> 'dock' -> fails.
  check('command: dock -> vacuum.return_to_base', c && c.domain === 'vacuum' && c.service === 'return_to_base' &&
    c.target.entity_id === 'vacuum.demo_robot' && Object.keys(c.data).length === 0, c);
  check('command: start -> vacuum.start', (V.vacuumCommand('start', 'vacuum.demo_robot', R.docked) || {}).service === 'start');
  check('command: pause -> vacuum.pause', (V.vacuumCommand('pause', 'vacuum.demo_robot', R.cleaning) || {}).service === 'pause');
  // Mutation: remove the vacuumActions guard in vacuumCommand -> fails.
  check('command: refused when it cannot apply (start while cleaning)', V.vacuumCommand('start', 'vacuum.demo_robot', R.cleaning) === null);
  check('command: refused when unavailable', V.vacuumCommand('start', 'vacuum.demo_robot', R.unavailable) === null);
  check('command: refused for a non-vacuum entity', V.vacuumCommand('start', 'light.demo_x', R.docked) === null);
  check('command: refused for an unknown action', V.vacuumCommand('turn_off', 'vacuum.demo_robot', R.docked) === null);
}

// ---- 4. segment clean ----------------------------------------------------------
{
  const R = V.MOCK_VACUUM_READINGS;
  const c = V.vacuumSegmentCommand('vacuum.demo_robot', 7, R.docked);
  // Mutation: data: { segments: segment } (not an array) -> fails.
  check('segment: default service, segments array', c && c.domain === 'dreame_vacuum' && c.service === 'vacuum_clean_segment' &&
    JSON.stringify(c.data) === '{"segments":[7]}' && c.target.entity_id === 'vacuum.demo_robot', c);
  const o = V.vacuumSegmentCommand('vacuum.demo_robot', 3, R.docked, 'other_vac.clean_room');
  check('segment: a named service', o && o.domain === 'other_vac' && o.service === 'clean_room', o);
  check('segment: refused while cleaning', V.vacuumSegmentCommand('vacuum.demo_robot', 7, R.cleaning) === null);
  check('segment: refused for a bad segment', V.vacuumSegmentCommand('vacuum.demo_robot', -2, R.docked) === null &&
    V.vacuumSegmentCommand('vacuum.demo_robot', '7', R.docked) === null);
  check('mock: start from docked -> cleaning', (V.mockVacuumAfter('start', R.docked) || {}).state === 'cleaning');
  check('mock: dock from cleaning -> returning', (V.mockVacuumAfter('dock', R.cleaning) || {}).state === 'returning');
  check('mock: start while cleaning -> nothing', V.mockVacuumAfter('start', R.cleaning) === null);
}

// ---- 5. the client, against the fake HA ----------------------------------------
{
  const vac = (state, extra) => ({ entity_id: 'vacuum.demo_robot', state, attributes: Object.assign({ status: state === 'docked' ? 'charging_completed' : state }, extra || {}) });
  const bat = v => ({ entity_id: 'sensor.demo_robot_battery', state: String(v), attributes: {} });
  // The robot is listed BEFORE its battery sensor, on purpose: the snapshot
  // must still report the robot once, with its battery.
  const states = [vac('docked', { cleaning_time: 0 }), bat(88)];
  const fake = installFakeHA({ states });
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, wsReconnectMs: 15,
      sensors: { vacuums: { kitchen_robot: { entity: 'vacuum.demo_robot', battery: 'sensor.demo_robot_battery', segments: { kitchen: 7 } } } } });
    const seen = [];
    ha.onVacuumChange((id, r) => seen.push({ id, r }));
    ha.connect();
    await fake.whenConnected(ha);
    // Mutations: drop the post-loop resolveVacuum in the snapshot -> none;
    // resolve inside the loop -> two (battery null, then 88) -> fails.
    check('client: snapshot fires one reading', seen.length === 1 && seen[0].id === 'kitchen_robot' &&
      seen[0].r.state === 'docked' && seen[0].r.battery === 88, seen);
    check('client: getVacuum', (ha.getVacuum('kitchen_robot') || {}).battery === 88);
    check('client: vacuumBinding', (ha.vacuumBinding('kitchen_robot') || {}).entity === 'vacuum.demo_robot');

    const sock = () => fake.sockets[fake.sockets.length - 1];
    sock().emitStateChanged(vac('docked', { cleaning_time: 5 }));
    await sleep(10);
    // Mutation: drop the `prev.key === key` early return -> fires -> fails.
    check('client: an attribute-only republish fires nothing', seen.length === 1, seen.length);
    sock().emitStateChanged(bat(87));
    await sleep(10);
    check('client: a battery change fires', seen.length === 2 && seen[1].r.battery === 87, seen.length);

    const callsBefore = fake.calls.length;
    states[1] = bat(87);   // HA's value is unchanged across the outage
    sock().close();
    await sleep(30);
    await fake.whenConnected(ha, 2000);
    await sleep(10);
    // Mutation: drop the vacuumResolved loop in reapplyAll -> fails.
    check('client: a reconnect with nothing changed re-emits once', seen.length === 3 && seen[2].r.battery === 87, seen.length);
    check('client: the resync sends no command', fake.calls.length === callsBefore, fake.calls.slice(callsBefore));

    // A button press, the way the popover and the sidebar send it.
    const cmd = HAClient.vacuumCommand('start', 'vacuum.demo_robot', ha.getVacuum('kitchen_robot'));
    const ok = ha.callService(cmd.domain, cmd.service, cmd.data, cmd.target);
    await sleep(10);
    const last = fake.calls[fake.calls.length - 1];
    check('client: Start is one vacuum.start call_service', ok === true && fake.calls.length === callsBefore + 1 &&
      last.service === 'vacuum/start' && last.msg.target.entity_id === 'vacuum.demo_robot', last);
    const seg = HAClient.vacuumSegmentCommand('vacuum.demo_robot', 7, ha.getVacuum('kitchen_robot'));
    ha.callService(seg.domain, seg.service, seg.data, seg.target);
    await sleep(10);
    const last2 = fake.calls[fake.calls.length - 1];
    check('client: a room clean is one dreame_vacuum.vacuum_clean_segment call', last2.service === 'dreame_vacuum/vacuum_clean_segment' &&
      JSON.stringify(last2.msg.service_data) === '{"segments":[7]}', last2);
    check('client: nothing over REST', fake.fetches.length === 0, fake.fetches);
    ha.disconnect();
  } finally {
    console.log = log; console.warn = warn;
    fake.restore();
  }
}

// ---- 6. picking a vacuum by where the tap landed, and its card -------------
{
  const T = await imp('src/tap-popovers.js');
  const F = await imp('src/furniture.js');
  const byId = {
    rug: { type: 'rug', worldBox: { min: [0, 0, 0], max: [3, 0.02, 2] } },
    robot: { type: 'robot-vacuum', worldBox: { min: [1, 0, 1], max: [1.35, 0.59, 1.48] } },
    sofa: { type: 'sofa', worldBox: { min: [2, 0, 0], max: [3, 0.9, 1] } }
  };
  // Mutation: `vol < bestVol` -> `vol > bestVol` -> the rug wins -> fails.
  check('furnitureItemAt: the smallest containing box wins', (F.furnitureItemAt(byId, { x: 1.1, y: 0.01, z: 1.2 }) || {}).id === 'robot');
  check('furnitureItemAt: onlyIds filters', F.furnitureItemAt(byId, { x: 2.5, y: 0.5, z: 0.5 }, new Set(['robot'])) === null);
  check('furnitureItemAt: a point on a face counts (1 cm pad)', (F.furnitureItemAt(byId, { x: 1.355, y: 0.3, z: 1.2 }, new Set(['robot'])) || {}).id === 'robot');
  check('furnitureItemAt: outside -> null', F.furnitureItemAt(byId, { x: 5, y: 0, z: 5 }) === null);

  const mesh = (name, opacity) => ({ isMesh: true, name, visible: true, parent: null, userData: {},
    material: { transparent: opacity < 1, opacity, visible: true } });
  const wall = mesh('wall', 1), faded = mesh('faded', 0.05), bucket = mesh('bucket', 1);
  const deviceAt = h => (h.object === bucket ? { kind: 'vacuum', id: 'robot' } : null);
  const r1 = T.pickFromHits([{ object: faded, point: {} }, { object: bucket, point: {} }], {}, deviceAt);
  // Mutation: drop the deviceAt call in pickFromHits -> fails.
  check('pickFromHits: a device behind a see-through wall is picked', r1.target && r1.target.kind === 'vacuum', r1);
  const r2 = T.pickFromHits([{ object: wall, point: {} }, { object: bucket, point: {} }], {}, deviceAt);
  // Mutation: ask deviceAt about every hit, not just the first solid one -> fails.
  check('pickFromHits: a solid wall in front still occludes it', !r2.target && r2.hit.object === wall, r2);
  check('pickFromHits: no deviceAt -> as before', T.pickFromHits([{ object: bucket, point: {} }], {}).target === null);
  // A see-through hit is never asked, even if its point lies in the box.
  const everywhere = h => ({ kind: 'vacuum', id: 'robot', via: h.object.name });
  const r3 = T.pickFromHits([{ object: faded, point: {} }, { object: wall, point: {} }], {}, everywhere);
  // Mutation: ask deviceAt before the see-through skip -> the faded hit wins -> fails.
  check('pickFromHits: deviceAt asked about the first SOLID hit only', r3.target && r3.target.via === 'wall', r3.target);

  const R = V.MOCK_VACUUM_READINGS;
  const dot = k => '<i data-st="' + k + '"></i>';
  const card = (reading, haOff) => T.popoverHtml.vacuum({ name: 'Robot', status: 'ok', haOff: !!haOff, reading,
    actions: V.vacuumActions(reading), rooms: [{ roomId: 'kitchen', name: 'Kitchen' }] }, dot);
  const disabled = (html, a) => new RegExp('data-a="' + a + '"[^>]*disabled').test(html);
  const docked = card(R.docked);
  // Mutation: dis(a.dock) -> dis(true) -> dock enabled while docked -> fails.
  check('card: docked -> Start on, Pause and Dock off', !disabled(docked, 'start') && disabled(docked, 'pause') && disabled(docked, 'dock'));
  check('card: status and battery shown', docked.indexOf('Charging completed') !== -1 && docked.indexOf('100%') !== -1);
  check('card: a room chip per bound segment', /data-a="room" data-room="kitchen"/.test(docked));
  const cleaning = card(R.cleaning);
  check('card: cleaning -> Start and rooms off, Pause on', disabled(cleaning, 'start') && !disabled(cleaning, 'pause') && disabled(cleaning, 'room'));
  check('card: paused -> Resume', card(R.paused).indexOf('Resume') !== -1);
  const off = card(R.docked, true);
  // Mutation: dis = ok => (!ok ? ...) (ignore haOff) -> fails.
  check('card: HA offline -> every button disabled', disabled(off, 'start') && disabled(off, 'room') && off.indexOf('HA offline') !== -1);
  const na = card(R.unavailable);
  check('card: unavailable -> no buttons', na.indexOf('data-a="start"') === -1 && na.indexOf('Unavailable') !== -1);
  check('card: an error names the fault', card(R.error).indexOf('Right wheel motor') !== -1);
}

console.log(failures ? 'FAILED -- ' + failures + ' failed, ' + passes + ' passed' : 'ok -- ' + passes + ' passed, 0 failed');
process.exit(failures ? 1 : 0);
