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
 *      nothing; reset() disarms; a throwing send reads as failed. KEYBOARD:
 *      a keyboard arm needs a key release before a keyboard confirm counts,
 *      so a held Enter's auto-repeat never confirms; a deliberate second
 *      press (Enter or Space) does; pointer taps are unaffected.
 *   3b. The three input paths, as index.html wires createKeyIntent into the
 *      confirm: a REAL key (Enter / Space keydown on the button) is keyboard
 *      and a held Enter never confirms; an assistive-tech or scripted click
 *      (detail 0, no key events) arms and confirms like a tap; pointer taps
 *      as before. Only Enter / Space keyups release; blur drops a stale key.
 *   4. End to end over the fake HA WebSocket, through the REAL
 *      HAClient.callService: two presses put exactly one call_service
 *      script/turn_on with the right target and variables on the socket; one
 *      press puts none; a disconnected client sends none (and the confirm
 *      reports failed).
 *   5. Row markup: the label, the armed text, disabled unless HA is 'ok',
 *      escaping of a profile-supplied label, and a persistent role="status"
 *      region outside the button; roomScriptView / applyRoomScriptView update
 *      the SAME button in place (so it keeps focus) and fill the region.
 *   6. index.html wiring (source-level): the row is only added for a bound
 *      room; the click handler is the only caller of press() and flags a
 *      keyboard click; keyup releases the guard; the render path only reads
 *      .state; losing HA, rendering another view and CLOSING THE PANEL all
 *      disarm; hover styles never outrank Sent / Not sent.
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
// Keyboard: a HELD Enter auto-repeats a click every ~30 ms after the repeat
// delay. Model it: keydown -> click (arms), then repeats long past minArmMs
// with no keyup. None may confirm.
{
  const h = harness();
  h.c.press({ keyboard: true });
  check('keyboard: Enter arms', h.c.state === 'armed' && h.sends.length === 0);
  for (let i = 0; i < 100; i++) { h.advance(30); h.c.press({ keyboard: true }); }
  check('keyboard: a held Enter (100 repeats over 3 s, no keyup) never confirms', h.sends.length === 0 && h.c.state === 'armed', h.sends);
  h.c.keyUp();
  h.advance(100);
  h.c.press({ keyboard: true });
  check('keyboard: release then a deliberate second press confirms', h.sends.length === 1 && h.c.state === 'sent', h.sends);
}
{
  // Space clicks on release: keyup, then click. Arm = [keyup, click];
  // confirm = the next [keyup, click]. The first keyup lands before the arm,
  // so it cannot count; the second one does.
  const h = harness();
  h.c.keyUp(); h.c.press({ keyboard: true });
  h.advance(600);
  h.c.keyUp(); h.c.press({ keyboard: true });
  check('keyboard: Space press, Space press confirms', h.sends.length === 1, h.sends);
}
{
  const h = harness();
  h.c.keyUp();                   // a stray keyup BEFORE arming
  h.c.press({ keyboard: true }); // Enter arms
  h.advance(600);
  h.c.press({ keyboard: true }); // repeat of the same held key
  check('keyboard: a keyup before the arm does not license a repeat', h.sends.length === 0, h.sends);
}
{
  const h = harness();
  h.c.press({ keyboard: true });
  h.advance(4000);
  check('keyboard: arm still times out', h.c.state === 'idle');
  h.c.press({ keyboard: true });
  h.advance(600);
  h.c.press({ keyboard: true });
  check('keyboard: a re-arm after the timeout also needs a release', h.sends.length === 0, h.sends);
  const p = harness();
  p.c.press(); p.advance(600); p.c.press();
  check('pointer: two taps still confirm with no keyup at all', p.sends.length === 1, p.sends);
}

