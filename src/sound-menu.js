/**
 * sound-menu.js -- the sound menu's DOM half: a big card mirroring the wall
 * tablet's "Ambience" pop-up (NOW PLAYING / PLAY ON / SOUNDS). The model, the
 * ordering and every command it sends are src/sound-model.js; this file only
 * renders them and wires the taps.
 *
 * OPENED BY a tap on any furniture item named in `sensors.soundMenu.openFrom`
 * (src/tap-popovers.js furnitureTarget hands the tap here instead of opening
 * a compact card), after the camera's flight to the speaker lands.
 *
 * PLACED LIKE EVERY TAP CARD: anchored to the speaker's on-screen position
 * by the cards' own placePopover (src/tap-popovers.js), with the same arrow
 * pointing at it, flipped and fitted to the visible scene (fitSoundMenu
 * below). On a wide screen the flight framed the speaker with room beside it
 * (coverRight) and the menu prefers that side; on a phone it goes above or
 * below the speaker, its height capped to the room there (the body scrolls).
 * It follows the speaker's projection and the scene's bounds (a resize).
 *
 * It is still MODAL: it closes any open popover when it opens, and an
 * invisible backdrop swallows every pointer, wheel and key event so nothing
 * reaches the 3D scene beneath it (no orbit, no furniture tap, no room-nav
 * arrow). Esc, the close button or a tap outside it (on the backdrop, as a
 * card closes on a tap elsewhere) closes it, and focus returns where it was.
 *
 * NOW PLAYING slides are a copy of Home Assistant's media-control card
 * (hui-media-control-card): the artwork full height on the right, faded in
 * from the artwork's dominant colour, the player's icon and name, title and
 * artist, prev / play-pause / next, and a thin progress bar ticking only
 * while playing. No artwork (or one that will not load): the player icon
 * over a neutral background, as HA does.
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
 *
 * SPOTIFY (soundMenu.spotify): a green tile first in SOUNDS opens the picker
 * in place of the menu (a back arrow and Esc return to it): Music Assistant's
 * recently played Spotify tracks, or a search as you type (400 ms after the
 * last key, 2 characters or more). A row plays that track on every selected
 * speaker (src/sound-model.js, "SPOTIFY"). The search box survives every
 * repaint: in picker mode only the list is rebuilt.
 */

import { mdiPath, svgIcon } from './ui-icons.js';
import { sendScript } from './script-call.js';
import { normaliseSoundMenu, createSoundController, mediaProgress, dominantColor, inkFor, SOUND_NONE, SPOTIFY_GREEN } from './sound-model.js';
import { placePopover } from './tap-popovers.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ico = (name, cls) => svgIcon(mdiPath(name), 'sm-ico' + (cls ? ' ' + cls : ''));

/** Status line for the header, the tap popovers' wording. */
export const SOUND_STATUS = {
  ok: ['ok', 'Live', 'Connected to Home Assistant.'],
  connecting: ['warn', 'Connecting…', 'Syncing with Home Assistant. Controls are disabled until it finishes.'],
  haOffline: ['bad', 'HA offline', 'Home Assistant is not connected. Controls are disabled until it reconnects.'],
  mock: ['bad', 'Not connected', 'No Home Assistant configured. Showing sample speakers and sounds; changes only preview.'],
};

/**
 * The card's width (px); the gap either side of it that the flight leaves
 * beside the speaker; the narrowest viewport that leaves room beside it; and
 * the shortest the card is squeezed to (above/below the speaker) before it
 * gives up on the arrow and is clamped into the screen instead.
 */
export const SHEET_W = 400;
export const SIDE_GAP = 24;
export const SIDE_MIN_VW = 900;
export const MENU_MIN_H = 240;
const GAP = 12, MARGIN = 8;   // placePopover's defaults: the cards' own

/**
 * Where the menu goes and how tall it may be, for an anchor
 * { x, y, rect? } inside `bounds`. Placement is the cards' placePopover with
 * the speaker's on-screen box as the anchor (the card keeps its gap from the
 * box, so it never covers the speaker), preferring the side when `side`.
 * The height: the full bounds when it fits beside the speaker; else capped
 * to the room above or below (the larger) when that is at least MENU_MIN_H,
 * so it keeps its arrow on a phone. A box too big to sit beside: retried
 * from the point alone, as a card would be.
 * @returns placePopover's { left, top, placement, arrow } + { height }
 */
