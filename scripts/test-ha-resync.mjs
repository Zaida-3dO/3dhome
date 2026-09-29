/**
 * Home Assistant offline: controls disabled, and a full resync on reconnect.
 *
 * The bug (P1): with the WebSocket down, the room panel's curtain slider and
 * thermostat target stayed ENABLED. A drag moved the panel and the 3D model,
 * the command was dropped (no socket), and after reconnecting the panel kept
 * showing the unsent value ("Open: 30%", "Target: 25.0°C") while HA said
 * 100% / 21°C. Every non-light path in ha-client notifies only on a CHANGE of
 * its resolved value, so HA's unchanged value in the reconnect snapshot was
 * swallowed as a no-op. Lights recovered only because processStateUpdate
 * always fires for a snapshot entity.
 *
 * This pins both halves against the fake HA WebSocket
 * (scripts/fake-ha-websocket.mjs), never a real HA:
 *
 *   1. room-panel: haOffline() is true for every status but 'connected' (and
 *      false with no client at all -- the demo house); every command control
 *      in every row is rendered disabled while offline; the drag sender
 *      dispatches nothing while not writable, and commit still releases the
 *      lock and drops a pending send.
 *   2. Disconnect -> offline; a drag through the real sender + the real
 *      callServiceDebounced sends nothing; a send queued before the drop is
 *      cancelled and never replays after a fast reconnect.
 *   3. Reconnect with HA's value UNCHANGED -> every curtain, cornice,
 *      availability, sensor and climate callback fires again, so a panel
 *      model the user diverged (30% / 25°C) is back to HA's 100% / 21°C.
 *      A value that DID change fires exactly once with the new value.
 *   4. The resync emits ZERO call_service, and nothing but auth, get_states
 *      and subscribe_events goes over the socket.
 *   5. First connect: each target fires exactly once (no double emission).
 *   6. index.html (source level): every write handler in wireRoomControls
 *      goes through onWrite (the offline gate), the lock-release handlers do
 *      not, sendToHA refuses while offline, both senders are writable-gated,
 *      and a status change repaints the open room -- after putting any
 *      curtain cut off mid-drag back to HA's last report (349848ef).
 *   8. HA drops inside a drag's debounce window: the panel and 3D curtain go
 *      back to HA's value while still offline, and nothing is sent.
 *
 * No framework, no install: `node scripts/test-ha-resync.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Quiet the client's own logging (connect lines, "dropped" warnings).
const realLog = console.log;
const realWarn = console.warn;
const quiet = fn => async () => {
  console.log = (...a) => { if (/^\s+(ok|FAIL)/.test(String(a[0]))) realLog(...a); };
  console.warn = () => {};
  try { await fn(); } finally { console.log = realLog; console.warn = realWarn; }
};

const { HAClient } = await imp('src/ha-client.js');
const RP = await imp('src/room-panel.js');

// Fictional entity ids only -- this repo is public.
const E = {
  light: 'light.demo_lounge_main',
  cover: 'cover.demo_lounge_curtain',
  cornice: 'light.demo_lounge_cornice',
  trv: 'climate.demo_lounge_radiator',
  motion: 'binary_sensor.demo_lounge_motion',
  door: 'binary_sensor.demo_lounge_door',
};
const ROOMS = { lounge: { main: [E.light] } };
const SENSORS = {
  curtains: { lounge_curtain: [E.cover] },
  corniceLights: { lounge_curtain: [E.cornice] },
  climate: { lounge: E.trv },
  presence: { lounge: [E.motion] },
  doors: { lounge_door: [E.door] },
};
const coverState = pos => ({ entity_id: E.cover, state: pos > 0 ? 'open' : 'closed', attributes: { current_position: pos } });
const trvState = target => ({ entity_id: E.trv, state: 'heat',
  attributes: { current_temperature: 20.4, temperature: target, min_temp: 5, max_temp: 30, target_temp_step: 0.5 } });
function haStates({ pos = 100, target = 21 } = {}) {
  return [
    { entity_id: E.light, state: 'on', attributes: { brightness: 255, color_temp_kelvin: 3000 } },
    coverState(pos),
    { entity_id: E.cornice, state: 'on', attributes: { brightness: 128, rgb_color: [255, 170, 0] } },
    trvState(target),
    { entity_id: E.motion, state: 'off', attributes: {} },
    { entity_id: E.door, state: 'on', attributes: {} },
  ];
}

/**
 * A stand-in for index.html's wiring: the SAME callbacks drive a panel/3D
 * model, and the SAME senders (createDragSender, writable-gated, dispatching
 * through the real callServiceDebounced with a fire-time guard) write.
 */
