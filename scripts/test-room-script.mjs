#!/usr/bin/env node
/**
 * The room script ("Shut down room") button: rooms.json `sensors.roomScripts`.
 * No framework, no install -- `node scripts/test-room-script.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. normaliseRoomScripts: a binding keeps its entity, variables and label
 *      (default 'Shut down room'); a non-script entity, an array or
 *      non-object `variables` and a non-object entry are dropped.
 *   2. roomScriptCommand: ONE script.turn_on, target = the script entity,
 *      data = { variables } -- a copy. Same script, different variables per
 *      room.
 *   3. createConfirmDialog: request opens and sends nothing; Cancel sends
 *      nothing; confirm sends exactly once even when repeated or re-entered;
 *      HA offline refuses to open / sends nothing on confirm.
 *   3b. confirmDialogCopy: "Shut down <Room>?" for the room script, an
 *      extra's OWN label and text (never the shut-down note).
 *   4. End to end over the fake HA WebSocket (never a real HA): open and
 *      Cancel put nothing on the socket, confirm puts exactly one
 *      script/turn_on with the right target and variables.
 *   5. Row markup: no armed state, label, disabled unless HA is ok, escaping,
 *      a persistent role="status" region; in-place update.
 *   6. index.html / edit-bindings.js wiring (source-level): the row only
 *      opens the dialog, the confirm handler is the only sender, results are
 *      keyed by script entity, Escape / backdrop cancel, editor-added script
 *      rows default to confirm, the old arm-then-tap flow is gone.
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
  check('normalise: default label is Shut down room', m.get('lounge').label === 'Shut down room', m.get('lounge'));
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

// ---- 3. createConfirmDialog -------------------------------------------------
function dialog(opts = {}) {
  const sends = [], changes = [];
  let writable = true;
  const d = RS.createConfirmDialog({
    onConfirm: ctx => { sends.push(ctx); if (opts.onConfirm) opts.onConfirm(ctx, d); },
    writable: () => writable,
    onChange: p => changes.push(p === null ? 'closed' : p.id),
  });
  return { d, sends, changes, setWritable(v) { writable = v; } };
}
{
  const h = dialog();
  check('dialog: starts closed', h.d.isOpen === false && h.d.pending === null);
  check('dialog: request opens it and sends NOTHING', h.d.request({ id: 'a' }) === true && h.d.isOpen && h.sends.length === 0, h.sends);
  check('dialog: a second request while open is refused (ctx unchanged)', h.d.request({ id: 'b' }) === false && h.d.pending.id === 'a');
  check('dialog: cancel closes and sends NOTHING', h.d.cancel() === true && !h.d.isOpen && h.sends.length === 0, h.sends);
  check('dialog: cancel when closed is a no-op', h.d.cancel() === false);
  check('dialog: confirm when closed sends nothing', h.d.confirm() === false && h.sends.length === 0);
  check('dialog: onChange saw open, close', h.changes.join() === 'a,closed', h.changes);
}
{
  const h = dialog();
  h.d.request({ id: 'a' });
  check('confirm: sends exactly once, with the ctx it was opened with', h.d.confirm() === true && h.sends.length === 1 && h.sends[0].id === 'a', h.sends);
  check('confirm: closes the dialog', !h.d.isOpen);
  check('confirm: a DOUBLE confirm still sends once', h.d.confirm() === false && h.sends.length === 1, h.sends);
  for (let i = 0; i < 50; i++) h.d.confirm();   // a held Enter's auto-repeat
  check('confirm: 50 more repeats still one send', h.sends.length === 1, h.sends.length);
}
{
  // Re-entrancy: onConfirm itself asks for another confirm -- it must not
  // recurse into a second send.
  const h = dialog({ onConfirm: (ctx, d) => { d.confirm(); } });
  h.d.request({ id: 'a' });
  h.d.confirm();
  check('confirm: a re-entrant confirm from inside onConfirm sends once', h.sends.length === 1, h.sends);
}
{
  const h = dialog();
  h.setWritable(false);
  check('offline: request does not even open', h.d.request({ id: 'a' }) === false && !h.d.isOpen);
  h.setWritable(true);
  h.d.request({ id: 'a' });
  h.setWritable(false);
  check('offline: HA lost while open -> confirm closes and sends nothing', h.d.confirm() === false && !h.d.isOpen && h.sends.length === 0, h.sends);
}

// ---- 3b. The dialog's copy ----------------------------------------------------
{
  const roomB = { entity: 'script.demo_off', label: RS.DEFAULT_ROOM_SCRIPT_LABEL };
  const c = RS.confirmDialogCopy(roomB, 'Lounge', true);
  check('copy: room script title', c.title === 'Shut down Lounge?', c);
  check('copy: room script body is the standard text', c.body === 'Switches off this room’s lights and devices', c);
  check('copy: buttons', c.confirmText === 'Shut down room' && c.cancelText === 'Cancel', c);
  const x = RS.confirmDialogCopy({ entity: 'script.demo_movie', label: 'Movie mode' }, 'Lounge', false);
  check('copy: an extra uses its OWN label, never the shut-down text',
    x.confirmText === 'Movie mode' && x.title === 'Movie mode in Lounge?' && !/Switches off|Shut down/.test(x.title + x.body), x);
  const xd = RS.confirmDialogCopy({ entity: 'script.demo_movie', label: 'Shut down room' }, 'Lounge', false);
  check('copy: an EXTRA labelled like the default does not claim to switch things off', !/Switches off/.test(xd.body), xd);
  const o = RS.confirmDialogCopy({ entity: 'script.x', label: 'Room off', description: ' Turns it all off ' }, 'Study', true);
  check('copy: a row description overrides the body', o.body === 'Turns it all off', o);
  check('copy: no room name still reads', /this room/.test(RS.confirmDialogCopy(roomB, '', true).title));
  check('copy: the default label is Shut down room', RS.DEFAULT_ROOM_SCRIPT_LABEL === 'Shut down room');
}

// ---- 4. End to end over the fake HA WebSocket --------------------------------
// The dialog + createActionButton, wired as index.html wires them, through
// the REAL HAClient.callService.
{
  const { createActionButton, sendScript } = await imp('src/script-call.js');
  const fake = installFakeHA({ states: [] });
  const realWarn = console.warn, realLog = console.log;
  console.warn = () => {}; console.log = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: {} });
    ha.connect();
    await fake.whenConnected(ha);
    const binding = RS.normaliseRoomScripts({ hall: { entity: 'script.demo_off', variables: { area: 'demo_hall_store' } } }).get('hall');
    const btn = createActionButton({
      writable: () => ha.status === 'connected',
      send: () => sendScript(ha, binding, () => ha.status === 'connected'),
      resultMs: 50,
    });
    const d = RS.createConfirmDialog({ writable: () => ha.status === 'connected', onConfirm: () => btn.press() });
    d.request({ id: 'hall' });
    await sleep(20);
    check('e2e: opening the dialog puts nothing on the socket', fake.calls.length === 0, fake.calls);
    d.cancel();
    d.confirm();
    await sleep(20);
    check('e2e: Cancel puts nothing on the socket', fake.calls.length === 0, fake.calls);
    d.request({ id: 'hall' });
    d.confirm(); d.confirm(); d.confirm();
    await sleep(20);
    check('e2e: confirm (and two more) puts exactly ONE call_service on the socket', fake.calls.length === 1, fake.calls);
    const m = fake.calls[0] && fake.calls[0].msg;
    check('e2e: it is script/turn_on', fake.calls[0] && fake.calls[0].service === 'script/turn_on', fake.calls[0]);
    check('e2e: targeting the bound script', m && m.target && m.target.entity_id === 'script.demo_off', m);
    check('e2e: with the room\'s variables', m && JSON.stringify(m.service_data) === JSON.stringify({ variables: { area: 'demo_hall_store' } }), m);
    check('e2e: no REST', fake.fetches.length === 0);
    check('e2e: the row reads sent', btn.state === 'sent');
    // Reopen and confirm while it still reads Sent: ignored (one launch).
    d.request({ id: 'hall' }); d.confirm();
    await sleep(10);
    check('e2e: a confirm while the row still says Sent sends nothing more', fake.calls.length === 1, fake.calls.length);
    await sleep(80);

    ha.disconnect();
    d.request({ id: 'hall' });
    d.confirm();
    await sleep(20);
    check('e2e: disconnected -> the dialog does not open, nothing sent', fake.calls.length === 1, fake.calls.length);
  } finally {
    console.warn = realWarn; console.log = realLog;
    fake.restore();
  }
}

// ---- 5. Row markup --------------------------------------------------------
{
  const b = { entity: 'script.demo_off', variables: {}, label: 'Shut down room' };
  const idle = RS.roomScriptRowHtml(b, 'idle', 'ok');
  check('row: idle shows the label', />Shut down room<\/button>/.test(idle), idle);
  check('row: enabled when HA ok', !/disabled/.test(idle), idle);
  check('row: carries its data-row and action', /data-row="room-script"/.test(idle) && /data-action="room-script"/.test(idle));
  const stale = RS.roomScriptRowHtml(b, 'armed', 'ok');
  check('row: there is no armed state any more (reads idle)', />Shut down room<\/button>/.test(stale) && !/armed|Tap again/.test(stale), stale);
  check('row: sent text', />Sent<\/button>/.test(RS.roomScriptRowHtml(b, 'sent', 'ok')));
  const off = RS.roomScriptRowHtml(b, 'sent', 'offline');
  check('row: offline disabled, shown idle', /disabled>/.test(off) && />Shut down room<\/button>/.test(off) && /offline/.test(off), off);
  check('row: no HA disabled', /disabled>/.test(RS.roomScriptRowHtml(b, 'idle', 'none')));
  const evil = RS.roomScriptRowHtml({ ...b, label: '<img src=x>' }, 'idle', 'ok');
  check('row: label escaped', !/<img/.test(evil) && /&lt;img/.test(evil), evil);
  check('row: a persistent role=status region, OUTSIDE the button',
    /<\/button>[\s\S]*role="status" aria-live="polite" data-room-script-live/.test(idle) && !/<button[^>]*aria-live/.test(idle), idle);

  const v = RS.roomScriptView(b, 'sent', 'ok');
  check('view: sent', v.state === 'sent' && v.text === 'Sent' && v.disabled === false && v.live === 'Sent.' && v.note === '', v);
  check('view: failed announces', /Not sent/.test(RS.roomScriptView(b, 'failed', 'ok').live));
  check('view: offline is idle + disabled, nothing announced', (() => { const o = RS.roomScriptView(b, 'sent', 'offline'); return o.state === 'idle' && o.disabled && o.live === ''; })());
  const el = (attrs = {}) => ({ attrs, className: '', textContent: '', disabled: false, hidden: false,
    setAttribute(k, val) { this.attrs[k] = val; } });
  const btn = el(), note = el(), live = el();
  const row = { querySelector: sel => sel === '[data-action="room-script"]' ? btn : sel === '.room-script-note' ? note : sel === '[data-room-script-live]' ? live : null };
  check('apply: updates a complete row', RS.applyRoomScriptView(row, v) === true);
  check('apply: same button, new class/state/text', btn.className === 'room-script-btn sent' && btn.attrs['data-state'] === 'sent' && btn.textContent === 'Sent', btn);
  check('apply: live region carries the announcement', /Sent/.test(live.textContent), live);
  RS.applyRoomScriptView(row, RS.roomScriptView(b, 'idle', 'ok'));
  check('apply: idle hides the note and clears the region', note.hidden === true && live.textContent === '', { note, live });
  check('apply: a row missing its parts reports false', RS.applyRoomScriptView({ querySelector: () => null }, v) === false);
}

// ---- 6. index.html / edit-bindings wiring (source-level) ----------------------
{
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const eb = fs.readFileSync(path.join(root, 'src/edit-bindings.js'), 'utf8');
  check('index: row key only for a bound room',
    /if \(roomScriptBindings\(\)\.has\(rid\)\) keys\.push\('room-script'\);/.test(html));
  check('index: the room script click only OPENS the dialog',
    /if \(action === 'room-script'\) \{\s*onWrite\(el, 'click', \(\) => \{ if \(!el\.disabled\) openScriptConfirm\(rid, 'room-script'/.test(html));
  const presses = html.match(/\)\.press\(/g) || [];
  check('index: a script is only ever pressed from the dialog confirm and the one-tap extra (2 call sites)', presses.length === 2, presses.length);
  check('index: the dialog confirm presses the action button',
    /onConfirm: ctx => \{[\s\S]*?scriptButton\(ctx\.rid, ctx\.key, b\)\.press\(\);/.test(html));
  check('index: the dialog re-resolves the binding and refuses a retargeted row',
    /const b = currentScriptBinding\(ctx\);\s*if \(!b \|\| b\.entity !== ctx\.entity\) return;/.test(html));
  check('index: confirm-flagged extras open the dialog, others press directly',
    /if \(b\.confirm\) openScriptConfirm\(rid, key, b, el\);\s*else scriptButton\(rid, key, b\)\.press\(\);/.test(html));
  check('index: result state is keyed by script entity + variables, not by row position',
    /scriptButtonId = \(rid, b\) => rid \+ '\|' \+ b\.entity \+ '\|' \+ JSON\.stringify\(b\.variables \|\| \{\}\)/.test(html));
  check('index: Escape and a backdrop tap cancel',
    /e\.target === confirmBackdrop\) confirmDialog\.cancel\(\)/.test(html) && /e\.key === 'Escape' && confirmDialog\.isOpen\) \{[^}]*confirmDialog\.cancel\(\)/.test(html));
  check('index: room-nav arrows ignore only a VISIBLE dialog (the hidden confirm must not disable them)',
    /\.some\(d => !d\.closest\('\[hidden\]'\)\)/.test(html));
  check('index: focus lands on Cancel', /confirmBackdrop\.hidden = false;\s*confirmCancelBtn\.focus\(\);/.test(html));
  check('index: the dialog is an aria-modal alertdialog', /role="alertdialog" aria-modal="true"/.test(html));
  check('index: the old arm-then-tap flow is gone',
    !/createTwoStepConfirm|roomScriptConfirms|extraConfirms|Tap again|createKeyIntent/.test(html) && !/Kill room/.test(html));
  const closeFn = (html.match(/function closePanel\(\) \{[\s\S]*?\n      \}/) || [''])[0];
  check('index: closing the panel closes the dialog (both branches)',
    /^function closePanel\(\) \{[\s\S]*?disarmRoomScripts\(null\);\s*if \(isWideScreen\(\)\)/.test(closeFn), closeFn);
  check('index: a state change updates the row in place (focus kept), repainting only as a fallback',
    /onChange: \(\) => paintScriptRow\(rid, e\.key\)/.test(html) &&
    /applyRoomScriptView\(row, roomScriptView\(b, scriptState\(rid, b\), roomScriptHaState\(\)\)\)\) \{\s*refreshRoomRow\('room-script'\);/.test(html));
  const hoverRules = html.match(/[^\n{}]*\.room-script-btn[^\n{]*:hover[^\n{]*\{/g) || [];
  check('css: every room-script hover rule is scoped to idle',
    hoverRules.length === 2 && hoverRules.every(r => /\.room-script-btn\.idle:hover/.test(r)), hoverRules);
  check('css: hover rules only where hover is real (not sticky touch hover)',
    /@media \(hover: hover\) \{\s*\.room-script-btn\.idle:hover/.test(html));
  check('index: render reads state only', /roomScriptRowHtml\(b, scriptState\(rid, b\), roomScriptHaState\(\)\)/.test(html));
  check('index: losing HA closes the dialog',
    /ha\.onStatusChange\(status => \{ if \(status !== 'connected'\) disarmRoomScripts\(null\); \}\);/.test(html));
  check('index: rendering another view closes a dialog for a room not on screen', /disarmRoomScripts\(selectedRoom\);/.test(html));
  check('index: send goes through the shared sendScript, gated on HA being ok',
    /send: \(\) => sendScript\(ha, \{ entity: b\.entity, variables: b\.variables \}, \(\) => roomScriptHaState\(\) === 'ok'\),/.test(html));
  // The editor: a script row added in edit mode asks first by default.
  check('editor: switching a row to script defaults confirm on (unless set)',
    /if \(v !== 'script'\) delete x\.confirm;[\s\S]{0,200}else if \(x\.confirm === undefined\) x\.confirm = true;/.test(eb));
  check('editor: no Kill room / tap-twice wording left', !/Kill room|Tap twice/.test(eb));
}

console.log(`${failures ? 'FAILED' : 'ok'} -- ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