export function fitSoundMenu(a, w, natH, bounds, side) {
  const r = a.rect || { left: a.x, right: a.x, top: a.y, bottom: a.y };
  const full = Math.max(0, bounds.bottom - bounds.top - 2 * MARGIN);
  const roomA = r.top - GAP - (bounds.top + MARGIN), roomB = bounds.bottom - MARGIN - (r.bottom + GAP);
  const beside = bounds.right - MARGIN - (r.right + GAP) >= w || (r.left - GAP) - (bounds.left + MARGIN) >= w;
  let h = Math.min(natH, full);
  const vert = Math.max(roomA, roomB);
  if (!beside && h > vert && vert >= MENU_MIN_H) h = vert;
  const p = placePopover(a.x, a.y, w, h, bounds, GAP, MARGIN, { rect: a.rect || null, prefer: side ? 'side' : null });
  if (p.placement === 'clamped' && a.rect) return fitSoundMenu({ x: a.x, y: a.y }, w, natH, bounds, side);
  return Object.assign(p, { height: h });
}

/** The progress bar's width (%) for a slide's frozen progress at nowMs, or null (no bar). */
export function progressPct(pr, nowMs) {
  if (!pr) return null;
  const p = mediaProgress({ state: pr.state, attributes: { media_position: pr.position, media_duration: pr.duration,
    media_position_updated_at: pr.updatedAt } }, nowMs);
  return p ? Math.round(p.fraction * 1000) / 10 : null;
}