function wirePanel(ha) {
  const model = { curtainPct: new Map(), scene3dCurtain: new Map(), climate: new Map(), light: new Map(),
    cornice: new Map(), available: new Map(), presence: new Map(), door: new Map(), status: new Map() };
  const log = [];   // every callback, with the client's status at the time
  const tag = (kind, id) => log.push({ kind, id, status: ha.status });
  ha.onCurtainChange((id, st) => { tag('curtain', id); model.curtainPct.set(id, st.pct); model.scene3dCurtain.set(id, st.pct); });
  ha.onCorniceChange((id, st) => { tag('cornice', id); model.cornice.set(id, st); });
  ha.onCurtainAvailabilityChange((id, a) => { tag('available', id); model.available.set(id, a); });
  ha.onClimateChange((id, r) => { tag('climate', id); model.climate.set(id, r.target); });
  ha.onStateChange((roomId, group, st) => { tag('light', roomId + '/' + group); model.light.set(roomId + '/' + group, st.on); });
  ha.onPresenceChange((id, on) => { tag('presence', id); model.presence.set(id, on); });
  ha.onDoorChange((id, on) => { tag('door', id); model.door.set(id, on); });
  ha.onSensorStatusChange((kind, id, st) => { tag('status', kind + ':' + id); model.status.set(kind + ':' + id, st); });
  const writable = () => !RP.haOffline(ha);
  const curtainSender = RP.createDragSender({
    build: (id, pct) => RP.curtainSliderCommand(HAClient.coverPositionCommand, pct, SENSORS.curtains[id], model.available.get(id) === true),
    dispatch: (cmd, id, delayMs) => ha.callServiceDebounced(cmd.domain, cmd.service, cmd.data, cmd.target, 'curtain-' + id, delayMs,
      () => model.available.get(id) === true),
    cancel: id => ha.cancelDebounced('curtain-' + id),
    writable,
  });
  const climateSender = RP.createDragSender({
    build: (roomId, v) => HAClient.climateTargetCommand(v, SENSORS.climate[roomId], ha.getClimate(roomId)),
    dispatch: (cmd, roomId, delayMs) => ha.callServiceDebounced(cmd.domain, cmd.service, cmd.data, cmd.target, 'climate-' + roomId, delayMs),
    cancel: roomId => ha.cancelDebounced('climate-' + roomId),
    writable,
  });
  // index.html's onWrite: the user's drag only touches the model when online.
  const userDragCurtain = (id, pct) => { if (!writable()) return; model.curtainPct.set(id, pct); model.scene3dCurtain.set(id, pct); curtainSender.input(id, pct); };
  const userDragClimate = (roomId, v) => { if (!writable()) return; model.climate.set(roomId, v); climateSender.input(roomId, v); };
  return { model, log, curtainSender, climateSender, userDragCurtain, userDragClimate };
}

async function until(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) return false; await sleep(5); }
  return true;
}

