#!/usr/bin/env node
/**
 * The pinned sidebar (src/sidebar-pin.js) -- every transition of the state
 * machine, and index.html's wiring of each trigger to it. No framework, no
 * install -- `node scripts/test-sidebar-pin.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. Controls button -> open AND pinned; only X closes a pinned sidebar;
 *      every auto-close trigger leaves it open.
 *   2. Room tap -> open UNPINNED; tapping another room while open keeps it
 *      open and keeps the pin as it was.
 *   3. Unpinned: a background tap, an object tap, a page scroll, or a camera
 *      orbit / pan / zoom start closes it.
 *   4. Pin toggle flips an open sidebar; unpinning then an auto-close
 *      trigger closes it; the toggle does nothing while closed.
 *   5. Wide layout (not collapsible): always open, whatever the event.
 *   6. The reducer never mutates its input.
 *   7. index.html: the pin button exists (aria-pressed, labelled), is hidden
 *      on the wide layout, and every trigger reaches sidebarEvent; the tap
 *      popover's object tap closes the sidebar BEFORE the card opens, and the
 *      card survives the sidebar-toggle rule. Pin state is not persisted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}

const P = await imp('src/sidebar-pin.js');
const NARROW = { collapsible: true }, WIDE = { collapsible: false };
const run = (events, opts = NARROW, start = P.SIDEBAR_INITIAL) => events.reduce((s, e) => P.sidebarReduce(s, e, opts), start);
const is = (s, open, pinned) => s.open === open && s.pinned === pinned;
const AUTO = ['background', 'objectTap', 'scroll', 'cameraStart'];

// 0. start
check('initial: closed, unpinned', is(P.SIDEBAR_INITIAL, false, false));
check('every event is known', ['controls', 'roomTap', 'close', 'togglePin', ...AUTO].every(e => P.SIDEBAR_EVENTS.includes(e)));

// 1. Controls -> pinned
check('Controls opens pinned', is(run(['controls']), true, true));
for (const e of AUTO) check('pinned: ' + e + ' leaves it open', is(run(['controls', e]), true, true));
check('pinned: X closes it', is(run(['controls', 'close']), false, false));
check('pinned: a room tap switches room, stays pinned', is(run(['controls', 'roomTap']), true, true));
check('Controls on an open unpinned sidebar pins it', is(run(['roomTap', 'controls']), true, true));

// 2. room tap -> unpinned
check('room tap opens UNPINNED', is(run(['roomTap']), true, false));
check('unpinned: another room tap keeps it open, unpinned', is(run(['roomTap', 'roomTap']), true, false));

// 3. unpinned auto-close
for (const e of AUTO) check('unpinned: ' + e + ' closes it', is(run(['roomTap', e]), false, false));
check('unpinned: X closes it', is(run(['roomTap', 'close']), false, false));
check('closed: an auto-close trigger changes nothing', AUTO.every(e => is(run([e]), false, false)));
check('closed then room tap: unpinned again (pin not carried over)', is(run(['controls', 'close', 'roomTap']), true, false));

// 4. pin toggle
check('toggle pins an unpinned sidebar', is(run(['roomTap', 'togglePin']), true, true));
check('pinned by toggle: background tap leaves it open', is(run(['roomTap', 'togglePin', 'background']), true, true));
check('toggle unpins a pinned sidebar', is(run(['controls', 'togglePin']), true, false));
check('unpin, then an auto-close trigger closes it', AUTO.every(e => is(run(['controls', 'togglePin', e]), false, false)));
check('toggle while closed does nothing', is(run(['togglePin']), false, false));

// 5. wide layout
for (const e of ['close', 'roomTap', 'togglePin', ...AUTO]) {
  check('wide: ' + e + ' -> still open', is(run(['controls', e], WIDE), true, true));
}
check('wide: from nothing, any event -> open', is(run(['background'], WIDE), true, true));
check('opts omitted -> collapsible (the safe reading)', is(P.sidebarReduce({ open: true, pinned: false }, 'background'), false, false));

// 6. purity
{
  const s = { open: true, pinned: false };
  const out = P.sidebarReduce(s, 'togglePin', NARROW);
  check('reducer does not mutate its input', s.open === true && s.pinned === false && out !== s);
  check('unknown event: state unchanged', is(P.sidebarReduce({ open: true, pinned: true }, 'bogus', NARROW), true, true));
}

// 7. index.html wiring (source level)
{
  const html = read('index.html');
  check('pin button in the header, labelled, aria-pressed',
    /<button class="panel-pin" id="panel-pin" type="button" aria-pressed="false" aria-label="Pin sidebar" title="Pin sidebar"><\/button>/.test(html));
  check('pin button hidden on the wide layout', /@media \(min-width: 1500px\) \{[\s\S]*?\.panel-pin \{ display: none !important; \}/.test(html));
  check('pin paints filled/outline + label per state',
    /panelPin\.setAttribute\('aria-pressed', String\(on\)\)/.test(html) && /on \? 'Unpin sidebar' : 'Pin sidebar'/.test(html)
    && /svgIcon\(on \? ICONS\.pin : ICONS\.pinOutline\)/.test(html));
  check('collapsible = the existing wide breakpoint', /sidebarReduce\(prev, ev, \{ collapsible: !isWideScreen\(\) \}\)/.test(html));
  check('Controls button -> controls', /lightsBtn\.addEventListener\('click', \(\) => \{[^}]*sidebarEvent\('controls'\)/.test(html));
  check('X -> close', /panelClose\.addEventListener\('click', \(\) => sidebarEvent\('close'\)\)/.test(html));
  check('pin -> togglePin', /panelPin\.addEventListener\('click', \(\) => sidebarEvent\('togglePin'\)\)/.test(html));
  check('room tap -> roomTap', /onRoomClick: isPreview \? undefined : \(roomId => \{[\s\S]{0,200}sidebarEvent\('roomTap'\)/.test(html));
  check('background tap -> background (a room tap is not background)',
    /if \(roomTapPending\) \{ roomTapPending = false; return; \}[\s\S]{0,120}sidebarEvent\('background'\)/.test(html));
  check('orbit / pan (drag past the tap slop) -> cameraStart',
    /Math\.abs\(e\.clientX - gesture\.x\) > 5 \|\| Math\.abs\(e\.clientY - gesture\.y\) > 5\) \{[\s\S]{0,80}sidebarEvent\('cameraStart'\)/.test(html));
  check('wheel zoom -> cameraStart', /container\.addEventListener\('wheel', \(\) => sidebarEvent\('cameraStart'\)/.test(html));
  check('pinch -> cameraStart', /e\.touches\.length >= 2\) sidebarEvent\('cameraStart'\)/.test(html));
  check('page scroll -> scroll', /window\.addEventListener\('scroll', \(\) => sidebarEvent\('scroll'\)/.test(html));
  check('object tap -> objectTap', /onObjectTap: \(\) => sidebarEvent\('objectTap'\)/.test(html));
  check('pin state is not persisted', !/localStorage|sessionStorage/.test(html.slice(html.indexOf('let sidebarState'), html.indexOf('let sidebarState') + 4000)));

  const src = read('src/tap-popovers.js');
  const onClick = src.slice(src.indexOf('const onClick = e =>'), src.indexOf('const onWheel'));
  check('popover: onObjectTap runs BEFORE the card opens',
    onClick.indexOf('o.onObjectTap(res.target)') > -1 && onClick.indexOf('o.onObjectTap(res.target)') < onClick.indexOf('open(res.target'));
  check('popover: the sidebar flip that hook made is absorbed (takeRecords), not a card close',
    // Camera focus (src/camera-focus.js) may fly before the card opens; the
    // flip is still absorbed before either path opens it.
    // Absorbed IMMEDIATELY before the open path: only comments sit between
    // it and the line that either flies (then opens) or opens at once.
    /syncSidebarOpen\(\);\s*\}\s*(\/\/[^\n]*\n\s*)*const target = res\.target, point = res\.point;\s*const flight = [^\n]*\n\s*if \(flight\) \{[\s\S]*?open\(target[\s\S]*?\n\s*open\(res\.target/.test(onClick) && /sidebarObs\.takeRecords\(\)/.test(src));
  check('popover: a closing sidebar is not dodged', /if \(sb\.classList && !sb\.classList\.contains\('open'\)\) return null;/.test(src));
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