/** A URL made safe inside CSS url("..."): quotes, backslashes and newlines percent-encoded. */
export const cssUrl = u => String(u).replace(/["\\\n\r]/g, c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));

export const STYLE = `
.sm-backdrop { position: fixed; inset: 0; z-index: 80; background: transparent; overscroll-behavior: contain;
  --sm-bg: #17181c; --sm-ink: #e8eaed; --sm-ink2: #9aa0a6; --sm-mute: #8b8f99; --sm-np-label: #ffffff; --sm-ctl: #d8dae0;
  --sm-teal: #67f0d9; --sm-sel-ic: rgba(103,240,217,0.95); --sm-sel-bg: rgba(103,240,217,0.16); --sm-sel-bd: rgba(103,240,217,0.40);
  --sm-np-bg: rgba(103,240,217,0.08); --sm-np-bd: rgba(103,240,217,0.28); --sm-ring: rgba(103,240,217,0.70);
  --sm-off-bg: rgba(255,255,255,0.04); --sm-off-bd: rgba(255,255,255,0.08);
  --sm-ph-bg: rgba(255,255,255,0.03); --sm-ph-bd: rgba(255,255,255,0.10);
  --sm-red: #f06767; --sm-red-bg: rgba(240,103,103,0.14); --sm-red-bd: rgba(240,103,103,0.38);
  --sm-hover: rgba(255,255,255,0.08); --sm-mc-bg: #2c2f36; --sm-mc-ink: #ffffff; color-scheme: dark; }
:root[data-theme="light"] .sm-backdrop { color-scheme: only light;
  --sm-bg: #f7f8fb; --sm-ink: #1a1d29; --sm-ink2: #5b6070; --sm-mute: #5f6472; --sm-np-label: #1a1d29; --sm-ctl: #374151;
  --sm-teal: #0f766e; --sm-sel-ic: #0f766e; --sm-sel-bg: rgba(13,148,136,0.12); --sm-sel-bd: rgba(13,148,136,0.45);
  --sm-np-bg: rgba(13,148,136,0.07); --sm-np-bd: rgba(13,148,136,0.30); --sm-ring: rgba(13,148,136,0.65);
  --sm-off-bg: rgba(0,0,0,0.03); --sm-off-bd: rgba(0,0,0,0.10);
  --sm-ph-bg: rgba(0,0,0,0.02); --sm-ph-bd: rgba(0,0,0,0.16);
  --sm-red: #dc2626; --sm-red-bg: rgba(220,38,38,0.10); --sm-red-bd: rgba(220,38,38,0.35); --sm-hover: rgba(0,0,0,0.06);
  --sm-mc-bg: #e3e5ea; --sm-mc-ink: #1a1d29; }
/* The card is placed like a tap card (fitSoundMenu): the frame is positioned,
   the sheet fills it, and the arrow is the cards' diamond in the sheet's colour. */
.sm-frame { position: fixed; left: 0; top: 0; width: ${SHEET_W}px; }
.sm-sheet { width: 100%; max-height: 88vh; display: flex; flex-direction: column; border-radius: 18px; box-sizing: border-box;
  background: var(--sm-bg); color: var(--sm-ink); box-shadow: 0 12px 48px rgba(0,0,0,0.45); outline: none; overflow: hidden;
  border: 1px solid var(--sm-off-bd); font-family: inherit; }
.sm-arrow { position: absolute; width: 13px; height: 13px; background: var(--sm-bg); border: 0 solid var(--sm-off-bd); }
.sm-arrow.bottom { bottom: -7px; transform: translateX(-50%) rotate(45deg); border-right-width: 1px; border-bottom-width: 1px; }
.sm-arrow.top { top: -7px; transform: translateX(-50%) rotate(45deg); border-left-width: 1px; border-top-width: 1px; }
.sm-arrow.left { left: -7px; transform: translateY(-50%) rotate(45deg); border-left-width: 1px; border-bottom-width: 1px; }
.sm-arrow.right { right: -7px; transform: translateY(-50%) rotate(45deg); border-right-width: 1px; border-top-width: 1px; }
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
/* min-height 0 lets the body scroll inside the 88vh sheet; flex-shrink 0 stops a
   tall menu (two slides) squeezing the sections -- it scrolls instead. */
.sm-body { overflow-y: auto; overscroll-behavior: contain; padding: 4px 14px 16px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.sm-body > * { flex-shrink: 0; }
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
/* NOW PLAYING: Home Assistant's media-control card (hui-media-control-card).
   Its layers: a colour block, the artwork full height on the right (a square
   as wide as the card is tall), a gradient from the artwork's colour to
   transparent over the artwork's left, and the player on top. */
.sm-mc { position: relative; box-sizing: border-box; border-radius: 12px; overflow: hidden; color: var(--mc-ink, var(--sm-mc-ink));
  --mc-h: 196px; height: var(--mc-h); font-size: 14px; }
.sm-mc-bg { position: absolute; inset: 0; display: flex; }
.sm-mc-block { width: 100%; background: var(--mc-bg, var(--sm-mc-bg)); transition: background-color .8s; }
.sm-mc-art { position: absolute; right: 0; top: 0; height: 100%; width: var(--mc-h); background-position: center; background-size: cover;
  background-repeat: no-repeat; }
.sm-mc-grad { position: absolute; right: 0; top: 0; height: 100%; width: var(--mc-h);
  background-image: linear-gradient(to right, var(--mc-bg, var(--sm-mc-bg)), transparent); }
.sm-mc-noimg { position: absolute; right: 0; top: 0; height: 100%; width: 50%; display: flex; align-items: center; justify-content: center; }
.sm-mc-noimg .sm-ico { width: 96px; height: 96px; fill: currentColor; opacity: .14; }
.sm-mc-player { position: relative; box-sizing: border-box; height: 100%; padding: 16px; display: flex; flex-direction: column; justify-content: space-between; }
.sm-mc-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.sm-mc-name { display: flex; align-items: center; min-width: 0; white-space: nowrap; overflow: hidden; }
.sm-mc-name > span:first-of-type { overflow: hidden; text-overflow: ellipsis; }
.sm-mc-name > .sm-ico { width: 24px; height: 24px; fill: currentColor; flex: none; margin-right: 8px; }
.sm-mc-name .sm-tag { margin-left: 8px; color: inherit; border-color: currentColor; opacity: .85; }
.sm-mc-vol { font-size: 12px; opacity: .8; flex: none; }
.sm-mc-tc { padding-top: 16px; }
.sm-mc-info { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 8px; }
.sm-mc-title { font-size: 1.2em; margin: 0 0 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-mc-ctl { display: flex; align-items: center; margin-left: -12px; padding: 8px 8px 8px 0; }
.sm-mc-ctl > div { display: flex; align-items: center; }
.sm-mc-ctl > .start { flex-grow: 1; }
.sm-ib { border: 0; border-radius: 50%; background: none; cursor: pointer; padding: 0; flex: none;
  display: inline-flex; align-items: center; justify-content: center; }
.sm-ib .sm-ico { fill: currentColor; }
.sm-mc .sm-ib { width: 44px; height: 44px; color: inherit; }
.sm-mc .sm-ib .sm-ico { width: 30px; height: 30px; }
.sm-mc .sm-ib.pp { width: 56px; height: 56px; } .sm-mc .sm-ib.pp .sm-ico { width: 40px; height: 40px; }
.sm-mc .end .sm-ib { width: 40px; height: 40px; } .sm-mc .end .sm-ib .sm-ico { width: 24px; height: 24px; }
.sm-mc .sm-ib:hover:not(:disabled) { background: rgba(127,127,127,0.22); }
.sm-mc-bar { height: 6px; border-radius: 3px; background: rgba(200,200,200,0.5); overflow: hidden; }
.sm-mc-bar i { display: block; height: 100%; background: currentColor; border-radius: 3px; }
.sm-mc.no-bar .sm-mc-ctl { padding-bottom: 0; }
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
.sm-tile.sm-spot { background: rgba(29,185,84,0.08); border-color: rgba(29,185,84,0.40); }
.sm-tile.sm-spot .sm-ico, .sm-head .sm-ico.sm-spotify, .sm-art .sm-ico { fill: ${SPOTIFY_GREEN}; }
.sm-note { box-sizing: border-box; border-radius: 10px; padding: 8px 12px; font-size: 11.5px; font-weight: 500; }
.sm-note.ok { color: var(--sm-teal); background: var(--sm-np-bg); border: 1px solid var(--sm-np-bd); }
.sm-note.error, .sm-err { color: var(--sm-red); background: var(--sm-red-bg); border: 1px solid var(--sm-red-bd); }
.sm-note.warn { color: #b45309; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.40); }
:root:not([data-theme="light"]) .sm-note.warn { color: #fbbf24; }
.sm-err { display: flex; align-items: flex-start; gap: 8px; border-radius: 10px; padding: 9px 12px; font-size: 11.5px; line-height: 1.35; }
.sm-err .sm-ico { width: 15px; height: 15px; fill: var(--sm-red); flex: none; margin-top: 1px; }
.sm-qw { display: flex; align-items: center; gap: 8px; height: 40px; box-sizing: border-box; padding: 0 12px; border-radius: 12px;
  background: var(--sm-off-bg); border: 1px solid var(--sm-off-bd); }
.sm-qw .sm-ico { width: 18px; height: 18px; fill: var(--sm-ink2); flex: none; }
.sm-q { flex: 1 1 auto; min-width: 0; border: 0; outline: none; background: none; color: var(--sm-ink); font: inherit; font-size: 14px; }
.sm-q::placeholder { color: var(--sm-ink2); }
.sm-qw:focus-within { border-color: var(--sm-sel-bd); }
.sm-plist { display: flex; flex-direction: column; gap: 6px; }
.sm-row { box-sizing: border-box; width: 100%; height: 56px; display: flex; align-items: center; gap: 11px; padding: 0 10px 0 8px; border-radius: 12px;
  background: var(--sm-off-bg); border: 1px solid var(--sm-off-bd); color: var(--sm-ink); font: inherit; text-align: left; cursor: pointer; }
.sm-row:hover:not(:disabled) { background: var(--sm-hover); }
.sm-row:disabled { opacity: .5; } .sm-row.pending { opacity: 1; border-color: var(--sm-sel-bd); }
.sm-art { width: 40px; height: 40px; border-radius: 6px; overflow: hidden; flex: none; display: flex; align-items: center; justify-content: center;
  background: var(--sm-off-bg); }
.sm-art img { width: 40px; height: 40px; object-fit: cover; display: block; }
.sm-art .sm-ico { width: 20px; height: 20px; }
.sm-rt { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; line-height: 1.25; }
.sm-rtt { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-rta { font-size: 11px; color: var(--sm-mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-rs { font-size: 10.5px; color: var(--sm-teal); flex: none; }
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
  const ctl = createSoundController({ cfg, getHa: ha, sendScript, now, onChange: () => render(false) });
  const model = () => ctl.model();

  let root = null, frame = null, arrow = null, sheet = null, body = null, styleEl = null;
  let anchorFn = null, preferSide = false, lastSlides = null, lastAnchor = '';
  let returnTo = null, sig = null, timer = 0, downOnBackdrop = false, onCloseHook = null;
  const subscribed = new WeakSet();

  // ---- markup ----------------------------------------------------------------
  const hdr = (icon, label, right, cls) => '<div class="sm-hdr' + (cls ? ' ' + cls : '') + '"><span class="sm-hdr-l">' + ico(icon) +
    '<span>' + esc(label) + '</span></span>' + (right || '') + '</div>';
  const dots = (key, n) => (n > 1 ? '<div class="sm-dots" data-dots="' + key + '">' +
    Array.from({ length: n }, (_, i) => '<button type="button" class="sm-dot' + (i ? '' : ' on') + '" data-a="dot" data-car="' + key +
      '" data-i="' + i + '" aria-label="Page ' + (i + 1) + ' of ' + n + '"></button>').join('') + '</div>' : '');
  const ib = (action, icon, cls, label, eid, dis) => '<button type="button" class="sm-ib ' + cls + '" data-a="' + action + '" data-e="' + esc(eid) +
    '" aria-label="' + esc(label) + '"' + (dis ? ' disabled' : '') + '>' + ico(icon) + '</button>';

  // One NOW PLAYING slide: HA's media-control card. The artwork shows only
  // once it has loaded (artLook), with its dominant colour behind the fade.
  function mediaCard(s, dis) {
    const look = s.art ? artLook(s.art) : null;
    const hasArt = !!(look && look.ok);
    const vars = hasArt && look.bg ? ' style="--mc-bg:' + look.bg + ';--mc-ink:' + look.ink + '"' : '';
    const pct = progressPct(s.progress, now());
    const bg = '<div class="sm-mc-bg"><div class="sm-mc-block"></div>' + (hasArt
      ? '<div class="sm-mc-art" style="background-image:url(&quot;' + esc(cssUrl(s.art)) + '&quot;)"></div><div class="sm-mc-grad"></div>'
      : '<div class="sm-mc-noimg">' + ico('speaker') + '</div>') + '</div>';
    return '<div class="sm-mc' + (hasArt ? '' : ' no-art') + (pct == null ? ' no-bar' : '') + '" data-slide="' + esc(s.entity) + '"' + vars + '>' + bg +
      '<div class="sm-mc-player"><div class="sm-mc-top"><div class="sm-mc-name">' + ico('speaker') + '<span>' + esc(s.label) + '</span>' +
      (s.tapped ? '<span class="sm-tag">This speaker</span>' : '') + '</div><span class="sm-mc-vol" title="Volume">' + esc(s.volumeText) + '</span></div>' +
      '<div><div class="sm-mc-tc"><div class="sm-mc-info"><div class="sm-mc-title">' + esc(s.title) + '</div>' + esc(s.artist) + '</div>' +
      '<div class="sm-mc-ctl"><div class="start">' +
      ib('prev', 'skip-previous', 'tr', 'Previous', s.entity, dis) +
      ib('playPause', 'pause', 'pp', 'Pause', s.entity, dis) +
      ib('next', 'skip-next', 'tr', 'Next', s.entity, dis) +
      '</div><div class="end">' +
      ib('volDown', 'volume-minus', 'vol', 'Volume down', s.entity, dis) +
      ib('volUp', 'volume-plus', 'vol', 'Volume up', s.entity, dis) +
      ib('stop', 'stop', 'st', 'Stop ' + s.label, s.entity, dis) +
      '</div></div></div>' +
      (pct == null ? '' : '<div class="sm-mc-bar" role="progressbar" aria-label="Track progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
        Math.round(pct) + '"><i data-bar="' + esc(s.entity) + '" style="width:' + pct + '%"></i></div>') +
      '</div></div></div>';
  }

  // ---- artwork: loaded once per URL, its dominant colour read off a canvas
  // (HA's card extracts its colours the same way). A URL that will not load
  // (HA-proxied art cross-origin) falls back to the no-art look; one that
  // loads but cannot be read (no CORS) shows over the neutral colour.
  const looks = new Map();
  function artLook(url) {
    const hit = looks.get(url);
    if (hit) return hit;
    const look = { ok: false, bg: null, ink: null };
    looks.set(url, look);
    if (looks.size > 24) looks.delete(looks.keys().next().value);
    if (!win.Image) return look;
    const load = cors => {
      const img = new win.Image();
      if (cors) img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        look.ok = true;
        try {
          const c = doc.createElement('canvas');
          c.width = c.height = 24;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0, 24, 24);
          const rgb = dominantColor(g.getImageData(0, 0, 24, 24).data);
          if (rgb) { look.bg = 'rgb(' + rgb.join(',') + ')'; look.ink = inkFor(rgb); }
        } catch (e) { /* tainted canvas: the art shows, the neutral colour stays */ }
        if (root) { sig = null; render(false); }
      };
      // Refused with CORS: try once without (the art may still show).
      img.onerror = () => { if (cors) load(false); };
      img.src = url;
    };
    load(true);
    return look;
  }
  // The bars move between repaints (a repaint happens only when the model changes).
  function tickBars() {
    if (!root || !lastSlides) return;
    root.querySelectorAll('[data-bar]').forEach(el => {
      const sl = lastSlides.find(x => x.entity === el.dataset.bar);
      const pct = sl ? progressPct(sl.progress, now()) : null;
      if (pct != null) el.style.width = pct + '%';
    });
  }

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
      np += '<div class="sm-car" data-car="np">' + m.slides.map(s => mediaCard(s, dis)).join('') + '</div>' + dots('np', m.slides.length);
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
        if (t.spotify) {
          return '<button type="button" class="sm-tile sm-spot" data-a="spotify" aria-label="Spotify: recent tracks and search"' +
            (dis || m.busy ? ' disabled' : '') + '>' + ico('spotify') + '<span class="sm-lbl">Spotify</span></button>';
        }
        const pend = !!m.busy && m.busy.target === t.label;
        const sel = pend || (!m.busy && m.sound === t.label);
        return '<button type="button" class="sm-tile' + (sel ? ' on' : '') + (pend ? ' pending' : '') + '" data-a="snd" data-l="' + esc(t.label) +
          '" aria-pressed="' + sel + '"' + (dis || m.busy ? ' disabled' : '') + '>' + ico(t.icon) + '<span class="sm-lbl">' + esc(t.label) + '</span></button>';
      }).join('') + '</div>').join('') + '</div>' + dots('snd', m.pages.length);
    } else {
      snd += '<div class="sm-ph">' + ico('music-note') + '<span>No sounds</span></div>';
    }
    const note = m.notice ? '<div class="sm-note ' + m.notice.kind + '" role="status" data-note>' + esc(m.notice.text) + '</div>' : '';
    return { head, body: note + np + on + snd };
  }

  // ---- the Spotify picker ------------------------------------------------------
  function pickerHead(m) {
    const st = SOUND_STATUS[m.statusKey];
    return '<div class="sm-head"><button type="button" class="sm-x" data-a="back" aria-label="Back to the sound menu">' + ico('arrow-left') + '</button>' +
      ico('spotify', 'sm-spotify') + '<h2 class="sm-title" id="sm-title">Spotify</h2>' +
      '<span class="sm-st ' + st[0] + '" data-st="' + m.statusKey + '" title="' + esc(st[2]) + '"><i></i>' + esc(st[1]) + '</span>' +
      '<button type="button" class="sm-x" data-a="close" aria-label="Close">' + ico('close') + '</button></div>';
  }
  function pickerList(m) {
    const pk = m.picker;
    const dis = !m.live || !!pk.playing;
    const on = pk.on.length ? 'Plays on ' + pk.on.join(', ') : 'No speaker selected';
    let h = hdr(pk.kind === 'search' ? 'magnify' : 'music-note', pk.kind === 'search' ? 'Results' : 'Recently played',
      '<span class="sm-hdr-r">' + esc(on) + '</span>');
    if (pk.error) h += '<div class="sm-err" role="alert" data-err>' + ico('alert-circle-outline') + '<span>' + esc(pk.error) + '</span></div>';
    if (pk.status === 'loading' || pk.status === 'idle') h += '<div class="sm-ph"><span>Loading…</span></div>';
    else if (pk.status === 'ok' && !pk.items.length) {
      h += '<div class="sm-ph">' + ico('spotify') + '<span>' + (pk.kind === 'search' ? 'No Spotify tracks match' : 'No Spotify tracks played recently') + '</span></div>';
    }
    if (pk.items.length) {
      h += '<div class="sm-plist">' + pk.items.map(t => {
        const pend = pk.playing && pk.playing.uri === t.uri;
        const art = t.image ? '<img src="' + esc(t.image) + '" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer">' : ico('spotify');
        return '<button type="button" class="sm-row' + (pend ? ' pending' : '') + '" data-a="play" data-u="' + esc(t.uri) + '"' + (dis ? ' disabled' : '') + '>' +
          '<span class="sm-art">' + art + '</span><span class="sm-rt"><span class="sm-rtt">' + esc(t.title) + '</span><span class="sm-rta">' +
          esc(t.artists) + '</span></span>' + (pend ? '<span class="sm-rs">' + (pk.playing.phase === 'stopping' ? 'Stopping ambience…' : 'Starting…') + '</span>' : '') +
          '</button>';
      }).join('') + '</div>';
    }
    return h;
  }
  function renderPicker(m, force) {
    if (force || sheet.dataset.mode !== 'picker') {
      sheet.dataset.mode = 'picker';
      sheet.innerHTML = pickerHead(m) + '<div class="sm-body"><div class="sm-qw">' + ico('magnify') +
        '<input class="sm-q" type="search" placeholder="Search Spotify" aria-label="Search Spotify" autocomplete="off" enterkeyhint="search" value="' +
        esc(m.picker.query) + '"></div><div data-plist></div></div>';
      body = sheet.querySelector('.sm-body');
      const q = sheet.querySelector('.sm-q');
      q.addEventListener('input', () => { ctl.setQuery(q.value); ensureTimer(); });
      q.focus({ preventScroll: true });
    } else {
      const st = sheet.querySelector('.sm-st');
      const s = SOUND_STATUS[m.statusKey];
      if (st && st.dataset.st !== m.statusKey) st.outerHTML = '<span class="sm-st ' + s[0] + '" data-st="' + m.statusKey + '" title="' + esc(s[2]) + '"><i></i>' + esc(s[1]) + '</span>';
    }
    sheet.querySelector('[data-plist]').innerHTML = pickerList(m);
    place();
  }

  // ---- render ----------------------------------------------------------------
  function render(force) {
    if (!root) return;
    const m = model();
    const next = JSON.stringify(m);
    if (!force && next === sig) return;
    sig = next;
    if (m.picker) { renderPicker(m, force); return; }
    const wasPicker = sheet.dataset.mode === 'picker';
    sheet.dataset.mode = 'menu';
    const scroll = {};
    root.querySelectorAll('[data-car]').forEach(c => { if (c.classList.contains('sm-car')) scroll[c.dataset.car] = c.scrollLeft; });
    const top = body && !wasPicker ? body.scrollTop : 0;
    const ae = doc.activeElement;
    const focusKey = ae && sheet && sheet.contains(ae) && ae.dataset && ae.dataset.a
      ? '[data-a="' + ae.dataset.a + '"]' + (ae.dataset.e ? '[data-e="' + ae.dataset.e + '"]' : '') + (ae.dataset.l ? '[data-l="' + CSS.escape(ae.dataset.l) + '"]' : '') +
        (ae.dataset.i ? '[data-i="' + ae.dataset.i + '"]' : '') + (ae.dataset.car ? '[data-car="' + ae.dataset.car + '"]' : '')
      : null;
    lastSlides = m.slides;
    const h = html(m);
    sheet.innerHTML = h.head + '<div class="sm-body">' + h.body + '</div>';
    body = sheet.querySelector('.sm-body');
    place();
    body.scrollTop = top;
    root.querySelectorAll('.sm-car').forEach(c => {
      if (scroll[c.dataset.car] != null) c.scrollLeft = scroll[c.dataset.car];
      c.addEventListener('scroll', () => syncDots(c), { passive: true });
      syncDots(c);
    });
    if (focusKey) {
      const f = sheet.querySelector(focusKey);
      (f && !f.disabled ? f : sheet).focus({ preventScroll: true });
    } else if (wasPicker) {
      const f = sheet.querySelector('[data-a="spotify"]');
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
    if (root) { render(false); tickBars(); followAnchor(); }
    else if (!ctl.pendingRetrigger() && !ctl.playing()) { clearInterval(timer); timer = 0; }
  }
  function ensureTimer() { if (!timer) timer = setInterval(() => { try { tick(); } catch (e) { /* never break the page */ } }, 200); }

  function act(btn) {
    const a = btn.dataset.a;
    if (a === 'close') { close(true, 'dismiss'); return; }
    if (a === 'dot') {
      const c = root.querySelector('.sm-car[data-car="' + btn.dataset.car + '"]');
      const k = c && c.children[+btn.dataset.i];
      if (k) c.scrollTo({ left: k.offsetLeft - c.offsetLeft, behavior: 'smooth' });
      return;
    }
    if (a === 'back') { ctl.closePicker(); render(true); return; }
    if (btn.disabled) return;
    if (a === 'spotify') { ctl.openPicker(); ensureTimer(); render(true); return; }
    if (a === 'play') ctl.playTrack(btn.dataset.u);
    else ctl.tap(a, a === 'snd' ? btn.dataset.l : btn.dataset.e);
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
    if (e.key === 'Escape') {
      e.preventDefault();
      if (ctl.pickerOpen()) { ctl.closePicker(); render(true); } else close(true, 'escape');
      return;
    }
    if (e.key !== 'Tab') return;
    const f = Array.from(sheet.querySelectorAll('button:not([disabled]), input'));
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(doc.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
  };

  // ROOM BESIDE THE SPEAKER: on a screen wide enough, the flight that
  // precedes the menu (src/tap-dispatch.js) frames the speaker in the canvas
  // minus this much on the right, so the card fits beside it.
  function coverRight() {
    const w = win.innerWidth || 0;
    return w >= SIDE_MIN_VW ? SHEET_W + 2 * SIDE_GAP : 0;
  }

  // Place the card (fitSoundMenu). With no anchor (opened from code) it is
  // centred, with no arrow.
  function place() {
    if (!root || !frame) return;
    const vw = win.innerWidth || 0, vh = win.innerHeight || 0;
    let a = null;
    try { a = anchorFn ? anchorFn() : null; } catch (e) { a = null; }
    const bounds = (a && a.bounds) || { left: 0, top: 0, right: vw, bottom: vh };
    const w = Math.max(0, Math.min(SHEET_W, bounds.right - bounds.left - 2 * MARGIN));
    frame.style.width = w + 'px';
    const keep = body ? body.scrollTop : 0;
    sheet.style.maxHeight = 'none';
    const natH = sheet.offsetHeight;
    lastAnchor = a ? JSON.stringify([a.x, a.y, a.rect, a.bounds]) : '';
    let p;
    if (a) p = fitSoundMenu(a, w, natH, bounds, preferSide);
    else {
      const h = Math.min(natH, Math.max(0, vh - 2 * MARGIN));
      p = { left: Math.round((vw - w) / 2), top: Math.round((vh - h) / 2), placement: 'centred', arrow: null, height: h };
    }
    sheet.style.maxHeight = p.height + 'px';
    if (body) body.scrollTop = keep;
    frame.style.left = p.left + 'px';
    frame.style.top = p.top + 'px';
    frame.dataset.placement = p.placement;
    arrow.className = 'sm-arrow' + (p.arrow ? ' ' + p.arrow.side : '');
    arrow.style.display = p.arrow ? '' : 'none';
    arrow.style.left = arrow.style.top = '';
    if (p.arrow) arrow.style[p.arrow.side === 'top' || p.arrow.side === 'bottom' ? 'left' : 'top'] = p.arrow.offset + 'px';
  }
  // Re-place when the speaker's projection or the scene's bounds moved.
  function followAnchor() {
    if (!root || !anchorFn) return;
    let a = null;
    try { a = anchorFn(); } catch (e) { return; }
    if (a && JSON.stringify([a.x, a.y, a.rect, a.bounds]) !== lastAnchor) place();
  }
  const onResize = () => place();

  function open(t) {
    if (o.onOpen) { try { o.onOpen(); } catch (e) { /* the page's hook must not cost the menu */ } }
    // The opener's close hook (the tap route: the camera returns when the
    // menu closes). A re-open replaces it.
    onCloseHook = t && typeof t.onClose === 'function' ? t.onClose : null;
    const h = ha();
    if (h && !subscribed.has(h)) {
      subscribed.add(h);
      if (h.onSoundMenuChange) h.onSoundMenuChange(() => render(false));
      if (h.onStatusChange) h.onStatusChange(() => render(false));
    }
    ctl.setTapped((t && t.speaker) || null);
    // The anchor: () => { x, y, rect, bounds } (the tap route), or none (centred).
    anchorFn = t && typeof t.anchor === 'function' ? t.anchor : null;
    preferSide = !!(t && t.side);
    if (root) { render(true); return; }
    if (!styleEl) { styleEl = doc.createElement('style'); styleEl.textContent = STYLE; doc.head.appendChild(styleEl); }
    returnTo = doc.activeElement;
    root = doc.createElement('div');
    root.className = 'sm-backdrop';
    root.dataset.soundMenu = '';
    frame = doc.createElement('div');
    frame.className = 'sm-frame';
    sheet = doc.createElement('div');
    sheet.className = 'sm-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'sm-title');
    sheet.tabIndex = -1;
    arrow = doc.createElement('span');
    arrow.className = 'sm-arrow';
    frame.appendChild(sheet);
    frame.appendChild(arrow);
    root.appendChild(frame);
    SWALLOW.forEach(ev => root.addEventListener(ev, swallow));
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('pointerdown', e => { downOnBackdrop = e.target === root; });
    root.addEventListener('click', e => {
      if (e.target === root) { if (downOnBackdrop) close(true, 'dismiss'); return; }
      const b = e.target.closest && e.target.closest('button[data-a]');
      if (b && sheet.contains(b)) act(b);
    });
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('resize', onResize);
    doc.body.appendChild(root);
    sig = null;
    render(true);
    sheet.focus({ preventScroll: true });
    ensureTimer();
  }

  function close(restoreFocus, why) {
    if (!root) return;
    const hook = onCloseHook;
    onCloseHook = null;
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('resize', onResize);
    if (root.parentNode) root.parentNode.removeChild(root);
    root = frame = arrow = sheet = body = null;
    anchorFn = null; lastSlides = null; lastAnchor = '';
    ctl.setTapped(null);
    ctl.closePicker();
    if (restoreFocus && returnTo && returnTo !== doc.body && returnTo.isConnected && returnTo.focus) returnTo.focus({ preventScroll: true });
    returnTo = null;
    if (hook) { try { hook(why || 'api'); } catch (e) { /* the opener's hook must not break the close */ } }
  }

  const api = {
    openFrom: cfg.openFrom,
    config: cfg,
    open,
    close: () => close(false, 'api'),
    coverRight,
    isOpen: () => !!root,
    /** Where the card is: { placement, rect, arrow } (debug and tests). */
    current: () => (root ? { placement: frame.dataset.placement, rect: frame.getBoundingClientRect().toJSON(),
      arrow: arrow.style.display === 'none' ? null : arrow.className.replace('sm-arrow', '').trim() } : null),
    refresh: () => render(false),
    /** Debug: what was sent (or applied to the sample), and the current model. */
    _sent: () => ctl.sent(),
    _model: () => model(),
    dispose() {
      close(false, 'dispose');
      clearInterval(timer); timer = 0;
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      if (o.debug && win.__home3dSound === api) delete win.__home3dSound;
    },
  };
  if (o.debug) win.__home3dSound = api;
  return api;
}