// ---- 3b. The button as index.html wires it: key intent + confirm ------------
// Replays the DOM event sequences each input path produces, through the same
// two objects the page uses (createKeyIntent per button, the confirm per room),
// wired exactly as index.html wires them.
function button() {
  const h = harness();
  const intent = RS.createKeyIntent();
  const ev = {
    keydown: key => intent.keyDown(key),
    keyup: key => { if (intent.keyUp(key)) h.c.keyUp(); },
    click: detail => h.c.press({ keyboard: intent.click(detail) }),
    blur: () => intent.blur(),
  };
  return { h, ev };
}
{
  // Path 1: a real key. Enter clicks on keydown.
  const { h, ev } = button();
  ev.keydown('Enter'); ev.click(0); ev.keyup('Enter');
  check('key: Enter arms', h.c.state === 'armed' && h.sends.length === 0);
  h.advance(600);
  ev.keydown('Enter'); ev.click(0); ev.keyup('Enter');
  check('key: a second, separate Enter confirms', h.sends.length === 1, h.sends);
}
{
  // Path 1, held: auto-repeat keydowns, each driving a click, no keyup.
  const { h, ev } = button();
  ev.keydown('Enter'); ev.click(0);
  for (let i = 0; i < 100; i++) { h.advance(30); ev.keydown('Enter'); ev.click(0); }
  check('key: a held Enter (100 auto-repeats over 3 s) never confirms', h.sends.length === 0 && h.c.state === 'armed', h.sends);
  ev.keyup('Shift');
  h.advance(30); ev.keydown('Enter'); ev.click(0);
  check('key: another key\'s keyup does not release the guard', h.sends.length === 0, h.sends);
  ev.keyup('Enter');
  h.advance(100); ev.keydown('Enter'); ev.click(0);
  check('key: after the release, the next Enter confirms', h.sends.length === 1, h.sends);
}
{
  // Space clicks on RELEASE: keydown, keyup, then click.
  const { h, ev } = button();
  ev.keydown(' '); ev.keyup(' '); ev.click(0);
  check('key: Space arms', h.c.state === 'armed' && h.sends.length === 0);
  h.advance(600);
  ev.keydown(' '); ev.keyup(' '); ev.click(0);
  check('key: a second Space confirms', h.sends.length === 1, h.sends);
}
{
  // Path 2: assistive tech / scripted el.click(): detail 0, NO key events.
  const { h, ev } = button();
  ev.click(0);
  check('synthetic: a detail-0 click with no key arms', h.c.state === 'armed' && h.sends.length === 0);
  h.advance(100); ev.click(0);
  check('synthetic: a second one inside 400 ms does not confirm', h.sends.length === 0);
  h.advance(400); ev.click(0);
  check('synthetic: a second one past 400 ms confirms (no keyup ever needed)', h.sends.length === 1, h.sends);
}
{
  // A keydown whose click never came (focus moved on), then a synthetic click.
  const { h, ev } = button();
  ev.keydown('Enter'); ev.blur();
  ev.click(0); h.advance(600); ev.click(0);
  check('synthetic: a stale keydown dropped on blur does not strand the confirm', h.sends.length === 1, h.sends);
}
{
  // Path 3: pointer.
  const { h, ev } = button();
  ev.click(1); h.advance(600); ev.click(1);
  check('pointer: two taps confirm', h.sends.length === 1, h.sends);
  const b = button();
  b.ev.click(1); b.h.advance(200); b.ev.click(1);
  check('pointer: a double-tap does not', b.h.sends.length === 0);
}
{
  const ki = RS.createKeyIntent();
  check('intent: a pointer click after a keydown is not keyboard', (ki.keyDown('Enter'), ki.click(1)) === false);
  check('intent: a click consumes the key', (ki.keyDown('Enter'), ki.click(0), ki.click(0)) === false);
  check('intent: other keys do not key a click', (ki.keyDown('a'), ki.click(0)) === false);
  check('intent: blur drops a keydown whose click never came', (ki.keyDown('Enter'), ki.blur(), ki.click(0)) === false);
  check('intent: a real Enter click is keyboard', (ki.keyDown('Enter'), ki.click(0)) === true);
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
  check('row: a persistent role=status region, OUTSIDE the button',
    /<\/button>[\s\S]*role="status" aria-live="polite" data-room-script-live/.test(idle) && !/<button[^>]*aria-live/.test(idle), idle);

  // roomScriptView + applyRoomScriptView: the in-place update keeps the SAME
  // button element (so its focus) and puts the announcement in the region.
  const v = RS.roomScriptView(b, 'armed', 'ok');
  check('view: armed', v.state === 'armed' && v.text === 'Tap again to kill room' && v.disabled === false &&
    /Armed/.test(v.live) && /Switches off/.test(v.note), v);
  check('view: sent announces Sent', RS.roomScriptView(b, 'sent', 'ok').live === 'Sent.');
  check('view: failed announces', /Not sent/.test(RS.roomScriptView(b, 'failed', 'ok').live));
  check('view: offline is idle + disabled, nothing announced', (() => { const o = RS.roomScriptView(b, 'armed', 'offline'); return o.state === 'idle' && o.disabled && o.live === ''; })());
  const el = (attrs = {}) => ({ attrs, className: '', textContent: '', disabled: false, hidden: false,
    setAttribute(k, val) { this.attrs[k] = val; } });
  const btn = el(), note = el(), live = el();
  const row = { querySelector: sel => sel === '[data-action="room-script"]' ? btn : sel === '.room-script-note' ? note : sel === '[data-room-script-live]' ? live : null };
  check('apply: updates a complete row', RS.applyRoomScriptView(row, v) === true);
  check('apply: same button, new class/state/text', btn.className === 'room-script-btn armed' && btn.attrs['data-state'] === 'armed' && btn.textContent === 'Tap again to kill room', btn);
  check('apply: live region carries the announcement', /Armed/.test(live.textContent), live);
  RS.applyRoomScriptView(row, RS.roomScriptView(b, 'idle', 'ok'));
  check('apply: idle hides the note and clears the region', note.hidden === true && live.textContent === '', { note, live });
  check('apply: a row missing its parts reports false', RS.applyRoomScriptView({ querySelector: () => null }, v) === false);
}

