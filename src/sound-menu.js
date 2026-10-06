/**
 * sound-menu.js -- the sound menu's DOM half: a centred modal mirroring the
 * wall tablet's "Ambience" pop-up (NOW PLAYING / PLAY ON / SOUNDS). The
 * model, the ordering and every command it sends are src/sound-model.js;
 * this file only renders them and wires the taps.
 *
 * OPENED BY a tap on any furniture item named in `sensors.soundMenu.openFrom`
 * (src/tap-popovers.js furnitureTarget hands the tap here instead of opening
 * a compact card). It is a MODAL, not a tap popover: it closes any open
 * popover when it opens, sits over a 0.55 backdrop, and swallows every
 * pointer, wheel and key event so nothing reaches the 3D scene beneath it
 * (no orbit, no furniture tap, no room-nav arrow). Esc, the close button or
 * a tap on the backdrop closes it, and focus returns where it was.
 *
 * NOTHING IS SENT ON OPEN OR RENDER. The tapped speaker is highlighted and
 * listed first, never auto-selected: the selection is a household-global
 * helper the tablet shares, and looking must not change it.
 *
 * Sends go through the HA client's callService (the toggle through
 * script-call.js sendScript) only while it is connected; offline or syncing,
 * every control is disabled under the usual status. With no Home Assistant
 * configured (the demo house) the menu runs on a sample (mockSoundStates)
 * that the controls move, and sends nothing.
 */

import { mdiPath, svgIcon } from './ui-icons.js';
import { sendScript } from './script-call.js';
import { normaliseSoundMenu, createSoundController, SOUND_NONE } from './sound-model.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (name, cls) => svgIcon(mdiPath(name), 'sm-ico' + (cls ? ' ' + cls : ''));

/** Status line for the header, the tap popovers' wording. */
export const SOUND_STATUS = {
  ok: ['ok', 'Live', 'Connected to Home Assistant.'],
  connecting: ['warn', 'Connecting…', 'Syncing with Home Assistant. Controls are disabled until it finishes.'],
  haOffline: ['bad', 'HA offline', 'Home Assistant is not connected. Controls are disabled until it reconnects.'],
  mock: ['bad', 'Not connected', 'No Home Assistant configured. Showing sample speakers and sounds; changes only preview.'],
};

