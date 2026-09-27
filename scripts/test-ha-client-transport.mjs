/**
 * Home Assistant transport: the WebSocket, and never REST.
 *
 * The live app logged a CORS error on every load:
 *
 *   Access to fetch at '<ha>/api/states' from origin '<app>' has been blocked
 *   by CORS policy: Response to preflight request doesn't pass access control
 *   check ...
 *
 * It came from a REST `GET /api/states` initial snapshot that index.html
 * awaited before loading the house -- redundant, because the WebSocket (no
 * preflight, so no CORS) authenticated moments later and sent `get_states`
 * for the very same snapshot. The client also carried a REST polling
 * fallback (never started) and a REST service-call fallback used whenever
 * the socket was down; both need the same CORS change on HA to ever work
 * from this app's own origin. All three are gone. This pins that:
 *
 *   1. A full session -- connect, snapshot, live event, command -- makes
 *      ZERO fetch() calls, and the snapshot and the command go over the
 *      socket (get_states, call_service with the right payload).
 *   2. A command with no socket (never connected, or after disconnect) is
 *      DROPPED: returns false, sends nothing, and does not fall back to
 *      fetch.
 *   3. A command on a socket that is OPEN but not yet authenticated is
 *      dropped too (HA rejects anything before auth_ok).
 *   4. Source-level: ha-client.js contains no fetch(, HAClient exports no
 *      fetchInitialState / startPolling, index.html never calls either, and
 *      the other modules that talk to HA (room panel, tap popovers) contain
 *      no fetch( either.
 *
 * No framework, no install: `node scripts/test-ha-client-transport.mjs`.
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

// Quiet the client's own connection logging; keep warnings countable.
const realLog = console.log;
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => warns.push(a.join(' '));
const quiet = fn => async () => {
  console.log = (...a) => { if (/^\s+(ok|FAIL)/.test(String(a[0]))) realLog(...a); };
  try { await fn(); } finally { console.log = realLog; }
};

const { HAClient } = await imp('src/ha-client.js');

const ROOMS = { lounge: { main: ['light.lounge'] } };
const STATES = [
  { entity_id: 'light.lounge', state: 'on', attributes: { brightness: 255, color_temp_kelvin: 3000 } },
  { entity_id: 'light.unrelated', state: 'off', attributes: {} }
];

// ---------------------------------------------------------------------------
// 1. A full session over the socket, no fetch at all
// ---------------------------------------------------------------------------
await quiet(async () => {
  const fake = installFakeHA({ states: STATES });
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: ROOMS, sensors: {} });
    const seen = [];
    ha.onStateChange((roomId, group, st) => seen.push({ roomId, group, on: st.on, bri: st.bri }));
    ha.connect();
    await fake.whenConnected(ha);

    check('snapshot requested over the socket (get_states)',
      fake.sent.some(m => m.type === 'get_states'), fake.sent.map(m => m.type));
    check('snapshot applied: the bound light reported on at 100%',
      seen.length === 1 && seen[0].roomId === 'lounge' && seen[0].on === true && seen[0].bri === 100, seen);

    fake.sockets[0].emitStateChanged({ entity_id: 'light.lounge', state: 'off', attributes: {} });
    await sleep(10);
    check('live state_changed applied', seen.length === 2 && seen[1].on === false, seen);

    const sentOk = ha.callService('light', 'turn_on', { brightness_pct: 40 }, { entity_id: 'light.lounge' });
    await sleep(10);
    check('command with the socket up returns true', sentOk === true);
    check('command went over the socket as call_service with the payload',
      fake.calls.length === 1 && fake.calls[0].service === 'light/turn_on' &&
      fake.calls[0].msg.service_data.brightness_pct === 40 &&
      fake.calls[0].msg.target.entity_id === 'light.lounge', fake.calls);

    check('a whole session made ZERO fetch() calls', fake.fetches.length === 0, fake.fetches);
    ha.disconnect();
  } finally { fake.restore(); }
})();

// ---------------------------------------------------------------------------
// 2. No socket -> the command is dropped, never sent over REST
// ---------------------------------------------------------------------------
await quiet(async () => {
  const fake = installFakeHA({ states: STATES });
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: ROOMS, sensors: {} });
    warns.length = 0;
    const r1 = ha.callService('cover', 'set_cover_position', { position: 30 }, { entity_id: 'cover.x' });
    await sleep(10);
    check('never connected: callService returns false', r1 === false);
    check('never connected: nothing sent, no fetch', fake.calls.length === 0 && fake.fetches.length === 0,
      { calls: fake.calls, fetches: fake.fetches });
    check('never connected: the drop is logged, not silent', warns.some(w => /dropped cover\.set_cover_position/.test(w)), warns);

    // The debounced path (sliders) must drop the same way when its timer fires.
    ha.callServiceDebounced('cover', 'set_cover_position', { position: 31 }, { entity_id: 'cover.x' }, 'k', 20);
    await sleep(60);
    check('never connected: a debounced send is dropped at fire time, no fetch',
      fake.calls.length === 0 && fake.fetches.length === 0);

    ha.connect();
    await fake.whenConnected(ha);
    ha.disconnect();
    const r2 = ha.callService('cover', 'set_cover_position', { position: 50 }, { entity_id: 'cover.x' });
    await sleep(10);
    check('after disconnect: dropped (false), no fetch',
      r2 === false && fake.calls.length === 0 && fake.fetches.length === 0, { r2, calls: fake.calls, fetches: fake.fetches });
  } finally { fake.restore(); }
})();

// ---------------------------------------------------------------------------
// 3. Socket OPEN but not yet authenticated -> dropped
// ---------------------------------------------------------------------------
await quiet(async () => {
  const fake = installFakeHA({ states: STATES, holdAuth: true });
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: ROOMS, sensors: {} });
    ha.connect();
    await sleep(20);
    check('precondition: socket is OPEN and the client has sent auth',
      fake.sockets[0] && fake.sockets[0].readyState === 1 && fake.sent.some(m => m.type === 'auth'));
    const r = ha.callService('light', 'turn_off', {}, { entity_id: 'light.lounge' });
    await sleep(10);
    check('before auth_ok: command dropped (false), nothing sent', r === false && fake.calls.length === 0, fake.calls);
    fake.releaseAuth();
    await fake.whenConnected(ha);
    const r2 = ha.callService('light', 'turn_off', {}, { entity_id: 'light.lounge' });
    await sleep(10);
    check('after auth_ok: the same command goes out', r2 === true && fake.calls.length === 1, fake.calls);
    check('no fetch at any point', fake.fetches.length === 0, fake.fetches);
    ha.disconnect();
  } finally { fake.restore(); }
})();

// ---------------------------------------------------------------------------
// 4. Source-level: no browser -> HA REST path anywhere
// ---------------------------------------------------------------------------
{
  // Comments are stripped first: the transport note in ha-client.js talks
  // ABOUT fetch, and that must not count as a call.
  const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const ha = code(read('src/ha-client.js'));
  check('ha-client.js makes no fetch() call', !/\bfetch\s*\(/.test(ha));
  check('ha-client.js has no REST endpoint path', !/\/api\/(states|services|history|camera_proxy)/.test(ha));
  check('HAClient exports no fetchInitialState', !('fetchInitialState' in HAClient));
  const client = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: {} });
  check('client has no startPolling', !('startPolling' in client));
  const html = read('index.html');
  check('index.html never calls fetchInitialState / startPolling',
    !/fetchInitialState|startPolling/.test(html));
  for (const rel of ['src/room-panel.js', 'src/tap-popovers.js']) {
    check(rel + ' makes no fetch() call (commands go through HAClient)', !/\bfetch\s*\(/.test(code(read(rel))));
  }
}

console.warn = realWarn;
if (failures) {
  console.error(failures + ' failed, ' + passes + ' passed');
  process.exit(1);
}
console.log('ok -- ' + passes + ' passed, 0 failed');
