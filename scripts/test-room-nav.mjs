#!/usr/bin/env node
/**
 * Previous / next room navigation (src/room-nav.js) and its wiring in
 * index.html. No framework, no install -- `node scripts/test-room-nav.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. nextRoom / prevRoom walk the room order with wraparound at both ends.
 *   2. Key routing: ArrowLeft/Right cycle only with a room selected; a focused
 *      input / select / slider / textarea, an open dialog, a modifier key, or
 *      (edit mode) a selected item keeps its arrows; Up/Down never cycle.
 *   3. Cycling A -> B -> C then click-away returns to the ORIGINAL home pose.
 *   4. index.html: the buttons carry the aria-labels, step through the same
 *      selectedRoom / renderPanel / focusRoom('explicit') path as a list tap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}

const { nextRoom, prevRoom, roomNavKeyAction } = await imp('src/room-nav.js');
const { focusReduce, FOCUS_INITIAL } = await imp('src/camera-focus.js');

console.log('helpers');
const ids = ['living', 'kitchen', 'bedroom'];
check('next steps forward', nextRoom(ids, 'living') === 'kitchen' && nextRoom(ids, 'kitchen') === 'bedroom');
check('next wraps last -> first', nextRoom(ids, 'bedroom') === 'living');
check('prev steps back', prevRoom(ids, 'bedroom') === 'kitchen');
check('prev wraps first -> last', prevRoom(ids, 'living') === 'bedroom');
check('unknown id: next -> first, prev -> last', nextRoom(ids, 'x') === 'living' && prevRoom(ids, 'x') === 'bedroom');
check('empty / single list', nextRoom([], 'a') === null && prevRoom([], 'a') === null && nextRoom(['a'], 'a') === 'a');

console.log('key routing');
const base = { key: 'ArrowRight', target: { tagName: 'BODY' }, selectedRoom: 'kitchen', dialogOpen: false, editActive: false, editItemSelected: false };
const act = o => roomNavKeyAction({ ...base, ...o });
check('Right -> next, Left -> prev', act({}) === 'next' && act({ key: 'ArrowLeft' }) === 'prev');
check('Up / Down / PageUp / + do not cycle', ['ArrowUp', 'ArrowDown', 'PageUp', '+', '-'].every(k => act({ key: k }) === null));
check('no room selected: nothing (Controls view)', act({ selectedRoom: null }) === null);
for (const tag of ['INPUT', 'SELECT', 'TEXTAREA']) check('focused ' + tag + ' keeps its arrows', act({ target: { tagName: tag } }) === null);
check('contenteditable keeps its arrows', act({ target: { tagName: 'DIV', isContentEditable: true } }) === null);
check('role=slider keeps its arrows', act({ target: { tagName: 'DIV', getAttribute: n => n === 'role' ? 'slider' : null } }) === null);
check('a focused button does not block', act({ target: { tagName: 'BUTTON' } }) === 'next');
check('dialog / card open: ignored', act({ dialogOpen: true }) === null);
check('modifier keys ignored', ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'].every(m => act({ [m]: true }) === null));
check('edit mode + item selected: arrows nudge, no cycle', act({ editActive: true, editItemSelected: true }) === null);
check('edit mode, no item selected: cycles', act({ editActive: true, editItemSelected: false }) === 'next');
check('view mode ignores a stale item flag', act({ editActive: false, editItemSelected: true }) === 'next');

console.log('home pose across cycling');
{
  const pose0 = { th: 1, ph: 1, r: 20, tgt: [0, 0, 0] }, flown = { th: 2, ph: 2, r: 5, tgt: [1, 1, 1] };
  const view = sel => ({ ...flown, r: sel.room.length });
  let r = focusReduce(FOCUS_INITIAL, { room: 'living' }, 'explicit', pose0, view);
  let st = r.state;
  for (const id of ['kitchen', 'bedroom', 'living', 'kitchen']) {
    r = focusReduce(st, { room: id }, 'explicit', { th: 9, ph: 9, r: 9, tgt: [9, 9, 9] }, view); st = r.state;
    check('cycle to ' + id + ' flies to its view, home kept', r.fly && r.fly.r === id.length && st.home.r === 20);
  }
  r = focusReduce(st, { room: null }, 'explicit', { th: 9, ph: 9, r: 9, tgt: [9, 9, 9] }, view);
  check('click-away after cycling returns to the original pre-selection pose', r.fly && r.fly.th === 1 && r.fly.r === 20);
}

console.log('index.html wiring');
{
  const html = read('index.html');
  check('imports the helpers', /import \{ nextRoom, prevRoom, roomNavKeyAction, tourOrder \} from '\.\/src\/room-nav\.js\?v=__VERSION__'/.test(html));
  check('aria-labels "Previous room: X" / "Next room: X"', html.includes("'Previous room: '") && html.includes("'Next room: '"));
  const step = html.slice(html.indexOf('function stepRoom'), html.indexOf("roomNavPrev.addEventListener('click'"));
  check('stepRoom: same path as a list tap (selectedRoom, renderPanel, focusRoom explicit)',
    /selectedRoom = id; renderPanel\(\); focusRoom\('explicit'\);/.test(step) && /\(tourIds, selectedRoom\)/.test(step) &&
    // The tour: the profile's navigation.order, else home.roomIds (src/room-nav.js tourOrder).
    html.includes('const tourIds = tourOrder(home.roomIds, house.navigation && house.navigation.order);'));
  check('stepRoom never touches the focus controller / home pose directly', !/focusCtl|getPose|flyTo/.test(step));
  check('key handler passes edit item + dialog state', /editItemSelected:[^\n]*hasItemTarget/.test(html) && /tapPopovers\.isOpen\(\)/.test(html));
  check('both buttons wired', /roomNavPrev\.addEventListener\('click', \(\) => stepRoom\('prev'\)\)/.test(html) && /roomNavNext\.addEventListener\('click', \(\) => stepRoom\('next'\)\)/.test(html));
  check('visible focus state + light theme styles', html.includes('.room-nav-btn:focus-visible') && html.includes('[data-theme="light"] .room-nav-btn'));
  check('edit-mode exposes hasItemTarget', /hasItemTarget: \(\) =>/.test(read('src/edit-mode.js')));
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