export const STYLE = `
.sm-backdrop { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.55); overscroll-behavior: contain;
  --sm-bg: #17181c; --sm-ink: #e8eaed; --sm-ink2: #9aa0a6; --sm-mute: #8b8f99; --sm-np-label: #ffffff; --sm-ctl: #d8dae0;
  --sm-teal: #67f0d9; --sm-sel-ic: rgba(103,240,217,0.95); --sm-sel-bg: rgba(103,240,217,0.16); --sm-sel-bd: rgba(103,240,217,0.40);
  --sm-np-bg: rgba(103,240,217,0.08); --sm-np-bd: rgba(103,240,217,0.28); --sm-ring: rgba(103,240,217,0.70);
  --sm-off-bg: rgba(255,255,255,0.04); --sm-off-bd: rgba(255,255,255,0.08);
  --sm-ph-bg: rgba(255,255,255,0.03); --sm-ph-bd: rgba(255,255,255,0.10);
  --sm-red: #f06767; --sm-red-bg: rgba(240,103,103,0.14); --sm-red-bd: rgba(240,103,103,0.38);
  --sm-hover: rgba(255,255,255,0.08); color-scheme: dark; }
:root[data-theme="light"] .sm-backdrop { color-scheme: only light;
  --sm-bg: #f7f8fb; --sm-ink: #1a1d29; --sm-ink2: #5b6070; --sm-mute: #5f6472; --sm-np-label: #1a1d29; --sm-ctl: #374151;
  --sm-teal: #0f766e; --sm-sel-ic: #0f766e; --sm-sel-bg: rgba(13,148,136,0.12); --sm-sel-bd: rgba(13,148,136,0.45);
  --sm-np-bg: rgba(13,148,136,0.07); --sm-np-bd: rgba(13,148,136,0.30); --sm-ring: rgba(13,148,136,0.65);
  --sm-off-bg: rgba(0,0,0,0.03); --sm-off-bd: rgba(0,0,0,0.10);
  --sm-ph-bg: rgba(0,0,0,0.02); --sm-ph-bd: rgba(0,0,0,0.16);
  --sm-red: #dc2626; --sm-red-bg: rgba(220,38,38,0.10); --sm-red-bd: rgba(220,38,38,0.35); --sm-hover: rgba(0,0,0,0.06); }
.sm-sheet { width: min(440px, 96vw); max-height: 88vh; display: flex; flex-direction: column; border-radius: 18px;
  background: var(--sm-bg); color: var(--sm-ink); box-shadow: 0 12px 48px rgba(0,0,0,0.45); outline: none; overflow: hidden;
  font-family: inherit; }
.sm-head { display: flex; align-items: center; gap: 10px; padding: 14px 12px 6px 18px; flex: none; }
.sm-head .sm-ico { width: 22px; height: 22px; fill: var(--sm-ink); flex: none; }
.sm-title { margin: 0; font-size: 17px; font-weight: 600; flex: 1 1 auto; min-width: 0; }
.sm-st { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--sm-ink2); white-space: nowrap; }
.sm-st i { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; }
.sm-st.warn i { background: #eab308; } .sm-st.bad i { background: #ef4444; }
.sm-x { flex: none; width: 36px; height: 36px; border: 0; border-radius: 50%; background: none; color: var(--sm-ink); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; }
.sm-x:hover { background: var(--sm-hover); }
.sm-x .sm-ico { width: 22px; height: 22px; fill: currentColor; }
.sm-body { overflow-y: auto; overscroll-behavior: contain; padding: 4px 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.sm-hdr { display: flex; align-items: center; justify-content: space-between; gap: 7px; height: 22px; padding: 4px 4px 0; }
.sm-hdr.np { height: 26px; }
.sm-hdr-l { display: inline-flex; align-items: center; gap: 7px; }
.sm-hdr-l .sm-ico { width: 14px; height: 14px; fill: var(--sm-ink2); }
.sm-hdr-l span { font-size: 11px; font-weight: 600; letter-spacing: .4px; text-transform: uppercase; color: var(--sm-ink2); }
.sm-hdr-r { font-size: 10.5px; color: var(--sm-ink2); }
.sm-stopall { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 9px; cursor: pointer;
  background: var(--sm-red-bg); border: 1px solid var(--sm-red-bd); color: var(--sm-red); font: inherit; font-size: 10px; font-weight: 600; }
.sm-stopall .sm-ico { width: 13px; height: 13px; fill: var(--sm-red); }
.sm-car { display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; -ms-overflow-style: none; }
.sm-car::-webkit-scrollbar { display: none; }
.sm-car > * { flex: 0 0 100%; scroll-snap-align: start; min-width: 0; }
.sm-dots { display: flex; justify-content: center; gap: 2px; margin-top: -2px; }
.sm-dot { width: 18px; height: 18px; border: 0; padding: 0; background: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.sm-dot::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--sm-ink2); opacity: .35; }
.sm-dot.on::before { background: var(--sm-teal); opacity: 1; }
.sm-np { box-sizing: border-box; height: 118px; border-radius: 14px; background: var(--sm-np-bg); border: 1px solid var(--sm-np-bd);
  display: flex; flex-direction: column; justify-content: space-between; }
.sm-np-info { display: flex; align-items: center; gap: 9px; padding: 11px 13px 5px; overflow: hidden; }
.sm-np-info > .sm-ico { width: 18px; height: 18px; fill: var(--sm-teal); flex: none; }
.sm-np-txt { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; flex: 1 1 auto; }
.sm-np-lbl { font-size: 12.5px; font-weight: 600; color: var(--sm-np-label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-np-sub { font-size: 10.5px; color: var(--sm-mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-np-vol { font-size: 10.5px; font-weight: 500; color: var(--sm-mute); flex: none; }
.sm-np-ctl { display: flex; align-items: center; justify-content: space-between; gap: 1px; padding: 0 7px 7px; }
.sm-ib { width: 34px; height: 34px; border: 0; border-radius: 50%; background: none; cursor: pointer; padding: 0;
  display: inline-flex; align-items: center; justify-content: center; color: var(--sm-mute); }
.sm-ib:hover:not(:disabled) { background: var(--sm-hover); }
.sm-ib .sm-ico { width: 19px; height: 19px; fill: currentColor; }
.sm-ib.tr { color: var(--sm-ctl); } .sm-ib.pp { color: var(--sm-teal); } .sm-ib.st { color: var(--sm-red); }
.sm-ph { box-sizing: border-box; height: 46px; border-radius: 12px; background: var(--sm-ph-bg); border: 1px dashed var(--sm-ph-bd);
  display: flex; align-items: center; justify-content: center; gap: 7px; }
.sm-ph .sm-ico { width: 15px; height: 15px; fill: var(--sm-mute); }
.sm-ph span { font-size: 11.5px; font-weight: 500; color: var(--sm-mute); }
.sm-spks { display: flex; flex-direction: column; gap: 8px; }
.sm-spk { box-sizing: border-box; height: 50px; border-radius: 12px; display: flex; align-items: center; gap: 11px; padding: 0 16px;
  background: var(--sm-off-bg); border: 1px solid var(--sm-off-bd); color: var(--sm-ink); font: inherit; text-align: left; cursor: pointer; width: 100%; }
.sm-spk .sm-ico { fill: var(--sm-ink2); flex: none; }
.sm-spk .sm-chk { width: 19px; height: 19px; } .sm-spk .sm-sp { width: 15px; height: 15px; }
.sm-spk .sm-lbl { font-size: 13.5px; font-weight: 500; flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-spk.on { background: var(--sm-sel-bg); border-color: var(--sm-sel-bd); }
.sm-spk.on .sm-ico { fill: var(--sm-sel-ic); }
.sm-spk.tapped { box-shadow: 0 0 0 2px var(--sm-ring); }
.sm-tag { flex: none; font-size: 9.5px; font-weight: 600; letter-spacing: .3px; text-transform: uppercase; color: var(--sm-teal);
  border: 1px solid var(--sm-sel-bd); border-radius: 7px; padding: 1px 6px; }
.sm-np-lbl .sm-tag { margin-left: 6px; vertical-align: 1px; }
.sm-page { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; align-content: start; }
.sm-tile { position: relative; box-sizing: border-box; height: 74px; border-radius: 12px; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 7px; background: var(--sm-off-bg); border: 1px solid var(--sm-off-bd); color: var(--sm-ink); font: inherit;
  cursor: pointer; padding: 0 4px; min-width: 0; }
.sm-tile .sm-ico { width: 23px; height: 23px; fill: var(--sm-ink2); }
.sm-tile .sm-lbl { font-size: 11.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.sm-tile.on { background: var(--sm-sel-bg); border-color: var(--sm-sel-bd); }
.sm-tile.on .sm-ico { fill: var(--sm-sel-ic); }
.sm-tile.pending::after { content: ''; position: absolute; top: 7px; right: 7px; width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid var(--sm-sel-bd); border-top-color: var(--sm-teal); animation: sm-spin .8s linear infinite; }
@keyframes sm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .sm-tile.pending::after { animation: none; border-color: var(--sm-teal); } }
.sm-sheet button:disabled { cursor: default; }
.sm-tile:disabled:not(.pending), .sm-spk:disabled, .sm-ib:disabled, .sm-stopall:disabled { opacity: .5; }
.sm-busy .sm-tile:not(.pending) { opacity: .5; }
.sm-sheet button:focus-visible { outline: 2px solid var(--sm-teal); outline-offset: 2px; }
`;

