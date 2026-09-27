/**
 * tap-popovers.js -- tap a 3D object, get a compact popover controlling the
 * Home Assistant entity bound to it. SPIKE (docs/plans/tap-popovers.md).
 *
 * The sidebar stays the primary control surface; this is an additional,
 * direct-manipulation path. It READS the sidebar's own state (index.html's
 * doorStatus / climateReading / curtainAvailableState maps, home.lightState)
 * and WRITES through the sidebar's own send paths (sendToHA, and the shared
 * createDragSender instances for curtains and climate), so the two can never
 * disagree about what was sent or double-send.
 *
 * THE MAPPING IS DERIVED, NOT HAND-WRITTEN. A target is recognised from what
 * the scene already tags on its meshes, and bound through rooms.json:
 *
 *   light    mesh.userData.{roomId, lightChannel}  -> rooms[roomId][channel]
 *   curtain  ancestor group named 'curtain:<id>'   -> sensors.curtains[id]
 *   door     ancestor userData.doorProfileId       -> sensors.doors[id]
 *   climate  (room)                                -> sensors.climate[room]
 *
 * Climate is keyed by ROOM (rooms.json 1.3, the sidebar's binding). Nothing on
 * main can be tapped for it yet: furniture renders merged into shared buckets,
 * so a radiator mesh carries no identity -- see the plan. It opens through the
 * ?debug=1 seam (__home3dTap.openAt('climate', roomId, x, y)).
 *
 * OCCLUSION: nearest drawn, non-see-through hit wins. A faded exterior wall
 * (opacity 0.05), the ceiling seen from above (0), the room click-catchers (0)
 * and window glass (0.28) are see-through; a solid wall, a door frame or
 * furniture in front of a light BLOCKS the tap.
 *
 * The pure parts (materialOpacity, resolveTarget, pickFromHits,
 * placePopover, boundsExcluding, statusKey, doorState, curtainUnavailable,
 * lightUnavailable, hitOverlapPx, climateActivity, lightName) take no DOM and
 * are unit-tested in scripts/test-tap-popovers.mjs.
 */

import { ICONS, svgIcon } from './ui-icons.js';
import { isColorChannel, supportsColor, swatchColor } from './light-color.js';

export const OPACITY_SOLID = 0.35;   // below this a mesh is see-through for picking
export const TAP_SLOP_PX = 5;        // same rule as the scene's own room click
export const FUZZ_PX = 24;           // finger tolerance for tiny light fixtures
export const ARROW_INSET = 14;       // arrow never closer than this to a corner

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Effective opacity of the material a hit landed on (0 = not drawn). */
export function materialOpacity(material, materialIndex) {
  const m = Array.isArray(material) ? (material[materialIndex || 0] || material[0]) : material;
  if (!m) return 0;
  if (m.visible === false || m.colorWrite === false) return 0;
  return m.transparent ? m.opacity : 1;
}

/** True when the object and every ancestor are visible. */
export function isDrawn(obj) {
  for (let o = obj; o; o = o.parent) if (o.visible === false) return false;
  return true;
}

/**
 * Walk up from a hit mesh to the first thing that identifies a controllable
 * object. Returns a target when that object is BOUND in rooms.json, or null
 * (an unbound door is still a solid door -- the caller treats null as "not a
 * target", i.e. an occluder if opaque).
 *
 * @param bindings  { lights: rooms, curtains, doors } from rooms.json
 */
export function resolveTarget(obj, bindings) {
  const b = bindings || {};
  for (let o = obj; o; o = o.parent) {
    const u = o.userData || {};
    if (u.lightChannel && u.roomId) {
      const ents = ((b.lights || {})[u.roomId] || {})[u.lightChannel];
      return Array.isArray(ents) && ents.length
        ? { kind: 'light', id: u.roomId + '/' + u.lightChannel, roomId: u.roomId, channel: u.lightChannel, entities: ents, object: o }
        : null;
    }
    if (u.doorProfileId !== undefined) {
      const ents = u.doorProfileId ? (b.doors || {})[u.doorProfileId] : null;
      return Array.isArray(ents) && ents.length
        ? { kind: 'door', id: u.doorProfileId, entities: ents, object: o }
        : null;
    }
    if (typeof o.name === 'string' && o.name.indexOf('curtain:') === 0) {
      const id = o.name.slice('curtain:'.length);
      const ents = (b.curtains || {})[id];
      return Array.isArray(ents) && ents.length
        ? { kind: 'curtain', id, entities: ents, object: o }
        : null;
    }
  }
  return null;
}

/**
 * Decide a tap from raycast hits (sorted nearest-first). Returns
 * { target, hit } for a target, { target:null, hit } when the first solid
 * thing is not a target (OCCLUDED), or { target:null, hit:null }.
 */
export function pickFromHits(hits, bindings) {
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const o = h.object;
    if (!o || !(o.isMesh)) continue;
    if (!isDrawn(o)) continue;
    const t = resolveTarget(o, bindings);
    if (t) return { target: t, hit: h };
    if (materialOpacity(o.material, h.face ? h.face.materialIndex : 0) < OPACITY_SOLID) continue;
    return { target: null, hit: h };
  }
  return { target: null, hit: null };
}

/**
 * Where to put a w x h popover for a tap at (x, y), inside `bounds`
 * ({left, top, right, bottom}). Boundary-aware, in this order:
 *   1. ABOVE the tap (a finger covers what is below it);
 *   2. BELOW it;
 *   3. to the RIGHT or LEFT of it, whichever has room (the larger if both) --
 *      the case a short landscape phone viewport hits, where neither above
 *      nor below fits and the old clamp put the card over the finger;
 *   4. only then clamped inside the bounds ('clamped', no arrow).
 * The arrow points at the tap from whichever side the card is on; its
 * offset is along that edge, kept ARROW_INSET from the corners.
 *
 * @returns {{left, top, placement, arrow: null | {side, offset}}}
 */
export function placePopover(x, y, w, h, bounds, gap, margin) {
  const g = gap == null ? 12 : gap;
  const m = margin == null ? 8 : margin;
  const minL = bounds.left + m, maxL = bounds.right - m - w;
  const minT = bounds.top + m, maxT = bounds.bottom - m - h;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const along = (pos, size) => clamp(pos, ARROW_INSET, Math.max(ARROW_INSET, size - ARROW_INSET));
  const out = (left, top, placement, side) => {
    left = Math.round(left); top = Math.round(top);
    const arrow = side === 'bottom' || side === 'top'
      ? { side, offset: Math.round(along(x - left, w)) }
      : side ? { side, offset: Math.round(along(y - top, h)) } : null;
    return { left, top, placement, arrow };
  };
  const hLeft = clamp(x - w / 2, minL, Math.max(minL, maxL));
  if (y - g - h >= minT) return out(hLeft, y - g - h, 'above', 'bottom');
  if (y + g + h <= bounds.bottom - m) return out(hLeft, y + g, 'below', 'top');
  const roomRight = bounds.right - m - (x + g);   // space for the card right of the tap
  const roomLeft = (x - g) - (bounds.left + m);
  const vTop = clamp(y - h / 2, minT, Math.max(minT, maxT));
  const fitsR = roomRight >= w, fitsL = roomLeft >= w;
  if (fitsR && (!fitsL || roomRight >= roomLeft)) return out(x + g, vTop, 'right', 'left');
  if (fitsL) return out(x - g - w, vTop, 'left', 'right');
  return out(clamp(x - w / 2, minL, Math.max(minL, maxL)), clamp(y - g - h, minT, Math.max(minT, maxT)), 'clamped', null);
}

/**
 * Is the HA client reaching Home Assistant at all? 'connected' and 'syncing'
 * (socket open, snapshot in flight) are. This drives what the card SAYS about
 * an entity (unavailable vs unknown); whether its controls work is
 * haOfflineConn() below. There is no 'polling' mode any more: since #58 the
 * client is WebSocket-only and never sets it.
 */
export function isLive(conn) {
  return conn === 'connected' || conn === 'syncing';
}

/**
 * A CONFIGURED Home Assistant that is not fully connected -- disconnected,
 * syncing, auth or sync failed. Every control is then disabled and does
 * nothing: no command and no preview on the model, the sidebar's rule
 * (haOffline in src/room-panel.js). `conn` null means there is no client at
 * all (HA not configured -- the demo house), which is NOT offline: there the
 * controls stay a local preview on the model.
 */
export function haOfflineConn(conn) {
  return conn != null && conn !== 'connected';
}

