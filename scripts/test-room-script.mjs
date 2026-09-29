#!/usr/bin/env node
/**
 * The room script ("Kill room") button: rooms.json `sensors.roomScripts`.
 * No framework, no install -- `node scripts/test-room-script.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. normaliseRoomScripts: a binding keeps its entity, variables and label
 *      (default 'Kill room'); a non-script entity, an array or non-object
 *      `variables` and a non-object entry are dropped (no button).
 *   2. roomScriptCommand: ONE script.turn_on, target = the script entity,
 *      data = { variables } -- a copy, so a caller cannot mutate the binding.
 *      The same script with different variables per room; identical
 *      variables on two rooms are two identical calls.
 *   3. createTwoStepConfirm: the first press ARMS and sends nothing; a second
 *      press sends exactly once; the arm times out back to idle after
 *      timeoutMs and a press after that only re-arms; a second press inside
 *      minArmMs (a double-tap) is ignored; the result state (sent / failed)
 *      returns to idle after resultMs; writable() false disarms and sends
 *      nothing; reset() disarms; a throwing send reads as failed.
 *   4. End to end over the fake HA WebSocket, through the REAL
 *      HAClient.callService: two presses put exactly one call_service
 *      script/turn_on with the right target and variables on the socket; one
 *      press puts none; a disconnected client sends none (and the confirm
 *      reports failed).
 *   5. Row markup: the label, the armed text, disabled unless HA is 'ok',
 *      and escaping of a profile-supplied label.
 *   6. index.html wiring (source-level): the row is only added for a bound
 *      room; the click handler is the only caller of press(); the render path
 *      only reads .state; losing HA disarms.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { installFakeHA } = await import(pathToFileURL(path.join(root, 'scripts/fake-ha-websocket.mjs')).href);
const { HAClient } = await imp('src/ha-client.js');
const RS = await imp('src/room-script.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 1. normaliseRoomScripts ----------------------------------------------
{
  const m = RS.normaliseRoomScripts({
    lounge: { entity: 'script.demo_off', variables: { area: 'a' } },
    kitchen: { entity: 'script.demo_off', variables: { area: 'a' }, label: '  Room off ' },
    study: { entity: 'script.demo_off' },
    notscript: { entity: 'light.demo_x', variables: {} },
    arrayvars: { entity: 'script.demo_off', variables: ['a'] },
    nullvars: { entity: 'script.demo_off', variables: null },
    bad: 'script.demo_off',
  });
  check('normalise: bound rooms kept', [...m.keys()].join() === 'lounge,kitchen,study', [...m.keys()]);
  check('normalise: default label is Kill room', m.get('lounge').label === 'Kill room', m.get('lounge'));
  check('normalise: label override trimmed', m.get('kitchen').label === 'Room off', m.get('kitchen'));
  check('normalise: no variables -> {}', JSON.stringify(m.get('study').variables) === '{}', m.get('study'));
  check('normalise: nothing -> empty map', RS.normaliseRoomScripts(undefined).size === 0 && RS.normaliseRoomScripts([]).size === 0);
}

// ---- 2. roomScriptCommand ---------------------------------------------------
{
  const b = { entity: 'script.demo_off', variables: { area: 'demo_hall_store' } };
  const cmd = RS.roomScriptCommand(b);
  check('command: script.turn_on', cmd && cmd.domain === 'script' && cmd.service === 'turn_on', cmd);
  check('command: target is the script entity', cmd && cmd.target.entity_id === 'script.demo_off', cmd);
  check('command: variables carried', cmd && JSON.stringify(cmd.data) === JSON.stringify({ variables: { area: 'demo_hall_store' } }), cmd);
  cmd.data.variables.area = 'mutated';
  check('command: variables are a copy', b.variables.area === 'demo_hall_store', b);
  check('command: non-script refused', RS.roomScriptCommand({ entity: 'light.demo_x', variables: {} }) === null);
  check('command: no binding refused', RS.roomScriptCommand(undefined) === null);
  const other = RS.roomScriptCommand({ entity: 'script.demo_off', variables: { area: 'demo_study' } });
  check('command: same script, different variables per room', other.data.variables.area === 'demo_study' && other.target.entity_id === 'script.demo_off');
}

// ---- 3. createTwoStepConfirm (fake clock + timers) --------------------------
function harness(opts = {}) {
  let t = 1000;
  const timers = [];
  const sends = [];
  const states = [];
  let writable = true;
  const c = RS.createTwoStepConfirm({
    send: opts.send || (() => { sends.push(t); return true; }),
    writable: () => writable,
    onChange: s => states.push(s),
    timeoutMs: 4000, resultMs: 2500, minArmMs: 400,
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, live: true }; timers.push(h); return h; },
    clearTimer: h => { if (h) h.live = false; },
  });
  return {
    c, sends, states,
    advance(ms) {
      t += ms;
      timers.filter(h => h.live && h.at <= t).forEach(h => { h.live = false; h.fn(); });
    },
    setWritable(v) { writable = v; },
  };
}
{
  const h = harness();
  check('confirm: starts idle', h.c.state === 'idle');
  const r1 = h.c.press();
  check('confirm: first press arms', h.c.state === 'armed' && r1 === false);
  check('confirm: first press sends NOTHING', h.sends.length === 0, h.sends);
  h.advance(1000);
  const r2 = h.c.press();
  check('confirm: second press sends exactly once', h.sends.length === 1 && r2 === true, h.sends);
  check('confirm: then reads sent', h.c.state === 'sent');
  h.advance(2500);
  check('confirm: sent returns to idle after resultMs', h.c.state === 'idle', h.c.state);
  check('confirm: state sequence', h.states.join() === 'armed,sent,idle', h.states);
  check('confirm: still exactly one send after it settles', h.sends.length === 1);
}
{
  const h = harness();
  h.c.press();
  h.advance(3999);
  check('confirm: still armed just before the timeout', h.c.state === 'armed');
  h.advance(1);
  check('confirm: arm times out to idle', h.c.state === 'idle');
  h.c.press();
  check('confirm: a press after the timeout only re-arms', h.c.state === 'armed' && h.sends.length === 0, h.sends);
  h.advance(500);
  h.c.press();
  check('confirm: ...and the next one sends', h.sends.length === 1);
}
{
  const h = harness();
  h.c.press();
  h.advance(399);
  h.c.press();
  check('confirm: a double-tap inside minArmMs does not send', h.sends.length === 0 && h.c.state === 'armed', h.sends);
  h.advance(1);
  h.c.press();
  check('confirm: a press at minArmMs sends', h.sends.length === 1);
}
{
  const h = harness();
  h.c.press();
  h.setWritable(false);
  h.advance(1000);
  const r = h.c.press();
  check('confirm: offline press disarms and sends nothing', h.sends.length === 0 && r === false && h.c.state === 'idle', h.c.state);
  h.c.press();
  check('confirm: offline first press does not arm', h.c.state === 'idle');
  h.setWritable(true);
  h.c.press();
  h.c.reset();
  check('confirm: reset disarms', h.c.state === 'idle');
  h.advance(1000);
  h.c.press();
  check('confirm: after reset the next press only arms', h.sends.length === 0 && h.c.state === 'armed');
}
{
  const h = harness({ send: () => false });
  h.c.press(); h.advance(500); h.c.press();
  check('confirm: a dropped send reads failed', h.c.state === 'failed');
  h.advance(2500);
  check('confirm: failed returns to idle', h.c.state === 'idle');
  const h2 = harness({ send: () => { throw new Error('boom'); } });
  h2.c.press(); h2.advance(500); h2.c.press();
  check('confirm: a throwing send reads failed', h2.c.state === 'failed');
}

// ---- 4. End to end over the fake HA WebSocket --------------------------------
{
  const fake = installFakeHA({ states: [] });
  const realWarn = console.warn, realLog = console.log;
  console.warn = () => {}; console.log = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: {} });
    ha.connect();
    await fake.whenConnected(ha);
    const binding = RS.normaliseRoomScripts({ hall: { entity: 'script.demo_off', variables: { area: 'demo_hall_store' } } }).get('hall');
    const c = RS.createTwoStepConfirm({
      writable: () => ha.status === 'connected',
      send: () => { const cmd = RS.roomScriptCommand(binding); return ha.callService(cmd.domain, cmd.service, cmd.data, cmd.target); },
      minArmMs: 0, timeoutMs: 4000, resultMs: 50,
    });
    c.press();
    await sleep(20);
    check('e2e: one press puts nothing on the socket', fake.calls.length === 0, fake.calls);
    c.press();
    await sleep(20);
    check('e2e: two presses put exactly ONE call_service on the socket', fake.calls.length === 1, fake.calls);
    const m = fake.calls[0] && fake.calls[0].msg;
    check('e2e: it is script/turn_on', fake.calls[0] && fake.calls[0].service === 'script/turn_on', fake.calls[0]);
    check('e2e: targeting the bound script', m && m.target && m.target.entity_id === 'script.demo_off', m);
    check('e2e: with the room\'s variables', m && JSON.stringify(m.service_data) === JSON.stringify({ variables: { area: 'demo_hall_store' } }), m);
    check('e2e: no REST', fake.fetches.length === 0);
    check('e2e: reads sent', c.state === 'sent');

    // A client that has dropped: the confirm's own gate refuses.
    ha.disconnect();
    c.reset();
    c.press(); c.press();
    await sleep(20);
    check('e2e: disconnected -> nothing sent', fake.calls.length === 1, fake.calls);
    // And a send path that bypasses writable() still cannot reach the socket.
    const c2 = RS.createTwoStepConfirm({
      send: () => { const cmd = RS.roomScriptCommand(binding); return ha.callService(cmd.domain, cmd.service, cmd.data, cmd.target); },
      minArmMs: 0, resultMs: 50,
    });
    c2.press(); c2.press();
    await sleep(20);
    check('e2e: dropped by the client -> failed, nothing sent', c2.state === 'failed' && fake.calls.length === 1, { s: c2.state, n: fake.calls.length });
    c.dispose(); c2.dispose();
  } finally {
    console.warn = realWarn; console.log = realLog;
    fake.restore();
  }
}

// ---- 5. Row markup --------------------------------------------------------
{
  const b = { entity: 'script.demo_off', variables: {}, label: 'Kill room' };
  const idle = RS.roomScriptRowHtml(b, 'idle', 'ok');
  check('row: idle shows the label', />Kill room<\/button>/.test(idle), idle);
  check('row: enabled when HA ok', !/disabled/.test(idle), idle);
  check('row: carries its data-row and action', /data-row="room-script"/.test(idle) && /data-action="room-script"/.test(idle));
  const armed = RS.roomScriptRowHtml(b, 'armed', 'ok');
  check('row: armed text', />Tap again to kill room<\/button>/.test(armed) && /room-script-btn armed/.test(armed), armed);
  check('row: sent text', />Sent<\/button>/.test(RS.roomScriptRowHtml(b, 'sent', 'ok')));
  const off = RS.roomScriptRowHtml(b, 'armed', 'offline');
  check('row: offline disabled, shown idle', /disabled>/.test(off) && />Kill room<\/button>/.test(off) && /offline/.test(off), off);
  check('row: no HA disabled', /disabled>/.test(RS.roomScriptRowHtml(b, 'idle', 'none')));
  const evil = RS.roomScriptRowHtml({ ...b, label: '<img src=x>' }, 'idle', 'ok');
  check('row: label escaped', !/<img/.test(evil) && /&lt;img/.test(evil), evil);
}

// ---- 6. index.html wiring --------------------------------------------------
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('index: row key only for a bound room',
    /if \(roomScriptBindings\(\)\.has\(rid\)\) keys\.push\('room-script'\);/.test(html));
  const presses = html.match(/\.press\(\)/g) || [];
  const inClick = /if \(action === 'room-script'\) onWrite\(el, 'click', \(\) => \{\s*if \(!el\.disabled\) roomScriptConfirm\(rid\)\.press\(\);\s*\}\);/.test(html);
  check('index: press() called only from the click handler', presses.length === 1 && inClick, presses.length);
  check('index: render reads state only', /roomScriptRowHtml\(b, c \? c\.state : 'idle', roomScriptHaState\(\)\)/.test(html));
  check('index: losing HA disarms every room script',
    /ha\.onStatusChange\(status => \{ if \(status !== 'connected'\) disarmRoomScripts\(null\); \}\);/.test(html));
  check('index: rendering another view disarms rooms not on screen', /disarmRoomScripts\(selectedRoom\);/.test(html));
  check('index: send goes through ha.callService and is gated on HA being ok',
    /if \(!cmd \|\| roomScriptHaState\(\) !== 'ok'\) return false;\s*return ha\.callService\(cmd\.domain, cmd\.service, cmd\.data, cmd\.target\) === true;/.test(html));
}

console.log(`${failures ? 'FAILED' : 'ok'} -- ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