// ---------------------------------------------------------------------------
// 1. room-panel: offline predicate, disabled markup, writable-gated sender
// ---------------------------------------------------------------------------
{
  check('haOffline: no client (demo house) is NOT offline', RP.haOffline(null) === false);
  check('haOffline: connected -> online', RP.haOffline({ status: 'connected' }) === false);
  for (const st of ['disconnected', 'syncing', 'auth_failed', 'sync_failed', 'polling', undefined]) {
    check('haOffline: ' + st + ' -> offline', RP.haOffline({ status: st }) === true);
  }

  const light = { on: true, bri: 60, temp: 3000, color: '#ff3300' };
  const rows = offline => ({
    main: RP.mainLightRowHtml(light, offline),
    ambient: RP.ambientRowHtml(light, 'Ambience', offline),
    galaxy: RP.galaxyRowHtml(light, offline),
    curtain: RP.curtainRowHtml({ id: 'lounge_curtain', label: 'Lounge Curtain' }, 100, true, offline),
    climate: RP.climateRowHtml(HAClient.parseClimate(trvState(21)), offline),
  });
  // Every element carrying data-action is a control that sends a command.
  const controls = html => html.match(/<(?:button|input)\b[^>]*data-action="[^"]+"[^>]*>/g) || [];
  const on = rows(false), off = rows(true);
  for (const k of Object.keys(on)) {
    const cOn = controls(on[k]), cOff = controls(off[k]);
    check(k + ' row: has command controls', cOn.length > 0 && cOn.length === cOff.length, { on: cOn.length, off: cOff.length });
    check(k + ' row: every control ENABLED while connected', cOn.every(c => !/\sdisabled\b/.test(c)), cOn.filter(c => /\sdisabled\b/.test(c)));
    check(k + ' row: every control DISABLED while HA offline', cOff.every(c => /\sdisabled\b/.test(c)), cOff.filter(c => !/\sdisabled\b/.test(c)));
  }
  check('offline note names the state', /HA offline/.test(RP.haOfflineRowHtml()) && /data-row="ha-offline"/.test(RP.haOfflineRowHtml()));

  const sent = [];
  let cancelled = 0, released = 0;
  let w = false;
  const s = RP.createDragSender({
    build: (id, v) => ({ domain: 'cover', service: 'set_cover_position', data: { position: v }, target: { entity_id: 'x' } }),
    dispatch: (cmd, id, d) => sent.push({ cmd, d }),
    cancel: () => cancelled++,
    onRelease: () => released++,
    writable: () => w,
  });
  check('sender offline: input dispatches nothing', s.input('c', 30) === null && sent.length === 0);
  check('sender offline: input does not start a drag lock', !s.isDragging('c'));
  check('sender offline: press dispatches nothing', s.press('c', { data: {} }) === null && sent.length === 0);
  w = true; s.input('c', 40); w = false;
  const c0 = cancelled;
  check('sender offline: commit sends nothing', s.commit('c', 45) === null && sent.length === 1, sent.length);
  check('sender offline: commit drops the pending send and releases the lock', cancelled === c0 + 1 && !s.isDragging('c') && released === 1);
  w = true;
  check('sender online again: sends', s.input('c', 50) !== null && sent.length === 2);
}