// ---- 6. index.html wiring --------------------------------------------------
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('index: row key only for a bound room',
    /if \(roomScriptBindings\(\)\.has\(rid\)\) keys\.push\('room-script'\);/.test(html));
  const presses = html.match(/roomScriptConfirm\(rid\)\.press\(/g) || [];
  const inClick = /const intent = createKeyIntent\(\);\s*onWrite\(el, 'click', e => \{\s*const keyboard = intent\.click\(e\.detail\);\s*if \(!el\.disabled\) roomScriptConfirm\(rid\)\.press\(\{ keyboard \}\);\s*\}\);/.test(html);
  check('index: press() called only from the click handler, keyboard decided by the key-intent tracker', presses.length === 1 && inClick, presses.length);
  check('index: keydown on the button feeds the tracker',
    /el\.addEventListener\('keydown', e => intent\.keyDown\(e\.key\)\);/.test(html));
  check('index: only an Enter / Space keyup releases the keyboard guard',
    /el\.addEventListener\('keyup', e => \{ if \(intent\.keyUp\(e\.key\)\) roomScriptConfirm\(rid\)\.keyUp\(\); \}\);/.test(html));
  check('index: blur drops a keydown whose click never came',
    /el\.addEventListener\('blur', \(\) => intent\.blur\(\)\);/.test(html));
  check('index: keyboard is no longer inferred from detail alone', !/keyboard: e\.detail === 0/.test(html));
  const closeFn = (html.match(/function closePanel\(\) \{[\s\S]*?\n      \}/) || [''])[0];
  check('index: closing the panel disarms every room script (both branches)',
    /^function closePanel\(\) \{[\s\S]*?disarmRoomScripts\(null\);\s*if \(isWideScreen\(\)\)/.test(closeFn), closeFn);
  check('index: a state change updates the row in place (focus kept), repainting only as a fallback',
    /onChange: \(\) => paintRoomScriptRow\(rid\)/.test(html) &&
    /if \(!b \|\| !applyRoomScriptView\(row, roomScriptView\(b, c \? c\.state : 'idle', roomScriptHaState\(\)\)\)\) \{\s*refreshRoomRow\('room-script'\);/.test(html));
  // Visual review d79a126d: right after the confirming tap the pointer is
  // still over the button, so a hover rule must not outrank Sent / Not sent.
  const hoverRules = html.match(/[^\n{}]*\.room-script-btn[^\n{]*:hover[^\n{]*\{/g) || [];
  check('css: every room-script hover rule is scoped to idle or armed',
    hoverRules.length === 4 && hoverRules.every(r => /\.room-script-btn\.(idle|armed):hover/.test(r)), hoverRules);
  check('css: hover rules only where hover is real (not sticky touch hover)',
    /@media \(hover: hover\) \{\s*\.room-script-btn\.idle:hover/.test(html));
  check('index: render reads state only', /roomScriptRowHtml\(b, c \? c\.state : 'idle', roomScriptHaState\(\)\)/.test(html));
  check('index: losing HA disarms every room script',
    /ha\.onStatusChange\(status => \{ if \(status !== 'connected'\) disarmRoomScripts\(null\); \}\);/.test(html));
  check('index: rendering another view disarms rooms not on screen', /disarmRoomScripts\(selectedRoom\);/.test(html));
  check('index: send goes through ha.callService and is gated on HA being ok',
    /if \(!cmd \|\| roomScriptHaState\(\) !== 'ok'\) return false;\s*return ha\.callService\(cmd\.domain, cmd\.service, cmd\.data, cmd\.target\) === true;/.test(html));
}

console.log(`${failures ? 'FAILED' : 'ok'} -- ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