/**
 * The status dot for one popover:
 *   ok          green   HA connected, entity reporting
 *   connecting  yellow  syncing: the socket is up, snapshot pending (pulses);
 *                       controls disabled until it lands
 *   na          yellow  connected, but this entity is unavailable/unknown
 *   motor       yellow  connected, but a curtain motor is unavailable
 *   haOffline   red     a configured HA is disconnected / auth or sync failed;
 *                       controls disabled
 *   offline     red     no client at all (demo): changes only preview
 *   offlineMock red     no client, showing sample values (climate)
 *
 * Syncing outranks an entity-unavailable flag: until the first snapshot
 * lands, "this device isn't responding" would be a claim nothing supports.
 *
 * @param conn    HA client status string, or null when there is no client
 * @param entityUnavailable  true when HA is live but this entity is not
 */
export function statusKey(kind, conn, entityUnavailable, mock) {
  if (conn == null) return mock ? 'offlineMock' : 'offline';
  if (conn === 'syncing') return 'connecting';
  if (conn !== 'connected') return 'haOffline';
  if (entityUnavailable) return kind === 'curtain' ? 'motor' : 'na';
  return 'ok';
}

/**
 * The door chip's body, from the sidebar's doorStatus value ('on' | 'off' |
 * 'unavailable' | null = never heard from) and the connection:
 *   open / closed  the last reading, live or not (last-known while offline)
 *   na             "Unavailable": the sensor itself reported unavailable, or
 *                  HA is live and the door has never reported
 *   unknown        "Unknown": HA is offline and the door has never reported --
 *                  nothing says the sensor is broken, we just have no reading
 */
export function doorState(status, conn) {
  if (status === 'on') return 'open';
  if (status === 'off') return 'closed';
  if (status === 'unavailable') return 'na';
  return isLive(conn) ? 'na' : 'unknown';
}

/**
 * A curtain's controls are hidden ("Motor unavailable") whenever HA is live
 * and the sidebar's availability map does not say TRUE -- in every live mode,
 * the same rule the sidebar slider and curtainSliderCommand apply. Offline,
 * the controls stay as a preview on the model.
 */
export function curtainUnavailable(conn, available) {
  return isLive(conn) && available !== true;
}

/**
 * A light is unavailable when HA is live and its first bound entity's raw
 * state is missing, 'unavailable' or 'unknown'.
 */
export function lightUnavailable(conn, rawState) {
  return isLive(conn) && (!rawState || isUnavailableState(rawState.state));
}
export const isUnavailableState = st => !st || st === 'unavailable' || st === 'unknown';

/**
 * Placement bounds with the sidebar taken OUT: the visible scene area
 * (`bounds`) minus the open sidebar's rect. The sidebar is an opaque panel
 * over the canvas, so a card placed under it is hidden (or, above it in
 * z-order, covers the controls). Returns the strip of `bounds` left of,
 * right of, above or below the sidebar that CONTAINS the tap (x, y); if the
 * tap is in none of them, the largest strip. A sidebar that does not overlap
 * `bounds` (closed: translated off-screen) changes nothing.
 *
 * @param sidebar  {left, top, right, bottom} or null
 */