// ---------------------------------------------------------------------------
// 2-5. Against the fake HA WebSocket
// ---------------------------------------------------------------------------
await quiet(async () => {
  const states = haStates();
  const fake = installFakeHA({ states });
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: ROOMS, sensors: SENSORS, wsReconnectMs: 15 });
    const p = wirePanel(ha);
    ha.connect();
    await fake.whenConnected(ha);

    // --- 5. first connect: one emission per target, all before 'connected' ---
    const count = (kind, id) => p.log.filter(l => l.kind === kind && l.id === id).length;
    check('first connect: curtain fired exactly once', count('curtain', 'lounge_curtain') === 1, count('curtain', 'lounge_curtain'));
    check('first connect: climate fired exactly once', count('climate', 'lounge') === 1, count('climate', 'lounge'));
    check('first connect: cornice fired exactly once', count('cornice', 'lounge_curtain') === 1);
    check('first connect: panel shows HA', p.model.curtainPct.get('lounge_curtain') === 100 && p.model.climate.get('lounge') === 21);
    check('connected: controls enabled', RP.haOffline(ha) === false);

    // --- 2. disconnect ---
    // A send queued just before the drop (debounced, not yet fired), under a
    // key nothing below touches, so only the client's own drop-on-close can
    // stop it from replaying after the fast reconnect.
    ha.callServiceDebounced('light', 'turn_off', {}, { entity_id: [E.light] }, 'lounge-main', 200);
    fake.sockets[fake.sockets.length - 1].close();
    await until(() => ha.status === 'disconnected', 500);
    check('disconnect: status disconnected', ha.status === 'disconnected', ha.status);
    check('disconnect: controls offline (disabled)', RP.haOffline(ha) === true);

    // A drag while disconnected: through the real handler gate and sender.
    const before = { pct: p.model.curtainPct.get('lounge_curtain'), scene: p.model.scene3dCurtain.get('lounge_curtain'), t: p.model.climate.get('lounge') };
    p.userDragCurtain('lounge_curtain', 30);
    p.userDragClimate('lounge', 25);
    check('drag while disconnected: panel curtain unchanged', p.model.curtainPct.get('lounge_curtain') === before.pct, p.model.curtainPct.get('lounge_curtain'));
    check('drag while disconnected: 3D curtain unchanged', p.model.scene3dCurtain.get('lounge_curtain') === before.scene);
    check('drag while disconnected: target unchanged', p.model.climate.get('lounge') === before.t);
    // Even straight at the sender (a drag already under way when the socket dropped).
    check('drag while disconnected: sender builds no send', p.curtainSender.input('lounge_curtain', 30) === null
      && p.climateSender.input('lounge', 25) === null && p.curtainSender.commit('lounge_curtain', 30) === null);
    check('drag while disconnected: callService refuses', ha.callService('cover', 'set_cover_position', { position: 30 }, { entity_id: E.cover }) === false);

    // --- 3. reconnect, HA's values UNCHANGED ---
    // Simulate a divergence the panel's gate cannot see (e.g. a tap popover's
    // offline preview on the model), which the resync must erase.
    p.model.curtainPct.set('lounge_curtain', 30); p.model.scene3dCurtain.set('lounge_curtain', 30); p.model.climate.set('lounge', 25);
    p.model.light.set('lounge/main', false); p.model.cornice.set('lounge_curtain', null);
    p.model.available.set('lounge_curtain', false); p.model.presence.set('lounge', true); p.model.door.set('lounge_door', false);
    p.model.status.set('door:lounge_door', 'off');
    const callsBefore = fake.calls.length;
    const sentBefore = fake.sent.length;
    const logBefore = p.log.length;
    await fake.whenConnected(ha, 2000);
    await sleep(300);   // past the 200 ms debounce of the send queued before the drop
    const resync = p.log.slice(logBefore);
    const rc = (kind, id) => resync.filter(l => l.kind === kind && l.id === id).length;

    check('reconnect: panel curtain back to HA (100%)', p.model.curtainPct.get('lounge_curtain') === 100, p.model.curtainPct.get('lounge_curtain'));
    check('reconnect: 3D curtain back to HA (100%)', p.model.scene3dCurtain.get('lounge_curtain') === 100);
    check('reconnect: target back to HA (21)', p.model.climate.get('lounge') === 21, p.model.climate.get('lounge'));
    check('reconnect: light back to HA (on)', p.model.light.get('lounge/main') === true);
    check('reconnect: cornice re-applied', p.model.cornice.get('lounge_curtain') && p.model.cornice.get('lounge_curtain').on === true);
    check('reconnect: curtain availability re-applied', p.model.available.get('lounge_curtain') === true);
    check('reconnect: presence re-applied', p.model.presence.get('lounge') === false);
    check('reconnect: door re-applied', p.model.door.get('lounge_door') === true);
    check('reconnect: door status re-applied', p.model.status.get('door:lounge_door') === 'on');
    check('reconnect: each unchanged target re-emitted exactly once',
      rc('curtain', 'lounge_curtain') === 1 && rc('climate', 'lounge') === 1 && rc('cornice', 'lounge_curtain') === 1
      && rc('available', 'lounge_curtain') === 1 && rc('presence', 'lounge') === 1 && rc('door', 'lounge_door') === 1,
      resync.map(l => l.kind + ':' + l.id));
    check('reconnect: resync lands BEFORE the controls re-enable', resync.length > 0 && resync.every(l => l.status !== 'connected'),
      resync.map(l => l.status));
    check('reconnect: controls enabled again', RP.haOffline(ha) === false);

    // --- 4. the resync sends nothing ---
    check('resync: ZERO call_service (incl. the send queued before the drop)', fake.calls.length === callsBefore, fake.calls.slice(callsBefore));
    const newTypes = fake.sent.slice(sentBefore).map(m => m.type);
    check('resync: only auth / get_states / subscribe_events on the socket',
      newTypes.every(t => t === 'auth' || t === 'get_states' || t === 'subscribe_events') && newTypes.includes('get_states'), newTypes);
    check('resync: no fetch()', fake.fetches.length === 0, fake.fetches);

    // --- 3b. reconnect after HA's value CHANGED: fires once, new value ---
    states.splice(0, states.length, ...haStates({ pos: 40, target: 19 }));
    const log2 = p.log.length;
    fake.sockets[fake.sockets.length - 1].close();
    await until(() => ha.status === 'disconnected', 500);
    await fake.whenConnected(ha, 2000);
    const r2 = p.log.slice(log2);
    check('changed during outage: curtain fires once with HA\'s new value',
      r2.filter(l => l.kind === 'curtain').length === 1 && p.model.curtainPct.get('lounge_curtain') === 40, r2.map(l => l.kind));
    check('changed during outage: target fires once with HA\'s new value',
      r2.filter(l => l.kind === 'climate').length === 1 && p.model.climate.get('lounge') === 19);

    // A live event after the resync still dedupes (no regression of the
    // "an attribute republish is not a render" rule).
    const log3 = p.log.length;
    fake.sockets[fake.sockets.length - 1].emitStateChanged({ ...coverState(40), attributes: { current_position: 40, battery: 90 } });
    await sleep(20);
    check('live republish after resync: still deduped', p.log.slice(log3).filter(l => l.kind === 'curtain').length === 0);

    // Online again: a user drag does send (the gate is not stuck shut).
    p.userDragCurtain('lounge_curtain', 55);
    p.curtainSender.commit('lounge_curtain', 55);
    await sleep(300);   // past the debounce: the release must not double-send
    check('online: a user drag sends exactly one command', fake.calls.length === callsBefore + 1
      && fake.calls[fake.calls.length - 1].body.position === 55, fake.calls.slice(callsBefore));

    ha.disconnect();
  } finally {
    fake.restore();
  }
})();