/**
 * @param o  { soundMenu: rooms.json sensors.soundMenu, getHa: () => client|null,
 *           onOpen: () => void (close any tap popover), debug, now }
 * @returns the menu's handle, or null when the binding cannot drive a menu
 */
export function createSoundMenu(o) {
  const cfg = normaliseSoundMenu(o && o.soundMenu);
  if (!cfg) return null;
  const doc = (o && o.document) || document;
  const win = doc.defaultView || window;
  const now = (o && o.now) || (() => Date.now());
  const ha = () => (o.getHa ? o.getHa() : null);
  const ctl = createSoundController({ cfg, getHa: ha, sendScript, now });
  const model = () => ctl.model();

  let root = null, sheet = null, body = null, styleEl = null;
  let returnTo = null, sig = null, timer = 0, downOnBackdrop = false;
  const subscribed = new WeakSet();

  // ---- markup ----------------------------------------------------------------
  const hdr = (icon, label, right, cls) => '<div class="sm-hdr' + (cls ? ' ' + cls : '') + '"><span class="sm-hdr-l">' + ico(icon) +
    '<span>' + esc(label) + '</span></span>' + (right || '') + '</div>';
  const dots = (key, n) => (n > 1 ? '<div class="sm-dots" data-dots="' + key + '">' +
    Array.from({ length: n }, (_, i) => '<button type="button" class="sm-dot' + (i ? '' : ' on') + '" data-a="dot" data-car="' + key +
      '" data-i="' + i + '" aria-label="Page ' + (i + 1) + ' of ' + n + '"></button>').join('') + '</div>' : '');
  const ib = (action, icon, cls, label, eid, dis) => '<button type="button" class="sm-ib ' + cls + '" data-a="' + action + '" data-e="' + esc(eid) +
    '" aria-label="' + esc(label) + '"' + (dis ? ' disabled' : '') + '>' + ico(icon) + '</button>';

  function html(m) {
    const dis = !m.live;
    const st = SOUND_STATUS[m.statusKey];
    const head = '<div class="sm-head">' + ico('music') + '<h2 class="sm-title" id="sm-title">Ambience</h2>' +
      '<span class="sm-st ' + st[0] + '" data-st="' + m.statusKey + '" title="' + esc(st[2]) + '"><i></i>' + esc(st[1]) + '</span>' +
      '<button type="button" class="sm-x" data-a="close" aria-label="Close">' + ico('close') + '</button></div>';
    // NOW PLAYING
    const stopAll = m.stopAll ? '<button type="button" class="sm-stopall" data-a="stopAll"' + (dis ? ' disabled' : '') + '>' + ico('stop') +
      '<span>Stop all</span></button>' : '';
    let np = hdr('play-circle-outline', 'Now playing', stopAll, 'np');
    if (m.slides.length) {
      np += '<div class="sm-car" data-car="np">' + m.slides.map(s => '<div class="sm-np" data-slide="' + esc(s.entity) + '">' +
        '<div class="sm-np-info">' + ico('speaker') +
        '<div class="sm-np-txt"><span class="sm-np-lbl">' + esc(s.label) + (s.tapped ? '<span class="sm-tag">This speaker</span>' : '') +
        '</span><span class="sm-np-sub">' + esc(s.title) + '</span></div><span class="sm-np-vol">' + esc(s.volumeText) + '</span></div>' +
        '<div class="sm-np-ctl">' +
        ib('volDown', 'volume-minus', 'vol', 'Volume down', s.entity, dis) +
        ib('prev', 'skip-previous', 'tr', 'Previous', s.entity, dis) +
        ib('playPause', 'pause', 'pp', 'Pause', s.entity, dis) +
        ib('next', 'skip-next', 'tr', 'Next', s.entity, dis) +
        ib('stop', 'stop', 'st', 'Stop ' + s.label, s.entity, dis) +
        ib('volUp', 'volume-plus', 'vol', 'Volume up', s.entity, dis) +
        '</div></div>').join('') + '</div>' + dots('np', m.slides.length);
    } else {
      np += '<div class="sm-ph">' + ico('speaker-off') + '<span>Nothing playing</span></div>';
    }
    // PLAY ON
    const on = hdr('speaker-multiple', 'Play on') + '<div class="sm-spks">' + m.rows.map(r =>
      '<button type="button" class="sm-spk' + (r.selected ? ' on' : '') + (r.tapped ? ' tapped' : '') + '" data-a="spk" data-e="' + esc(r.entity) +
      '" role="checkbox" aria-checked="' + r.selected + '"' + (dis ? ' disabled' : '') + '>' +
      svgIcon(mdiPath(r.selected ? 'checkbox-marked' : 'checkbox-blank-outline'), 'sm-ico sm-chk') + svgIcon(mdiPath('speaker'), 'sm-ico sm-sp') +
      '<span class="sm-lbl">' + esc(r.label) + '</span>' + (r.tapped ? '<span class="sm-tag">This speaker</span>' : '') + '</button>').join('') + '</div>';
    // SOUNDS
    const busyText = m.busy ? '<span class="sm-hdr-r" data-busy>' + (m.busy.target === SOUND_NONE ? 'Stopping…' : 'Starting…') + '</span>' : '';
    let snd = hdr('music-note', 'Sounds', busyText);
    if (m.pages.length) {
      snd += '<div class="sm-car' + (m.busy ? ' sm-busy' : '') + '" data-car="snd">' + m.pages.map(p => '<div class="sm-page">' + p.map(t => {
        const pend = !!m.busy && m.busy.target === t.label;
        const sel = pend || (!m.busy && m.sound === t.label);
        return '<button type="button" class="sm-tile' + (sel ? ' on' : '') + (pend ? ' pending' : '') + '" data-a="snd" data-l="' + esc(t.label) +
          '" aria-pressed="' + sel + '"' + (dis || m.busy ? ' disabled' : '') + '>' + ico(t.icon) + '<span class="sm-lbl">' + esc(t.label) + '</span></button>';
      }).join('') + '</div>').join('') + '</div>' + dots('snd', m.pages.length);
    } else {
      snd += '<div class="sm-ph">' + ico('music-note') + '<span>No sounds</span></div>';
    }
    return { head, body: np + on + snd };
  }

  // ---- render ----------------------------------------------------------------
  function render(force) {
    if (!root) return;
    const m = model();
    const next = JSON.stringify(m);
    if (!force && next === sig) return;
    sig = next;
    const scroll = {};
    root.querySelectorAll('[data-car]').forEach(c => { if (c.classList.contains('sm-car')) scroll[c.dataset.car] = c.scrollLeft; });
    const top = body ? body.scrollTop : 0;
    const ae = doc.activeElement;
    const focusKey = ae && sheet && sheet.contains(ae) && ae.dataset && ae.dataset.a
      ? '[data-a="' + ae.dataset.a + '"]' + (ae.dataset.e ? '[data-e="' + ae.dataset.e + '"]' : '') + (ae.dataset.l ? '[data-l="' + CSS.escape(ae.dataset.l) + '"]' : '') +
        (ae.dataset.i ? '[data-i="' + ae.dataset.i + '"]' : '') + (ae.dataset.car ? '[data-car="' + ae.dataset.car + '"]' : '')
      : null;
    const h = html(m);
    sheet.innerHTML = h.head + '<div class="sm-body">' + h.body + '</div>';
    body = sheet.querySelector('.sm-body');
    body.scrollTop = top;
    root.querySelectorAll('.sm-car').forEach(c => {
      if (scroll[c.dataset.car] != null) c.scrollLeft = scroll[c.dataset.car];
      c.addEventListener('scroll', () => syncDots(c), { passive: true });
      syncDots(c);
    });
    if (focusKey) {
      const f = sheet.querySelector(focusKey);
      (f && !f.disabled ? f : sheet).focus({ preventScroll: true });
    }
  }

  function carIndex(c) {
    const kids = Array.from(c.children);
    let best = 0, bestD = Infinity;
    kids.forEach((k, i) => { const d = Math.abs(k.offsetLeft - c.offsetLeft - c.scrollLeft); if (d < bestD) { bestD = d; best = i; } });
    return best;
  }
  function syncDots(c) {
    const d = root && root.querySelector('[data-dots="' + c.dataset.car + '"]');
    if (!d) return;
    const i = carIndex(c);
    d.querySelectorAll('.sm-dot').forEach((b, k) => b.classList.toggle('on', k === i));
  }

  // ---- actions ---------------------------------------------------------------
  function tick() {
    ctl.tick();
    if (root) render(false);
    else if (!ctl.pendingRetrigger()) { clearInterval(timer); timer = 0; }
  }
  function ensureTimer() { if (!timer) timer = setInterval(() => { try { tick(); } catch (e) { /* never break the page */ } }, 200); }

  function act(btn) {
    const a = btn.dataset.a;
    if (a === 'close') { close(true); return; }
    if (a === 'dot') {
      const c = root.querySelector('.sm-car[data-car="' + btn.dataset.car + '"]');
      const k = c && c.children[+btn.dataset.i];
      if (k) c.scrollTo({ left: k.offsetLeft - c.offsetLeft, behavior: 'smooth' });
      return;
    }
    if (btn.disabled) return;
    ctl.tap(a, a === 'snd' ? btn.dataset.l : btn.dataset.e);
    ensureTimer();
    render(false);
  }

  // ---- input isolation -------------------------------------------------------
  const swallow = e => { e.stopPropagation(); };
  const SWALLOW = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick',
    'contextmenu', 'touchstart', 'touchmove', 'touchend', 'gesturestart'];
  const onWheel = e => {
    e.stopPropagation();
    // Over the backdrop (or a sheet that cannot scroll) the wheel must not
    // scroll or zoom anything beneath; inside the body it scrolls the body.
    if (!(body && body.contains(e.target))) e.preventDefault();
  };
  const onKeyDown = e => {
    if (!root) return;
    e.stopPropagation();   // nothing beneath the modal hears a key (room nav, camera)
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key !== 'Tab') return;
    const f = Array.from(sheet.querySelectorAll('button:not([disabled])'));
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(doc.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  };

  function open(t) {
    if (o.onOpen) { try { o.onOpen(); } catch (e) { /* the page's hook must not cost the menu */ } }
    const h = ha();
    if (h && !subscribed.has(h)) {
      subscribed.add(h);
      if (h.onSoundMenuChange) h.onSoundMenuChange(() => render(false));
      if (h.onStatusChange) h.onStatusChange(() => render(false));
    }
    ctl.setTapped((t && t.speaker) || null);
    if (root) { render(true); return; }
    if (!styleEl) { styleEl = doc.createElement('style'); styleEl.textContent = STYLE; doc.head.appendChild(styleEl); }
    returnTo = doc.activeElement;
    root = doc.createElement('div');
    root.className = 'sm-backdrop';
    root.dataset.soundMenu = '';
    sheet = doc.createElement('div');
    sheet.className = 'sm-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'sm-title');
    sheet.tabIndex = -1;
    root.appendChild(sheet);
    SWALLOW.forEach(ev => root.addEventListener(ev, swallow));
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('pointerdown', e => { downOnBackdrop = e.target === root; });
    root.addEventListener('click', e => {
      if (e.target === root) { if (downOnBackdrop) close(true); return; }
      const b = e.target.closest && e.target.closest('button[data-a]');
      if (b && sheet.contains(b)) act(b);
    });
    win.addEventListener('keydown', onKeyDown, true);
    doc.body.appendChild(root);
    sig = null;
    render(true);
    sheet.focus({ preventScroll: true });
    ensureTimer();
  }

  function close(restoreFocus) {
    if (!root) return;
    win.removeEventListener('keydown', onKeyDown, true);
    if (root.parentNode) root.parentNode.removeChild(root);
    root = sheet = body = null;
    ctl.setTapped(null);
    if (restoreFocus && returnTo && returnTo !== doc.body && returnTo.isConnected && returnTo.focus) returnTo.focus({ preventScroll: true });
    returnTo = null;
  }

  const api = {
    openFrom: cfg.openFrom,
    config: cfg,
    open,
    close: () => close(false),
    isOpen: () => !!root,
    refresh: () => render(false),
    /** Debug: what was sent (or applied to the sample), and the current model. */
    _sent: () => ctl.sent(),
    _model: () => model(),
    dispose() {
      close(false);
      clearInterval(timer); timer = 0;
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      if (o.debug && win.__home3dSound === api) delete win.__home3dSound;
    },
  };
  if (o.debug) win.__home3dSound = api;
  return api;
}