export function boundsExcluding(bounds, sidebar, x, y) {
  const b = bounds;
  if (!sidebar) return b;
  const ix = Math.min(b.right, sidebar.right) - Math.max(b.left, sidebar.left);
  const iy = Math.min(b.bottom, sidebar.bottom) - Math.max(b.top, sidebar.top);
  if (ix <= 0 || iy <= 0) return b;
  const strips = [
    { left: b.left, top: b.top, right: Math.min(b.right, sidebar.left), bottom: b.bottom },
    { left: Math.max(b.left, sidebar.right), top: b.top, right: b.right, bottom: b.bottom },
    { left: b.left, top: b.top, right: b.right, bottom: Math.min(b.bottom, sidebar.top) },
    { left: b.left, top: Math.max(b.top, sidebar.bottom), right: b.right, bottom: b.bottom },
  ].filter(r => r.right > r.left && r.bottom > r.top);
  if (!strips.length) return b;   // sidebar covers everything: last resort, stay on top of it
  const inside = strips.filter(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  const area = r => (r.right - r.left) * (r.bottom - r.top);
  return (inside.length ? inside : strips).sort((p, q) => area(q) - area(p))[0];
}

/**
 * Is a radiator firing? From `hvac_action` (heating / idle / off), NEVER from
 * the entity's `state` -- state is the MODE ('heat' means "set to heat", not
 * "heating now"). A thermostat at target reads state 'heat', hvac_action
 * 'idle'. Returns 'heating' | 'idle' | 'off' | null (not reported).
 */
export function climateActivity(hvacAction, off) {
  if (off) return 'off';
  if (hvacAction === 'heating' || hvacAction === 'preheating') return 'heating';
  if (hvacAction === 'off') return 'off';
  if (typeof hvacAction === 'string' && hvacAction) return 'idle';
  return null;
}

/**
 * A light's popover name. Always carries the room, since the popover no
 * longer has a room subtitle: "Hall ceiling" stays as is, a bare channel
 * becomes "{Room} light", and a label lacking the room gets it prefixed
 * ("Cove" -> "Lounge cove"). Sentence case: Capitalised words after the
 * first are lowered, ALL-CAPS words (TV, LED) are kept.
 *
 * The prefix never repeats a word the label already starts with: a label
 * that begins with the END of the room name overlaps it rather than being
 * glued on after it ("Home office" + "Office ambience" -> "Home office
 * ambience", not "Home office office ambience").
 */
export function lightName(roomName, channel, label) {
  const room = String(roomName || '').trim();
  let base = String(label || '').trim();
  if (!base || base.toLowerCase() === room.toLowerCase()) {
    base = channel === 'main' ? 'light' : channel === 'ambient' ? 'ambient light' : String(channel || 'light');
  }
  return sentenceCase(room ? joinRoomName(room, base) : base);
}

/**
 * Prefix `room` to `label` unless the label already names the room, merging
 * the longest run of words that ends the room name and starts the label.
 * Case-insensitive; whole words only ("Hall" does not overlap "Hallway").
 */
export function joinRoomName(room, label) {
  const r = String(room || '').trim(), l = String(label || '').trim();
  if (!r) return l;
  if (!l) return r;
  const rw = r.split(/\s+/), lw = l.split(/\s+/);
  const low = a => a.map(w => w.toLowerCase());
  const rl = low(rw), ll = low(lw);
  // Already contains the whole room name as consecutive words: keep as is.
  for (let i = 0; i + rl.length <= ll.length; i++) {
    if (rl.every((w, k) => ll[i + k] === w)) return l;
  }
  for (let n = Math.min(rl.length, ll.length); n > 0; n--) {
    const tail = rl.slice(rl.length - n), head = ll.slice(0, n);
    if (tail.every((w, k) => w === head[k])) return rw.concat(lw.slice(n)).join(' ');
  }
  return r + ' ' + l;
}

/**
 * The popover title's marquee, decided from measured widths (CSS px):
 *   fit     the name fits: it does not move
 *   wrap    it overflows and the user prefers reduced motion: wrap to two
 *           lines instead of scrolling
 *   scroll  it overflows: pause, slide left by `distance` to reveal the
 *           end, pause, slide back, repeat. `duration` is one full cycle
 *           (ms); `offsets` are the Web Animations keyframe offsets of
 *           [start, end of first pause, end of slide, end of second pause,
 *           back home].
 * A 1px tolerance absorbs sub-pixel rounding so a name that just fits
 * never twitches.
 */
export function marqueePlan(textW, boxW, opts) {
  const o = opts || {};
  const pause = o.pauseMs == null ? 1500 : o.pauseMs;
  const speed = o.pxPerSec == null ? 30 : o.pxPerSec;
  const over = Math.ceil((+textW || 0) - (+boxW || 0));
  if (!(over > 1)) return { mode: 'fit', distance: 0 };
  if (o.reducedMotion) return { mode: 'wrap', distance: 0 };
  const slide = Math.max(400, Math.round(over / speed * 1000));
  const duration = 2 * pause + 2 * slide;
  const r = v => Math.round(v / duration * 1e4) / 1e4;
  return { mode: 'scroll', distance: over, duration,
    offsets: [0, r(pause), r(pause + slide), r(2 * pause + slide), 1] };
}

/** "Living Room Radiator" -> "Living room radiator"; ALL-CAPS words kept. */
export function sentenceCase(text) {
  return String(text || '').trim().split(/\s+/).map((wd, i) => {
    if (i === 0) return wd.charAt(0).toUpperCase() + wd.slice(1);
    return /^[A-Z][a-z]/.test(wd) ? wd.charAt(0).toLowerCase() + wd.slice(1) : wd;
  }).join(' ');
}

// ---------------------------------------------------------------------------
// Runtime (browser)
// ---------------------------------------------------------------------------

// MDI icon paths: shared with the sidebar (src/ui-icons.js).
const I = ICONS;
const svg = svgIcon;
const ico = (p, cls) => svg(p, 'tp-ico ' + (cls || ''));

const STATUS = {
  ok: ['ok', 'Live', 'Connected to Home Assistant.'],
  connecting: ['warn pulse', 'Connecting…', 'Syncing with Home Assistant. Controls are disabled until it finishes.'],
  na: ['warn', 'Entity unavailable', 'Home Assistant is reachable, but this device isn’t responding.'],
  motor: ['warn', 'Motor unavailable', 'One of this curtain’s motors isn’t responding in Home Assistant.'],
  haOffline: ['bad', 'HA offline', 'Home Assistant is not connected. Controls are disabled until it reconnects.'],
  offline: ['bad', 'Not connected', 'No Home Assistant configured. Changes only preview on the model.'],
  offlineMock: ['bad', 'Not connected', 'No Home Assistant configured. Showing sample temperatures; changes only preview.'],
};

/**
 * Control-row geometry (CSS px) for the two pointer sizes. The buttons'
 * and switch's invisible ::after hit areas reach BELOW the row; the slider
 * starts `rangeGap` below the row. They may touch, never overlap -- a tap
 * meant for the slider's top edge must not press Close/Open (or toggle the
 * light). `hitOverlapPx` checks that; the CSS below is built from these.
 *   ibH / swH       button / switch height (the row is ibH tall, the switch
 *                   is centred in it)
 *   ibHitY / swHitY how far each ::after extends below its control
 *   rangeGap        the slider's margin-top below the row
 */
export const GEOM = {
  fine:   { ibH: 28, ibHitY: 4, swH: 20, swHitY: 12, rangeGap: 8, rangeH: 20 },
  coarse: { ibH: 34, ibHitY: 5, swH: 24, swHitY: 10, rangeGap: 5, rangeH: 40 },
};
/** Pixels by which a control's hit area overlaps the slider below (<= 0: none). */
export function hitOverlapPx(g) {
  const ib = g.ibHitY;                          // below the row's bottom edge
  const sw = g.swHitY - (g.ibH - g.swH) / 2;    // switch is centred in the row
  return Math.max(ib, sw) - g.rangeGap;
}

// Sizes as CSS variables; the coarse set is emitted twice -- under
// (pointer: coarse), and under .tp-force-coarse for the ?debug=1 seam, since
// a desktop browser cannot be made to report a coarse pointer.
const GC = GEOM.coarse, GF = GEOM.fine;
const MARQ_PAD = 6;   // px the marquee's fade reaches past the title box
const COARSE = '--w:216px;--ib-w:38px;--ib-h:' + GC.ibH + 'px;--sw-w:40px;--sw-h:' + GC.swH + 'px;--thumb:20px;';
const coarseRules = sel => `
${sel} .tp-pop { ${COARSE} }
${sel} .tp-status::after { inset: -14px; }
${sel} .tp-btns { gap: 6px; }
${sel} .tp-ib::after { inset: -${GC.ibHitY}px -3px; }
${sel} .tp-sw::after { inset: -${GC.swHitY}px -2px; }
${sel} .tp-range { height: ${GC.rangeH}px; margin: ${GC.rangeGap}px 0 ${-(GC.rangeGap + 10)}px; }
${sel} .tp-crow { gap: 12px; margin: ${GC.rangeGap}px 0 ${-(GC.rangeGap + 10)}px; }
${sel} .tp-crow .tp-range { margin: 0; }
${sel} .tp-color { --sq: 20px; --pad: 12px; }
${sel} .tp-pop.chip { padding: 10px 12px; }`;

const STYLE = `
.tp-pop { --w:200px; --ib-w:30px; --ib-h:${GF.ibH}px; --sw-w:36px; --sw-h:${GF.swH}px; --thumb:14px;
  --ink:#fff; --ink-2:rgba(255,255,255,0.62); --accent:#6366f1; --ok:#22c55e; --warn:#eab308; --bad:#ef4444;
  --amber:#ffd43b; --heat:#ff8a3d; --door-open:#f59e0b;
  position: fixed; z-index: 60; width: var(--w); padding: 10px 12px; border-radius: 10px;
  background: rgba(10,10,20,0.94); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,0.10); box-shadow: 0 6px 20px rgba(0,0,0,0.45);
  color: var(--ink); font: 12px/1.3 'Segoe UI', system-ui, sans-serif; touch-action: manipulation; box-sizing: border-box; }
.tp-pop *, .tp-pop *::before, .tp-pop *::after { box-sizing: border-box; }
.tp-pop:focus { outline: none; }   /* the card itself holds focus only as a fallback; its controls show rings */
.tp-arrow { position: absolute; width: 11px; height: 11px; background: rgb(10,10,20); border: 0 solid rgba(255,255,255,0.10); }
.tp-arrow.bottom { bottom: -6px; transform: translateX(-50%) rotate(45deg); border-right-width: 1px; border-bottom-width: 1px; }
.tp-arrow.top { top: -6px; transform: translateX(-50%) rotate(45deg); border-left-width: 1px; border-top-width: 1px; }
.tp-arrow.left { left: -6px; transform: translateY(-50%) rotate(45deg); border-left-width: 1px; border-bottom-width: 1px; }
.tp-arrow.right { right: -6px; transform: translateY(-50%) rotate(45deg); border-right-width: 1px; border-top-width: 1px; }
.tp-head { display: flex; align-items: center; gap: 7px; min-height: 20px; }
.tp-ico { width: 16px; height: 16px; flex: none; fill: rgba(255,255,255,0.72); }
.tp-ico.light-on { fill: var(--amber); filter: drop-shadow(0 0 4px rgba(255,212,59,0.55)); }
.tp-ico.heat { fill: var(--heat); filter: drop-shadow(0 0 4px rgba(255,138,61,0.5)); }
.tp-ico.d-open { fill: var(--door-open); }
.tp-ico.d-closed { fill: var(--ok); }
.tp-ico.dim { fill: rgba(255,255,255,0.4); }
.tp-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; }
.tp-name-in { display: inline-block; white-space: nowrap; will-change: transform; }
/* Overflowing title (see fitTitle): the box reaches ${MARQ_PAD}px into the gaps on
   either side so the edge fades fall on empty space while the text is at
   rest, and on the text only as it slides through. Never an ellipsis. */
.tp-name.marq { margin: 0 -${MARQ_PAD}px; padding: 0 ${MARQ_PAD}px;
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 ${MARQ_PAD}px, #000 calc(100% - ${MARQ_PAD}px), transparent 100%);
  mask-image: linear-gradient(to right, transparent 0, #000 ${MARQ_PAD}px, #000 calc(100% - ${MARQ_PAD}px), transparent 100%); }
/* Reduced motion: no marquee -- wrap onto a second line instead. */
.tp-name.wrap { white-space: normal; line-height: 1.25; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.tp-name.wrap .tp-name-in { display: inline; white-space: normal; }
.tp-status { position: relative; flex: none; width: 16px; height: 16px; margin-right: -4px; display: grid; place-items: center;
  border: 0; background: none; cursor: help; padding: 0; }
.tp-status::after { content: ''; position: absolute; inset: -8px; border-radius: 50%; }
.tp-status i { width: 8px; height: 8px; border-radius: 50%; display: block; }
.tp-status.ok i { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.tp-status.warn i { background: var(--warn); box-shadow: 0 0 6px var(--warn); }
.tp-status.bad i { background: var(--bad); box-shadow: 0 0 6px var(--bad); }
.tp-status.warn.pulse i { animation: tp-pulse 1.2s ease-in-out infinite; }
@keyframes tp-pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .tp-status.warn.pulse i { animation: none; } }
.tp-tip { position: absolute; top: calc(100% + 8px); right: -6px; z-index: 5; width: max-content; max-width: 200px;
  padding: 6px 9px; border-radius: 7px; background: #1d1d2e; border: 1px solid rgba(255,255,255,0.16);
  box-shadow: 0 4px 14px rgba(0,0,0,0.5); font-size: 12px; line-height: 1.35; color: #fff; text-align: left;
  font-weight: 400; pointer-events: none; opacity: 0; transform: translateY(-2px); transition: opacity .12s, transform .12s; }
.tp-tip b { font-weight: 600; }
.tp-tip small { display: block; color: var(--ink-2); font-size: 12px; margin-top: 2px; }
@media (hover: hover) { .tp-status:hover .tp-tip { opacity: 1; transform: none; transition-delay: .15s; } }
.tp-status:focus-visible .tp-tip, .tp-status.tip-open .tp-tip { opacity: 1; transform: none; }
.tp-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; min-height: var(--ib-h); }
.tp-val { font-size: 12px; color: var(--ink-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.tp-val b { font-size: 13px; font-weight: 600; color: var(--ink); }
.tp-val.muted b { color: var(--ink-2); }
.tp-temp { display: flex; align-items: center; gap: 7px; min-width: 0; }
.tp-temp small { display: flex; flex-direction: column; font-size: 12px; line-height: 1.2; color: var(--ink-2); white-space: nowrap; }
.tp-temp small .heat { color: var(--heat); }
.tp-val .big { font-size: 18px; font-weight: 600; color: var(--ink); letter-spacing: -0.01em; }
.tp-btns { display: flex; gap: 4px; flex: none; }
.tp-ib { position: relative; width: var(--ib-w); height: var(--ib-h); border-radius: 7px; display: grid; place-items: center;
  border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.07); color: #fff; cursor: pointer; padding: 0; }
.tp-ib svg { width: 18px; height: 18px; fill: currentColor; }
.tp-ib::after { content: ''; position: absolute; inset: -${GF.ibHitY}px -2px; }
.tp-ib:active:not(:disabled) { background: rgba(99,102,241,0.35); }
.tp-ib:disabled { opacity: 0.35; cursor: not-allowed; }
@media (hover: hover) {
  .tp-ib:hover:not(:disabled) { background: rgba(255,255,255,0.14); }
  .tp-ib[data-tip]:hover::before { content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    white-space: nowrap; padding: 4px 7px; border-radius: 6px; background: #1d1d2e; border: 1px solid rgba(255,255,255,0.16); font-size: 12px; z-index: 5; }
}
.tp-ib:focus-visible, .tp-sw:focus-visible, .tp-status:focus-visible, .tp-range:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
/* Opened by a tap: focus is placed on the first control for keyboard users,
   but Chrome paints a script-moved focus as :focus-visible even after a
   pointer tap. No ring until a key is pressed inside the card. */
.tp-pop.tp-ptr :focus-visible { outline: none; }
.tp-sw { position: relative; width: var(--sw-w); height: var(--sw-h); border-radius: 999px; border: 0; padding: 0; cursor: pointer;
  background: rgba(255,255,255,0.18); flex: none; transition: background .2s; }
.tp-sw::after { content: ''; position: absolute; inset: -${GF.swHitY}px -4px; }
.tp-sw i { position: absolute; top: 2px; left: 2px; width: calc(var(--sw-h) - 4px); height: calc(var(--sw-h) - 4px); border-radius: 50%; background: #fff; transition: left .2s; }
.tp-sw.on { background: var(--accent); }
.tp-sw.on i { left: calc(var(--sw-w) - var(--sw-h) + 2px); }
.tp-sw:disabled { opacity: 0.35; cursor: not-allowed; }
.tp-range:disabled { opacity: 0.35; cursor: not-allowed; }
.tp-offline { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11px; color: #fecaca; }
.tp-offline::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: #ef4444; }
.tp-range { --p: 50%; display: block; width: 100%; height: ${GF.rangeH}px; margin: ${GF.rangeGap}px 0 -2px; background: transparent;
  -webkit-appearance: none; appearance: none; cursor: pointer; outline: none; }
.tp-range::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
  background: linear-gradient(to right, var(--fill, var(--accent)) var(--p), rgba(255,255,255,0.16) var(--p)); }
.tp-range::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.16); }
.tp-range::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--fill, var(--accent)); }
.tp-range::-webkit-slider-thumb { -webkit-appearance: none; width: var(--thumb); height: var(--thumb); border-radius: 50%;
  background: #fff; margin-top: calc(2px - var(--thumb) / 2); box-shadow: 0 1px 4px rgba(0,0,0,0.5); }
.tp-range::-moz-range-thumb { width: var(--thumb); height: var(--thumb); border-radius: 50%; background: #fff; border: 0; }
.tp-range.temp { --fill: var(--heat); }
/* Accent light: colour square inline with the brightness slider. The input's
   box is the hit area; its padding insets the visible swatch, and matching
   negative margins keep the layout at the swatch's size. */
.tp-crow { display: flex; align-items: center; gap: 8px; margin: ${GF.rangeGap}px 0 -2px; }
.tp-crow .tp-range { flex: 1 1 auto; width: auto; min-width: 0; margin: 0; }
.tp-color { --sq: 18px; --pad: 4px; flex: none; width: calc(var(--sq) + 2 * var(--pad)); height: calc(var(--sq) + 2 * var(--pad));
  margin: calc(-1 * var(--pad)); padding: 0; border: 0; background: none; cursor: pointer; -webkit-appearance: none; appearance: none; }
.tp-color::-webkit-color-swatch-wrapper { padding: var(--pad); }
.tp-color::-webkit-color-swatch { border: 1px solid rgba(255,255,255,0.35); border-radius: 5px; }
.tp-color::-moz-color-swatch { border: 1px solid rgba(255,255,255,0.35); border-radius: 5px; }
.tp-color:disabled { opacity: 0.35; cursor: not-allowed; }
.tp-color:focus-visible { outline: 2px solid #a5b4fc; outline-offset: -2px; }
.tp-range.off { --fill: rgba(255,255,255,0.4); }
.tp-pop.chip { width: auto; max-width: 240px; padding: 8px 10px; border-radius: 999px; }
.tp-pop.chip .tp-name { flex: 0 1 auto; }
.tp-pop.chip .sep { color: var(--ink-2); }
.tp-pop.chip .st { font-weight: 600; white-space: nowrap; }
.tp-pop.chip .st.open { color: var(--door-open); }
.tp-pop.chip .st.closed { color: #4ade80; }
.tp-pop.chip .st.na, .tp-pop.chip .st.unknown { color: var(--ink-2); font-weight: 500; }
.tp-pop.chip .tp-status { margin-left: 2px; margin-right: 0; }
@media (pointer: coarse) { ${coarseRules('')} }
${coarseRules('.tp-force-coarse')}
`;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fillPct = r => ((+r.value - +r.min) / ((+r.max - +r.min) || 1) * 100) + '%';

// ---- Popover markup (pure: model in, HTML out) -----------------------------
// Module-level so scripts/test-ha-resync.mjs can render each card for a
// given model and check which controls are disabled. `dot` renders the
// status dot (it reads the card's tooltip state, so the caller supplies it).
const offlineLine = m => (m.haOff ? '<div class="tp-offline" data-offline>HA offline</div>' : '');
// The title sits in two spans: .tp-name clips (and fades its edges while it
// scrolls), .tp-name-in is what the marquee moves (see fitTitle).
const nameHtml = name => '<span class="tp-name"><span class="tp-name-in">' + esc(name) + '</span></span>';
const shellWith = dot => (icon, name, st, body) =>
  '<div class="tp-head">' + icon + nameHtml(name) + dot(st) + '</div>' + body;
export const popoverHtml = {
  light(m, dot) {
    const shell = shellWith(dot);
    const on = m.on && !m.na;
    const val = m.na ? '<span class="tp-val muted"><b>Unavailable</b></span>'
      : '<span class="tp-val" data-v><b>' + (m.on ? 'On' : 'Off') + '</b>' + (m.on ? ' · ' + m.bri + '%' : '') + '</span>';
    const range = '<input class="tp-range' + (m.on ? '' : ' off') + '" data-a="bri" type="range" min="5" max="100" value="' +
      m.bri + '" aria-label="Brightness"' + (m.haOff ? ' disabled' : '') + '>';
    // Accent channels: the colour square sits inline, left of the slider.
    const colour = m.colorable
      ? '<input class="tp-color" data-a="color" type="color" value="' + esc(swatchColor(m.color)) +
        '" aria-label="Colour" title="Colour"' + (m.haOff ? ' disabled' : '') + '>'
      : '';
    return shell(ico(on ? I.bulb : I.bulbOff, on ? 'light-on' : (m.na ? 'dim' : '')), m.name, m.status,
      '<div class="tp-row">' + val + '<button class="tp-sw' + (m.on ? ' on' : '') + '" data-a="power" role="switch" aria-checked="' +
      m.on + '" aria-label="Power"' + (m.na || m.haOff ? ' disabled' : '') + '><i></i></button></div>' +
      (m.na ? '' : colour ? '<div class="tp-crow">' + colour + range + '</div>' : range) + offlineLine(m));
  },
  curtain(m, dot) {
    const shell = shellWith(dot);
    const dis = m.na || m.haOff ? ' disabled' : '';
    const val = m.na ? '<span class="tp-val muted"><b>Motor unavailable</b></span>'
      : '<span class="tp-val" data-v>Open <b>' + m.pct + '%</b></span>';
    return shell(ico(m.pct > 0 ? I.curtains : I.curtainsClosed, m.na ? 'dim' : ''), m.name, m.status,
      '<div class="tp-row">' + val + '<span class="tp-btns">' +
      '<button class="tp-ib" data-a="close" data-tip="Close" aria-label="Close curtain"' + dis + '>' + svg(I.cClose) + '</button>' +
      '<button class="tp-ib" data-a="open" data-tip="Open" aria-label="Open curtain"' + dis + '>' + svg(I.cOpen) + '</button>' +
      '</span></div>' +
      (m.na ? '' : '<input class="tp-range" data-a="pos" type="range" min="0" max="100" value="' + m.pct + '" aria-label="Open percentage"' + dis + '>') +
      offlineLine(m));
  },
  climate(m, dot) {
    const shell = shellWith(dot);
    const f = v => (typeof v === 'number' && isFinite(v) ? v.toFixed(1) + '°' : '–');
    const live = !m.na && !m.off && typeof m.target === 'number';
    const dis = m.haOff ? ' disabled' : '';
    const icon = m.na ? ico(I.radiatorIdle, 'dim') : ico(I.radiator, m.activity === 'heating' ? 'heat' : '');
    const act = m.activity === 'heating' ? '<span class="heat">heating</span>' : m.activity ? '<span>' + m.activity + '</span>' : '';
    const val = m.na ? '<span class="tp-val muted"><b>Unavailable</b></span>'
      : m.off ? '<span class="tp-val tp-temp"><span class="big">Off</span><small><span>now ' + f(m.current) + '</span></small></span>'
      : '<span class="tp-val tp-temp" data-v><span class="big" data-t>' + f(m.target) + '</span><small><span>now ' + f(m.current) + '</span>' + act + '</small></span>';
    return shell(icon, m.name, m.status,
      '<div class="tp-row">' + val + (live ? '<span class="tp-btns">' +
        '<button class="tp-ib" data-a="down" data-tip="−' + m.step + '°" aria-label="Lower target"' + dis + '>' + svg(I.minus) + '</button>' +
        '<button class="tp-ib" data-a="up" data-tip="+' + m.step + '°" aria-label="Raise target"' + dis + '>' + svg(I.plus) + '</button></span>' : '') +
      '</div>' +
      (live ? '<input class="tp-range temp" data-a="set" type="range" min="' + m.min + '" max="' + m.max + '" step="' + m.step +
        '" value="' + m.target + '" aria-label="Target temperature"' + dis + '>' : '') + offlineLine(m));
  },
};

/**
 * Attach the popover layer.
 *
 * @param {Object} o
 * @param o.THREE, o.home, o.container, o.Home3DScene, o.house, o.HAClient
 * @param o.rooms           rooms.json `rooms` (room -> channel -> entities)
 * @param o.sensors         rooms.json `sensors`
 * @param o.getHa           () => HAClient instance or null
 * @param o.sendLight       (roomId, channel, state, debounceMs, withColor) -- index.html's sendToHA
 * @param o.onObjectTap     (target) => void -- called when a tap lands on a
 *                          target, BEFORE its card opens (the page closes an
 *                          unpinned sidebar here; the card still opens)
 * @param o.state           accessors onto the sidebar's own maps:
 *   doorStatus(id) 'on'|'off'|'unavailable'|null, curtainAvailable(id) bool|null,
 *   curtainPct(id), curtainLocal(id, pct), climate(roomId) parseClimate reading|null,
 *   climateEntity(roomId)
 * @param o.curtainSender, o.climateSender  the sidebar's createDragSender instances
 * @param o.onChange        () => void -- repaint the sidebar
 * @param o.sidebar         the room panel element (read-only): its on-screen
 *                          rect is kept out of placement bounds, and toggling
 *                          its 'open' class closes the card
 * @param o.debug           expose window.__home3dTap (removed again on dispose)
 */
export function attachTapPopovers(o) {
  const { THREE, home, container, Home3DScene } = o;
  const S = o.state || {};
  const bindings = {
    lights: o.rooms || {},
    curtains: (o.sensors && o.sensors.curtains) || {},
    doors: (o.sensors && o.sensors.doors) || {},
  };
  const curtainNames = new Map(((o.house && o.house.curtains) || []).map(c => [c.id, c.name || c.id]));
  const doorNames = new Map(((o.house && o.house.doors) || []).map(d => [d.id, d.name || d.id]));
  const ha = () => (o.getHa ? o.getHa() : null);
  const onChange = () => { try { o.onChange && o.onChange(); } catch (e) { /* sidebar repaint must not break us */ } };

  // Debug-only overrides (?debug=1): a desktop browser has no Home Assistant
  // here, so the connection status and raw entity states can be SIMULATED to
  // exercise the green / yellow states. Never set outside the seam.
  const sim = { status: undefined, raw: new Map() };
  const conn = () => (sim.status !== undefined ? sim.status : (ha() ? ha().status : null));
  const raw = eid => (sim.raw.has(eid) ? sim.raw.get(eid) : (ha() && ha().getRawState ? ha().getRawState(eid) : null));
  // Commands go out only through a real client that is fully connected.
  // writeBlocked(): a configured HA that is not connected (the real status,
  // or a ?debug=1 simulated one) -- every write handler returns at once:
  // no command AND no preview on the model. With no client at all (the demo
  // house) nothing is blocked and changes preview locally, as before.
  const canSend = () => { const h = ha(); return !!h && h.status === 'connected'; };
  const writeBlocked = () => { const h = ha(); return haOfflineConn(conn()) || (!!h && h.status !== 'connected'); };

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  const rc = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tmpV = new THREE.Vector3();

  const lightTargets = [];
  home.scene.traverse(obj => {
    if (!obj.isMesh || !obj.userData || !obj.userData.lightChannel) return;
    const t = resolveTarget(obj, bindings);
    if (t) lightTargets.push(t);
  });

  function canvasRect() { return container.getBoundingClientRect(); }

  function raycastAt(clientX, clientY) {
    const r = canvasRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, home.getCamera());
    return rc.intersectObjects(home.scene.children, true);
  }

  function unoccluded(t, point) {
    const origin = home.getCamera().position;
    const dir = tmpV.copy(point).sub(origin);
    const dist = dir.length();
    dir.normalize();
    rc.set(origin, dir);
    rc.far = dist + 0.05;
    const res = pickFromHits(rc.intersectObjects(home.scene.children, true), bindings);
    rc.far = Infinity;
    if (res.target) return res.target.id === t.id && res.target.kind === t.kind;
    return !res.hit;
  }

  let lastPickMs = 0;
  function pickAt(clientX, clientY) {
    const t0 = performance.now();
    const res = pickFromHits(raycastAt(clientX, clientY), bindings);
    let out;
    if (res.target) {
      out = { target: res.target, point: res.hit.point };
    } else {
      const r = canvasRect();
      const cam = home.getCamera();
      const cands = [];
      lightTargets.forEach(t => {
        t.object.getWorldPosition(tmpV);
        const wp = tmpV.clone();
        tmpV.project(cam);
        if (tmpV.z > 1 || tmpV.z < -1) return;
        const sx = r.left + (tmpV.x + 1) / 2 * r.width;
        const sy = r.top + (1 - tmpV.y) / 2 * r.height;
        const d = Math.hypot(sx - clientX, sy - clientY);
        if (d <= FUZZ_PX) cands.push({ t, d, wp });
      });
      cands.sort((a, b) => a.d - b.d);
      const hit = cands.find(c => unoccluded(c.t, c.wp));
      if (hit) out = { target: hit.t, point: hit.wp, fuzzy: true };
      else out = res.hit ? { occludedBy: res.hit.object } : null;
    }
    lastPickMs = performance.now() - t0;
    return out;
  }

  // ---- views: model() -> data, html(m) -> inner markup, bind(el) ---------
  const roomName = id => ((Home3DScene.ROOMS || {})[id] || {}).name || id;
  const dot = k => {
    const s = STATUS[k];
    return '<button class="tp-status ' + s[0] + (tipOpen ? ' tip-open' : '') + '" type="button" data-a="status" data-st="' + k +
      '" aria-label="Connection status: ' + esc(s[1]) + '"><i></i><span class="tp-tip" role="tooltip"><b>' + esc(s[1]) +
      '</b><small>' + esc(s[2]) + '</small></span></button>';
  };
  const climateMock = new Map();

  const VIEWS = {
    light: {
      model(t) {
        const st = (home.lightState[t.roomId] || {})[t.channel] || { on: false, bri: 100 };
        const c = conn();
        const r = raw(t.entities[0]);
        const na = lightUnavailable(c, r);
        const lc = ((Home3DScene.LIGHTS || {})[t.roomId] || {})[t.channel];
        return { status: statusKey('light', c, na), na, haOff: haOfflineConn(c), on: !!st.on, bri: st.bri != null ? st.bri : 100,
          // A colour square only for an accent channel whose entity can take
          // a colour (supported_color_modes; unknown counts as yes).
          colorable: isColorChannel(t.channel) && supportsColor(r && r.attributes),
          color: isColorChannel(t.channel) ? swatchColor(st.color) : undefined,
          name: lightName(roomName(t.roomId), t.channel, lc && lc.name) };
      },
      html(m) { return popoverHtml.light(m, dot); },
      bind(t, el, ctl) {
        const s = () => (home.lightState[t.roomId] || {})[t.channel];
        const sw = el.querySelector('[data-a=power]');
        if (sw) sw.addEventListener('click', () => {
          if (writeBlocked()) return;
          const st = s(); if (!st) return;
          st.on = !st.on; if (st.on && !st.bri) st.bri = 100;
          home.updateLights(); o.sendLight(t.roomId, t.channel, st, 0); onChange(); ctl.refresh(true);
        });
        const r = el.querySelector('[data-a=bri]');
        if (r) {
          r.addEventListener('input', () => {
            if (writeBlocked()) return;
            const st = s(); if (!st) return;
            ctl.dragging = true;
            st.bri = +r.value; st.on = true;
            home.updateLights(); o.sendLight(t.roomId, t.channel, st, 200);
            r.style.setProperty('--p', fillPct(r)); r.classList.remove('off');
            const v = el.querySelector('[data-v]'); if (v) v.innerHTML = '<b>On</b> · ' + st.bri + '%';
            sw.classList.add('on'); sw.setAttribute('aria-checked', 'true');
            const ic = el.querySelector('.tp-ico'); if (ic) ic.outerHTML = ico(I.bulb, 'light-on');
          });
          // 'change' ends the drag at once and repaints the sidebar (the
          // value itself went out on 'input', debounced, as the sidebar's own
          // light slider does). pointerup PRECEDES 'change', so its rebuild is
          // deferred a tick (the sidebar's rule, see curtainSender's onRelease
          // in index.html) -- rebuilding synchronously replaced the input and
          // lost the 'change' listener.
          const finish = () => { if (ctl.dragging) { ctl.dragging = false; onChange(); ctl.refresh(); } };
          r.addEventListener('change', finish);
          const end = () => setTimeout(finish, 0);
          r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end);
        }
        // Colour square (accent channels): the native picker. 'input' fires
        // as the user moves through the picker -- debounced through the same
        // sendLight path as the slider; the card is held still meanwhile
        // (ctl.dragging) so a rebuild never replaces the input under an open
        // picker. 'change' / blur end it.
        const cp = el.querySelector('[data-a=color]');
        if (cp) {
          cp.addEventListener('input', () => {
            if (writeBlocked()) return;
            const st = s(); if (!st) return;
            ctl.dragging = true;
            st.color = cp.value; st.on = true; if (!st.bri) st.bri = 100;
            home.updateLights(); o.sendLight(t.roomId, t.channel, st, 200, true);
            if (r) r.classList.remove('off');
            const v = el.querySelector('[data-v]'); if (v) v.innerHTML = '<b>On</b> · ' + st.bri + '%';
            if (sw) { sw.classList.add('on'); sw.setAttribute('aria-checked', 'true'); }
          });
          const done = () => { if (ctl.dragging) { ctl.dragging = false; onChange(); ctl.refresh(); } };
          cp.addEventListener('change', done);
          cp.addEventListener('blur', done);
        }
      },
    },

    curtain: {
      model(t) {
        const c = conn();
        const avail = S.curtainAvailable ? S.curtainAvailable(t.id) : null;
        const na = curtainUnavailable(c, avail);
        const pct = Math.round((S.curtainPct ? S.curtainPct(t.id) : home.getCurtainOpen(t.id)) || 0);
        return { status: statusKey('curtain', c, na), na, haOff: haOfflineConn(c), pct, name: curtainNames.get(t.id) || t.id };
      },
      html(m) { return popoverHtml.curtain(m, dot); },
      bind(t, el, ctl) {
        const sender = o.curtainSender;
        const local = pct => { if (S.curtainLocal) S.curtainLocal(t.id, pct); else home.setCurtainOpen(t.id, pct, null); };
        const r = el.querySelector('[data-a=pos]');
        if (r) {
          r.addEventListener('input', () => {
            if (writeBlocked()) return;
            ctl.dragging = true;
            const pct = +r.value;
            local(pct);
            if (canSend() && sender) sender.input(t.id, pct);
            r.style.setProperty('--p', fillPct(r));
            const v = el.querySelector('[data-v]'); if (v) v.innerHTML = 'Open <b>' + pct + '%</b>';
          });
          r.addEventListener('change', () => {
            if (canSend() && sender) sender.commit(t.id, +r.value);
            ctl.dragging = false; onChange(); ctl.refresh();
          });
          // Deferred a tick, as for the light: 'change' (commit) follows pointerup.
          const end = () => {
            if (sender) sender.end(t.id);
            setTimeout(() => { if (ctl.dragging) { ctl.dragging = false; ctl.refresh(); } }, 0);
          };
          r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end);
        }
        const press = cmd => {
          if (writeBlocked()) return;
          if (canSend() && sender) sender.press(t.id, o.HAClient.coverOpenCloseCommand(cmd, t.entities));
          else local(cmd === 'open' ? 100 : 0);   // no HA configured (demo): preview on the model
          onChange(); ctl.refresh(true);
        };
        el.querySelectorAll('[data-a=open],[data-a=close]').forEach(b =>
          b.addEventListener('click', () => { if (!b.disabled) press(b.dataset.a); }));
      },
    },

    climate: {
      model(t) {
        const c = conn();
        const eid = t.entities[0];
        let reading = S.climate ? S.climate(t.id) : null;
        const r = raw(eid);
        let mock = false, action;
        if (c == null && !reading) {
          // No HA configured (demo): sample values, clearly marked (red dot
          // tooltip). A configured HA that is merely offline gets no samples:
          // its card says "HA offline" with the controls disabled.
          if (!climateMock.has(t.id)) climateMock.set(t.id, { available: true, off: false, current: 19.5, target: 21, min: 7, max: 30, step: 0.5, action: 'heating' });
          reading = climateMock.get(t.id); mock = true; action = reading.action;
        } else {
          action = r && r.attributes ? r.attributes.hvac_action : undefined;
        }
        // The dot says whether HA is live; the BODY says what we last knew. A
        // last reading of 'unavailable' reads "Unavailable" even while offline,
        // never "Off" (parseClimate folds a null target into off).
        const readingNa = !mock && (!reading || !reading.available);
        const na = readingNa && (isLive(c) || !!reading);
        const off = !na && !!(reading && reading.off);
        return { status: statusKey('climate', c, readingNa && isLive(c), mock), na, mock, off, haOff: haOfflineConn(c),
          current: reading ? reading.current : null, target: reading ? reading.target : null,
          min: reading ? reading.min : 7, max: reading ? reading.max : 30, step: reading ? reading.step : 0.5,
          activity: climateActivity(action, off), name: sentenceCase(t.label || (roomName(t.id) + ' radiator')) };
      },
      html(m) { return popoverHtml.climate(m, dot); },
      bind(t, el, ctl) {
        const sender = o.climateSender;
        const m0 = () => VIEWS.climate.model(t);
        const show = v => {
          const e = el.querySelector('[data-t]'); if (e) e.textContent = v.toFixed(1) + '°';
          const r = el.querySelector('[data-a=set]'); if (r) { r.value = v; r.style.setProperty('--p', fillPct(r)); }
        };
        const apply = (v, how) => {
          if (writeBlocked()) return;
          const m = m0();
          v = Math.max(m.min, Math.min(m.max, Math.round(v / m.step) * m.step));
          if (m.mock) { climateMock.get(t.id).target = v; show(v); return; }
          if (canSend() && sender) {
            if (how === 'input') sender.input(t.id, v);
            else if (how === 'commit') sender.commit(t.id, v);
            else sender.press(t.id, o.HAClient.climateTargetCommand(v, t.entities[0], S.climate ? S.climate(t.id) : null));
          }
          show(v);   // optimistic; HA's echo repaints via the reading
        };
        const r = el.querySelector('[data-a=set]');
        if (r) {
          r.addEventListener('input', () => { ctl.dragging = true; apply(+r.value, 'input'); });
          r.addEventListener('change', () => { apply(+r.value, 'commit'); ctl.dragging = false; onChange(); });
          const end = () => { if (sender) sender.end(t.id); ctl.dragging = false; };
          r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end);
        }
        const step = d => { const m = m0(); const cur = r ? +r.value : m.target; apply(cur + d * m.step, 'press'); onChange(); };
        const dn = el.querySelector('[data-a=down]'), up = el.querySelector('[data-a=up]');
        if (dn) dn.addEventListener('click', () => step(-1));
        if (up) up.addEventListener('click', () => step(1));
      },
    },

    door: {
      chip: true,
      model(t) {
        const c = conn();
        const state = doorState(S.doorStatus ? S.doorStatus(t.id) : null, c);
        return { status: statusKey('door', c, state === 'na'), state, name: doorNames.get(t.id) || t.id };
      },
      html(m) {
        const map = { open: [I.doorOpen, 'd-open', 'Open'], closed: [I.doorClosed, 'd-closed', 'Closed'], na: [I.doorClosed, 'dim', 'Unavailable'],
          unknown: [I.doorClosed, 'dim', 'Unknown'] }[m.state];
        return '<div class="tp-head">' + ico(map[0], map[1]) + nameHtml(m.name) + '<span class="sep">·</span>' +
          '<span class="st ' + m.state + '">' + map[2] + '</span>' + dot(m.status) + '</div>';
      },
      bind() {},
    },
  };

  // ---- popover lifecycle ------------------------------------------------
  let pop = null;          // { el, target, x, y, camSnap, sig, ctl, timer, returnTo }
  let tipOpen = false, tipTimer = 0;
  /** @param restoreFocus  put keyboard focus back where it was before open
   *  (Escape). A tap-away close leaves focus wherever the tap put it. */
  function close(restoreFocus) {
    if (!pop) return;
    const p = pop;
    clearInterval(p.timer); clearTimeout(tipTimer); tipOpen = false;
    if (p.marq) { p.marq.cancel(); p.marq = null; }
    const hadFocus = p.el.contains(document.activeElement);
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    pop = null;
    if (restoreFocus === true && hadFocus) {
      const back = p.returnTo;
      if (back && back !== document.body && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
      else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
  }
  // Focusable controls inside the card, in DOM order (disabled ones skipped).
  const focusables = el => Array.from(el.querySelectorAll('button:not([disabled]), input:not([disabled])'));
  // The control keyboard focus lands on at open: the first real control, not
  // the status dot (which leads the header); the card itself for the
  // read-only door chip.
  function focusFirst(el) {
    const f = focusables(el).filter(c => c.dataset.a !== 'status');
    (f[0] || el).focus({ preventScroll: true });
  }

  // The room sidebar (#panel) is an opaque layer over the right of the
  // canvas. Its rect when it is actually on screen, else null (closed, it is
  // translated off the right edge).
  function sidebarRect() {
    const sb = o.sidebar;
    if (!sb || !sb.getBoundingClientRect) return null;
    // Closing: it is sliding off (0.25 s transition) and about to be gone --
    // the card must not dodge a panel that is leaving.
    if (sb.classList && !sb.classList.contains('open')) return null;
    const r = sb.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.left >= window.innerWidth || r.right <= 0) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  function camSnapshot() { const cam = home.getCamera(); cam.updateMatrixWorld(); return cam.matrixWorld.elements.slice(); }
  function camMoved(snap) {
    const e = home.getCamera().matrixWorld.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(e[i] - snap[i]) > 1e-6) return true;
    return false;
  }

  function position() {
    const el = pop.el;
    const r = canvasRect();
    // The visible scene: the canvas within the viewport, minus the sidebar
    // when it is open. If the card does not fit the leftover space it is
    // clamped into it, and z-index 60 (> the panel's 50) keeps it on top.
    const bounds = boundsExcluding({
      left: Math.max(0, r.left), top: Math.max(0, r.top),
      right: Math.min(window.innerWidth, r.right), bottom: Math.min(window.innerHeight, r.bottom),
    }, sidebarRect(), pop.x, pop.y);
    const p = placePopover(pop.x, pop.y, el.offsetWidth, el.offsetHeight, bounds);
    el.style.left = p.left + 'px';
    el.style.top = p.top + 'px';
    el.dataset.placement = p.placement;
    const a = el.querySelector('.tp-arrow');
    if (a) {
      a.className = 'tp-arrow' + (p.arrow ? ' ' + p.arrow.side : '');
      a.style.display = p.arrow ? '' : 'none';
      a.style.left = a.style.top = '';
      if (p.arrow && (p.arrow.side === 'top' || p.arrow.side === 'bottom')) a.style.left = p.arrow.offset + 'px';
      else if (p.arrow) a.style.top = p.arrow.offset + 'px';
    }
  }

  function render(force) {
    if (!pop) return;
    const v = VIEWS[pop.target.kind];
    const m = v.model(pop.target);
    const sig = JSON.stringify(m) + tipOpen;
    if (!force && (sig === pop.sig || pop.ctl.dragging)) return;
    pop.sig = sig;
    // A rebuild replaces every control: keep keyboard focus on the same one.
    const ae = document.activeElement;
    const refocus = pop.el.contains(ae) ? (ae === pop.el ? '' : (ae.dataset && ae.dataset.a) || '') : null;
    pop.el.innerHTML = v.html(m) + '<span class="tp-arrow"></span>';
    pop.el.setAttribute('aria-label', m.name);
    pop.el.querySelectorAll('.tp-range').forEach(r => r.style.setProperty('--p', fillPct(r)));
    v.bind(pop.target, pop.el, pop.ctl);
    fitTitle(pop);
    position();
    if (refocus !== null) {
      const c = refocus && pop.el.querySelector('[data-a="' + refocus + '"]');
      (c && !c.disabled ? c : pop.el).focus({ preventScroll: true });
    }
  }

  // ---- title marquee ------------------------------------------------------
  // A name too long for the card slides (marqueePlan): it never changes the
  // card's width and never ellipsises. Paused while the pointer is over the
  // card or a slider is held; reduced motion wraps it to two lines instead.
  const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function syncMarq(p) {
    if (!p || !p.marq) return;
    if (p.hover || p.hold || p.ctl.dragging) p.marq.pause(); else p.marq.play();
  }
  function fitTitle(p) {
    if (p.marq) { p.marq.cancel(); p.marq = null; }
    const box = p.el.querySelector('.tp-name');
    const inner = box && box.querySelector('.tp-name-in');
    if (!inner) return;
    box.classList.remove('marq', 'wrap');
    const plan = marqueePlan(inner.scrollWidth, box.clientWidth, { reducedMotion: reducedMotion() });
    box.dataset.marquee = plan.mode;
    if (plan.mode === 'wrap') { box.classList.add('wrap'); return; }
    if (plan.mode !== 'scroll' || typeof inner.animate !== 'function') return;
    box.classList.add('marq');
    const at = (px, offset, easing) => ({ transform: 'translateX(' + px + 'px)', offset, easing: easing || 'linear' });
    const d = -plan.distance, f = plan.offsets;
    p.marq = inner.animate([at(0, f[0]), at(0, f[1], 'ease-in-out'), at(d, f[2]), at(d, f[3], 'ease-in-out'), at(0, f[4])],
      { duration: plan.duration, iterations: Infinity });
    syncMarq(p);
  }

  function open(target, x, y) {
    const returnTo = pop ? pop.returnTo : document.activeElement;
    close();
    const el = document.createElement('div');
    el.className = 'tp-pop' + (VIEWS[target.kind].chip ? ' chip' : '');
    el.dataset.kind = target.kind;
    el.dataset.target = target.id;
    el.setAttribute('role', 'dialog');
    el.tabIndex = -1;   // focus target for the door chip, and after a rebuild
    document.body.appendChild(el);
    pop = { el, target, x, y, camSnap: camSnapshot(), sig: null, ctl: { dragging: false }, returnTo };
    pop.ctl.refresh = f => render(!!f);
    const p0 = pop;
    // Mouse hover pauses the title marquee; so does holding a slider (the
    // window-level pointerup below releases it, wherever the drag ends).
    el.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { p0.hover = true; syncMarq(p0); } });
    el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { p0.hover = false; syncMarq(p0); } });
    el.addEventListener('pointerdown', e => {
      if (e.target.closest && e.target.closest('.tp-range, .tp-color')) { p0.hold = true; syncMarq(p0); }
    });
    // Status dot: tap toggles its tooltip (touch; auto-hides after 4 s),
    // mouse gets it on hover through CSS. Delegated, so it survives rebuilds.
    el.addEventListener('click', e => {
      const st = e.target.closest && e.target.closest('[data-a=status]');
      if (st) {
        tipOpen = !tipOpen; st.classList.toggle('tip-open', tipOpen);
        clearTimeout(tipTimer);
        if (tipOpen) tipTimer = setTimeout(() => { tipOpen = false; if (pop) { const d = pop.el.querySelector('[data-a=status]'); if (d) d.classList.remove('tip-open'); } }, 4000);
        return;
      }
      if (tipOpen) { tipOpen = false; const d = el.querySelector('[data-a=status]'); if (d) d.classList.remove('tip-open'); }
    });
    // Tab cycles within the card (it is appended at the end of <body>, so
    // tabbing off its last control would leave for the browser chrome);
    // Escape (onKey) closes it and returns focus.
    el.classList.add('tp-ptr');
    el.addEventListener('keydown', e => {
      el.classList.remove('tp-ptr');   // keyboard in use: show focus rings
      if (e.key !== 'Tab') return;
      const f = focusables(el);
      if (!f.length) { e.preventDefault(); return; }
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    });
    render(true);
    focusFirst(el);
    // Most live changes repaint the scene (-> onRender below); a reading that
    // moves nothing requests no frame, so a slow DOM-only tick covers it.
    pop.timer = setInterval(() => { try { render(false); } catch (e) { /* ignore */ } }, 1000);
    home.requestRender();
  }

  // ---- input --------------------------------------------------------------
  const pointers = new Set();
  let downX = 0, downY = 0, multi = false;
  const inCanvas = e => container.contains(e.target);
  const onPointerDown = e => {
    if (pop && !pop.el.contains(e.target)) close();
    if (!inCanvas(e)) return;
    pointers.add(e.pointerId);
    if (pointers.size === 1) { downX = e.clientX; downY = e.clientY; multi = false; }
    else multi = true;
  };
  const onPointerEnd = e => {
    pointers.delete(e.pointerId);
    if (pop && pop.hold) { pop.hold = false; setTimeout(() => syncMarq(pop), 0); }
  };
  const onClick = e => {
    if (!inCanvas(e)) return;
    if (multi) return;
    if (Math.abs(e.clientX - downX) > TAP_SLOP_PX || Math.abs(e.clientY - downY) > TAP_SLOP_PX) return;
    const res = pickAt(e.clientX, e.clientY);
    if (res && res.target) {
      e.stopPropagation();   // this tap is ours: no room selection underneath
      // Tell the page first (an unpinned sidebar closes on an object tap),
      // THEN open. The sidebar-toggle rule below ("opening or closing the
      // sidebar closes the card") must not kill the card this same tap is
      // opening, so the class flip the hook just made is absorbed here.
      if (typeof o.onObjectTap === 'function') {
        try { o.onObjectTap(res.target); } catch (err) { /* the page's hook must not cost the tap */ }
        syncSidebarOpen();
      }
      open(res.target, e.clientX, e.clientY);
    }
  };
  const onWheel = e => { if (pop && inCanvas(e)) close(); };
  const onKey = e => { if (e.key === 'Escape' && pop) close(true); };
  const onResize = () => close();

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerEnd, true);
  window.addEventListener('pointercancel', onPointerEnd, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: true });
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  // Opening or closing the sidebar moves the space the card was placed in:
  // close it rather than leave it over (or under) the panel.
  let sidebarOpen = o.sidebar && o.sidebar.classList ? o.sidebar.classList.contains('open') : false;
  const sidebarObs = o.sidebar && typeof MutationObserver === 'function' ? new MutationObserver(() => {
    const now = o.sidebar.classList.contains('open');
    if (now !== sidebarOpen) { sidebarOpen = now; close(); }
  }) : null;
  if (sidebarObs) sidebarObs.observe(o.sidebar, { attributes: true, attributeFilter: ['class'] });
  function syncSidebarOpen() {
    if (sidebarObs) sidebarObs.takeRecords();   // drop the pending mutation: it is accounted for
    if (o.sidebar && o.sidebar.classList) sidebarOpen = o.sidebar.classList.contains('open');
  }

  const unsub = home.onRender(() => {
    if (!pop) return;
    if (camMoved(pop.camSnap)) { close(); return; }
    try { render(false); } catch (e) { /* never break the render loop */ }
  });

  const climateBinding = (o.sensors && o.sensors.climate) || {};
  const api = {
    pickAt(x, y) {
      const r = pickAt(x, y);
      if (!r) return null;
      if (r.target) return { kind: r.target.kind, id: r.target.id, fuzzy: !!r.fuzzy };
      const ob = r.occludedBy;
      let size = null;
      if (ob && ob.geometry) {
        ob.geometry.computeBoundingBox();
        const s = ob.geometry.boundingBox.getSize(new THREE.Vector3());
        size = [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)];
      }
      return { occludedBy: (ob && (ob.name || (ob.parent && ob.parent.name) || ob.geometry && ob.geometry.type)) || 'mesh',
        occluderSize: size, occluderOpacity: ob ? materialOpacity(ob.material) : null };
    },
    /** Open without a tap (debug seam; the only route to climate on main). */
    openAt(kind, id, x, y, extra) {
      let ents;
      if (kind === 'light') ents = (bindings.lights[id.split('/')[0]] || {})[id.split('/')[1]];
      else if (kind === 'climate') ents = typeof climateBinding[id] === 'string' ? [climateBinding[id]] : null;
      else ents = (bindings[kind + 's'] || {})[id];
      if (!ents) return false;
      const t = Object.assign({ kind, id, entities: ents }, extra || {});
      if (kind === 'light') { t.roomId = id.split('/')[0]; t.channel = id.split('/')[1]; }
      open(t, x, y);
      return true;
    },
    /** SIMULATE a connection status / raw entity states (debug only). */
    simulate(spec) {
      if (spec && 'status' in spec) sim.status = spec.status;
      if (spec && spec.raw) Object.keys(spec.raw).forEach(k => sim.raw.set(k, spec.raw[k]));
      if (spec && spec.reset) { sim.status = undefined; sim.raw.clear(); }
      render(false);
    },
    close: () => close(),
    isOpen: () => !!pop,
    current: () => (pop ? { kind: pop.target.kind, id: pop.target.id, entities: pop.target.entities.slice(), placement: pop.el.dataset.placement,
      status: (pop.el.querySelector('[data-a=status]') || {}).dataset?.st, rect: pop.el.getBoundingClientRect().toJSON() } : null),
    lastPickMs: () => lastPickMs,
    lightTargets() {
      const r = canvasRect(); const cam = home.getCamera();
      return lightTargets.map(t => {
        t.object.getWorldPosition(tmpV); tmpV.project(cam);
        return { id: t.id, x: Math.round(r.left + (tmpV.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - tmpV.y) / 2 * r.height) };
      });
    },
    /** Idempotent: index.html registers it with home.onDispose. */
    dispose() {
      if (disposed) return;
      disposed = true;
      close(); unsub();
      if (sidebarObs) sidebarObs.disconnect();
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      if (window.__home3dTap === api) delete window.__home3dTap;
      document.documentElement.classList.remove('tp-force-coarse');
    },
  };
  let disposed = false;
  if (o.debug) {
    window.__home3dTap = api;
    // ?tpCoarse=1 forces touch sizing on a fine-pointer browser (verification only).
    if (new URLSearchParams(location.search).get('tpCoarse') === '1') document.documentElement.classList.add('tp-force-coarse');
  }
  return api;
}