// ---------------------------------------------------------------------------
// 8. HA drops INSIDE a drag's debounce window (item 349848ef)
// ---------------------------------------------------------------------------
// The drag's value (30) was never sent. While offline, the panel and the 3D
// curtain must show HA's last report (100), not the unsent 30. The status
// handler below mirrors index.html's (pinned at source level in 6).
await quiet(async () => {
  const fake = installFakeHA({ states: haStates() });
  try {
    // A long reconnect delay: the checks below all run while still offline.
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: ROOMS, sensors: SENSORS, wsReconnectMs: 10000 });
    const p = wirePanel(ha);
    const reported = new Map();
    ha.onCurtainChange((id, st) => reported.set(id, st.pct));
    let reverts = null;
    ha.onStatusChange(status => {
      if (status === 'connected') return;
      reverts = RP.curtainsToRevert(p.model.curtainPct, reported);
      reverts.forEach(([id, pct]) => { p.model.curtainPct.set(id, pct); p.model.scene3dCurtain.set(id, pct); });
    });
    ha.connect();
    await fake.whenConnected(ha);
    const calls0 = fake.calls.length;
    p.userDragCurtain('lounge_curtain', 30);   // through the real sender: a 200 ms debounced send
    check('mid-drag: panel and 3D show the drag (30)',
      p.model.curtainPct.get('lounge_curtain') === 30 && p.model.scene3dCurtain.get('lounge_curtain') === 30);
    const t0 = Date.now();
    fake.sockets[fake.sockets.length - 1].close();
    await until(() => ha.status === 'disconnected', 150);
    const dropMs = Date.now() - t0;
    check('socket dropped inside the debounce window', ha.status === 'disconnected' && dropMs < 200, { status: ha.status, dropMs });
    check('offline: curtainsToRevert yields HA\'s 100', JSON.stringify(reverts) === JSON.stringify([['lounge_curtain', 100]]), reverts);
    check('offline: panel curtain back to HA\'s 100 while still offline',
      p.model.curtainPct.get('lounge_curtain') === 100 && ha.status !== 'connected', p.model.curtainPct.get('lounge_curtain'));
    check('offline: 3D curtain back to HA\'s 100', p.model.scene3dCurtain.get('lounge_curtain') === 100);
    await sleep(300);   // past the debounce: the cut-off drag must never fire
    check('offline: ZERO call_service for the cut-off drag', fake.calls.length === calls0, fake.calls.slice(calls0));
    ha.disconnect();
  } finally {
    fake.restore();
  }
})();

// ---------------------------------------------------------------------------
// 6. index.html wiring (source level)
// ---------------------------------------------------------------------------
{
  const html = read('index.html');
  const wire = html.slice(html.indexOf('function wireRoomControls('), html.indexOf('})().catch(', html.indexOf('function wireRoomControls(')));
  check('wireRoomControls found', wire.length > 200);
  check('onWrite gates on haOffline', /const onWrite = \(el, type, fn\) => el\.addEventListener\(type, e => \{ if \(!haOffline\(ha\)\) fn\(e\); \}\)/.test(wire));
  const writes = wire.match(/onWrite\(el, '(click|input)'/g) || [];
  check('every light / ambience / curtain / climate / room-script write handler is gated (12)', writes.length === 12, writes.length);
  check('no ungated click/input handler left', !/el\.addEventListener\('(click|input)'/.test(wire));
  // Seven: the six drag-lock releases (curtain + climate x pointerup /
  // pointercancel / blur) and the room script's key-intent reset on blur.
  check('lock-release handlers stay ungated', (wire.match(/el\.addEventListener\('(pointerup|pointercancel|blur)'/g) || []).length === 7);
  check('sendToHA refuses while offline', /function sendToHA\([^)]*\) \{\s*if \(!ha \|\| !haConfig \|\| haOffline\(ha\)\) return;/.test(html));
  check('both senders are writable-gated', (html.match(/writable: \(\) => !haOffline\(ha\),/g) || []).length === 2);
  const statusAt = html.indexOf('ha.onStatusChange(status => {');
  const statusFn = statusAt >= 0 ? html.slice(statusAt, html.indexOf('\n        });', statusAt)) : '';
  check('status handler found', statusFn.length > 100);
  check('status change repaints the open room', /haStatusText\.textContent = labels\[status\] \|\| 'HA';[\s\S]*if \(selectedRoom && panelReady\) renderPanel\(\);/.test(statusFn));
  // Item 349848ef: going offline puts a drag cut off inside its debounce
  // window back to HA's last report -- 3D, curtainTarget (the row and the
  // popover both read it) and an open popover -- BEFORE the repaint.
  const revert = statusFn.match(/if \(status !== 'connected'\) \{([\s\S]*?)\n          \}\n/);
  const rb = revert ? revert[1] : '';
  check('offline status runs curtainsToRevert(curtainTarget, curtainReported)', /curtainsToRevert\(curtainTarget, curtainReported\)/.test(rb), rb);
  check('...re-applies each to the 3D curtain and curtainTarget',
    /home\.setCurtainOpen\(curtainId, pct, null\);\s*curtainTarget\.set\(curtainId, pct\);/.test(rb), rb);
  check('...refreshes an open tap popover', /tapPopovers\.refresh\(\)/.test(rb), rb);
  check('...before the room repaint', !!revert && statusFn.indexOf(revert[0]) < statusFn.indexOf('renderPanel()'));
  const acr = html.slice(html.indexOf('function applyCurtainReading('), html.indexOf('function applyCurtainAvailable('));
  check('applyCurtainReading records HA\'s report in curtainReported', /curtainReported\.set\(curtainId, pct\);/.test(acr), acr);
  check('only applyCurtainReading writes curtainReported', (html.match(/curtainReported\.set\(/g) || []).length === 1);
  check('tap-popovers exposes refresh() (render, never under a drag)', /\n    refresh: \(\) => render\(false\),/.test(read('src/tap-popovers.js')));
  check('room rows get the offline flag', /curtainRowHtml\(cu, pct, curtainIsAvailable\(cu\.id\), offline\)/.test(html)
    && /mainLightRowHtml\(s\.main, offline\)/.test(html) && /galaxyRowHtml\(s\.galaxy, offline\)/.test(html)
    && /ambientRowHtml\(s\.ambient, ambientRowLabel\(lc\.ambient, rm && rm\.name\), offline, ambientColorable\(rid\)\)/.test(html)
    && /climateRowHtml\(climateReading\.get\(rid\) \|\| null, offline, climateHeating\(rid\)\)/.test(html));
  check('offline note is the first room row', /if \(haOffline\(ha\)\) keys\.push\('ha-offline'\);\s*if \(s\.main\)/.test(html));
}

// ---------------------------------------------------------------------------
// 7. Tap popovers (src/tap-popovers.js): the same rule
// ---------------------------------------------------------------------------
{
  const TP = await imp('src/tap-popovers.js');
  check('popover haOfflineConn: no client (demo) is NOT offline', TP.haOfflineConn(null) === false && TP.haOfflineConn(undefined) === false);
  check('popover haOfflineConn: connected -> online', TP.haOfflineConn('connected') === false);
  for (const st of ['disconnected', 'syncing', 'auth_failed', 'sync_failed', 'polling']) {
    check('popover haOfflineConn: ' + st + ' -> offline', TP.haOfflineConn(st) === true);
  }
  check('popover statusKey: configured + disconnected -> haOffline', TP.statusKey('light', 'disconnected', false) === 'haOffline');
  check('popover statusKey: syncing still the pulsing connecting dot', TP.statusKey('curtain', 'syncing', false) === 'connecting');
  check('popover statusKey: no client -> offline (demo preview)', TP.statusKey('light', null, false) === 'offline');
  check("popover: 'polling' is not live (dead since #58)", TP.isLive('polling') === false && TP.statusKey('light', 'polling', false) === 'haOffline');

  const dot = k => '<button class="tp-status" type="button" data-a="status" data-st="' + k + '"></button>';
  const models = haOff => ({
    light: { status: haOff ? 'haOffline' : 'ok', na: false, haOff, on: true, bri: 60, name: 'Lounge main' },
    ambient: { status: haOff ? 'haOffline' : 'ok', na: false, haOff, on: true, bri: 60, colorable: true, color: '#00ccff', name: 'Lounge ambience' },
    curtain: { status: haOff ? 'haOffline' : 'ok', na: false, haOff, pct: 100, name: 'Lounge curtain' },
    climate: { status: haOff ? 'haOffline' : 'ok', na: false, mock: false, off: false, haOff, current: 20.4, target: 21,
      min: 7, max: 30, step: 0.5, activity: 'idle', name: 'Lounge radiator' },
  });
  // Every control in a card except the status dot sends a command.
  const controls = html => (html.match(/<(?:button|input)\b[^>]*data-a="[^"]+"[^>]*>/g) || []).filter(c => !/data-a="status"/.test(c));
  const on = models(false), off = models(true);
  for (const k of ['light', 'ambient', 'curtain', 'climate']) {
    const view = k === 'ambient' ? 'light' : k;
    const hOn = TP.popoverHtml[view](on[k], dot), hOff = TP.popoverHtml[view](off[k], dot);
    const cOn = controls(hOn), cOff = controls(hOff);
    check('popover ' + k + ': renders its controls in both states', cOn.length > 0 && cOn.length === cOff.length, { on: cOn.length, off: cOff.length });
    check('popover ' + k + ': every control ENABLED while connected', cOn.every(c => !/\sdisabled\b/.test(c)), cOn.filter(c => /\sdisabled\b/.test(c)));
    check('popover ' + k + ': every control DISABLED while HA offline', cOff.every(c => /\sdisabled\b/.test(c)), cOff.filter(c => !/\sdisabled\b/.test(c)));
    check('popover ' + k + ': says "HA offline" only while offline', /data-offline>HA offline</.test(hOff) && !/data-offline/.test(hOn));
  }

  // The write handlers (bind) need a DOM, so they are pinned at source level;
  // the browser check exercises them for real.
  const src = read('src/tap-popovers.js');
  check('popover canSend requires a fully connected client', /const canSend = \(\) => \{ const h = ha\(\); return !!h && h\.status === 'connected'; \};/.test(src));
  check('popover writeBlocked: configured HA not connected (real or simulated)',
    /const writeBlocked = \(\) => \{ const h = ha\(\); return haOfflineConn\(conn\(\)\) \|\| \(!!h && h\.status !== 'connected'\); \};/.test(src));
  const guards = [
    /sw\.addEventListener\('click', \(\) => \{\s*if \(writeBlocked\(\)\) return;/,                         // light power
    /r\.addEventListener\('input', \(\) => \{\s*if \(writeBlocked\(\)\) return;\s*const st = s\(\);/,      // light brightness
    /r\.addEventListener\('input', \(\) => \{\s*if \(writeBlocked\(\)\) return;\s*ctl\.dragging = true;\s*const pct/, // curtain slider
    /const press = cmd => \{\s*if \(writeBlocked\(\)\) return;/,                                          // curtain open/close
    /const apply = \(v, how\) => \{\s*if \(writeBlocked\(\)\) return;/,                                   // climate slider + steps
    /cp\.addEventListener\('input', \(\) => \{\s*if \(writeBlocked\(\)\) return;/,                      // accent colour square
  ];
  guards.forEach((re, i) => check('popover write handler ' + (i + 1) + '/' + guards.length + ' returns first while HA offline (no preview)', re.test(src)));
  check('popover guard count: exactly the 6 write paths', (src.match(/if \(writeBlocked\(\)\) return;/g) || []).length === 6);
  // Every furniture item-card control sends through createItemSender, whose
  // gates are unit-tested in scripts/test-item-cards.mjs (section 9); pinned
  // here: it returns first while blocked, and the runtime hands it the same
  // writeBlocked / canSend as every other card.
  check('item sender returns first while HA offline (no preview)', /return function itemSend\(command, key, delay\) \{\s*if \(d\.writeBlocked\(\)\) return;/.test(src));
  check('item sender is built from the popover writeBlocked / canSend', /const itemSend = createItemSender\(\{ writeBlocked, canSend, mockMode: itemMockMode, ha,/.test(src));
  check('popover climate samples only with no HA configured', /if \(c == null && !reading\) \{/.test(src) && !/offlineConn/.test(src));
  check('popover status table has no polling entry', !/\n  polling: \[/.test(src) && /\n  haOffline: \['bad', 'HA offline'/.test(src));
  const html = read('index.html');
  check("index.html: no dead 'polling' status label or dot", !/polling:\s+'HA Polling'/.test(html) && !/\.ha-status-dot\.polling/.test(html));
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
