/**
 * Room sidebar panel -- the DOM-free half.
 *
 * index.html owns the panel element and wires events; everything here is a
 * pure function or a small state machine with no `document`, so the parts
 * that decide WHAT a row says and WHETHER a command is sent can be tested in
 * plain node (scripts/test-room-panel.mjs). Anything that reaches a physical
 * device -- a curtain motor, a thermostat -- goes through createDragSender(),
 * which is the only place the "one user action, one command" rules live.
 */

import { ICONS, svgIcon } from './ui-icons.js';
import { swatchColor } from './light-color.js';
import { SIDEBAR_GROUPS } from './bindings.js';
// One sentence-case rule for sidebar headers and popover titles alike.
import { sentenceCase } from './tap-popovers.js';
export { sentenceCase };

/** Minimal HTML escaper for profile-supplied text (labels, ids). */
export function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Motion status ('on'|'off'|'unavailable'|null) -> the tag's text. */
export function motionLabel(status) {
  if (status === 'on') return 'Motion detected';
  if (status === 'off') return 'No motion';
  return 'Unavailable';
}

/** Door status ('on'|'off'|'unavailable'|null) -> the row's text. HA's
 *  door/opening convention: on = open. */
export function doorLabel(status) {
  if (status === 'on') return 'Door: open';
  if (status === 'off') return 'Door: closed';
  return 'Door: unavailable';
}

function fmtTemp(t) {
  return (typeof t === 'number' && isFinite(t)) ? t.toFixed(1) + '°C' : '—';
}

/**
 * Climate reading (HAClient.parseClimate shape, or null when nothing has
 * been heard) -> what the temperature row shows. `disabled` is the single
 * source for the slider's disabled attribute: no reading, unavailable, or
 * off (which includes a null target) all disable it.
 */
export function climateView(reading) {
  if (!reading || !reading.available) {
    return { disabled: true, status: 'Unavailable', current: '—', target: '—',
      min: reading ? reading.min : 7, max: reading ? reading.max : 35,
      step: reading ? reading.step : 0.5, value: reading ? reading.min : 7 };
  }
  const off = !!reading.off;
  return {
    disabled: off,
    status: off ? 'off' : 'on',
    current: fmtTemp(reading.current),
    target: off ? 'off' : fmtTemp(reading.target),
    min: reading.min,
    max: reading.max,
    step: reading.step,
    value: off ? reading.min : reading.target
  };
}

// ---- Home Assistant offline ------------------------------------------------

/**
 * True when there IS a Home Assistant client and it is not fully connected
 * (disconnected, still authenticating, syncing its snapshot, auth or sync
 * failed). Every control that sends a command is then DISABLED, and its
 * handler does nothing -- no command (it would be dropped anyway) and, just
 * as important, no optimistic change to the panel or the 3D model, because
 * an optimistic change nobody sent is a lie the panel would keep telling.
 *
 * Only 'connected' counts: it is set after auth_ok AND the get_states
 * snapshot (and the full resync that follows it), so the controls come back
 * already showing Home Assistant's real values. 'syncing' is not enough --
 * the race path sets it on auth_required, before authentication.
 *
 * No client at all (HA disabled / not configured -- the demo house) is NOT
 * offline: there is nothing to be out of sync with, and the lights stay a
 * local preview there, as they always have.
 */
/**
 * A range input's filled fraction as a CSS length, for the `--p` variable
 * the .slider track paints its fill up to. `rangeFillStyle` is the inline
 * style for the row markup; `fillRange` updates a live input as it moves.
 */
export function rangeFillPct(value, min, max) {
  const lo = +min, hi = +max, v = +value;
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return '0%';
  return (Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
}
export function rangeFillStyle(value, min, max) {
  return ' style="--p:' + rangeFillPct(value, min, max) + '"';
}
export function fillRange(el) {
  el.style.setProperty('--p', rangeFillPct(el.value, el.min, el.max));
}

export function haOffline(ha) {
  return !!ha && ha.status !== 'connected';
}

export const HA_OFFLINE_TEXT = 'HA offline — controls are disabled until Home Assistant reconnects.';

export function haOfflineRowHtml() {
  return `<div class="control-group ha-offline-note" data-row="ha-offline" role="status">
    <span class="ha-offline-dot"></span><span>${esc(HA_OFFLINE_TEXT)}</span>
  </div>`;
}

// ---- Row markup ------------------------------------------------------------
// Each section header carries the same MDI icon as the matching tap popover
// (src/ui-icons.js) and a sentence-case title -- never ALL CAPS.

const rowIco = (path, cls) => svgIcon(path, 'row-ico' + (cls ? ' ' + cls : ''));

/** A section header's left side: icon + title. `title` is escaped here. */
export function sectionTitleHtml(iconPath, title, iconCls) {
  return `<span class="control-title">${rowIco(iconPath, iconCls)}<span class="control-label">${esc(title)}</span></span>`;
}
// Every row is one `.control-group` carrying `data-row="<key>"`, which is what
// lets index.html repaint ONE row in place when its entity reports, instead of
// rebuilding the whole panel.

export function doorRowHtml(door, status, showName) {
  const text = doorLabel(status);
  const cls = status === 'on' ? 'open' : status === 'off' ? 'closed' : 'unavailable';
  const icon = status === 'on' ? rowIco(ICONS.doorOpen, 'd-open') : rowIco(ICONS.doorClosed, status === 'off' ? 'd-closed' : 'dim');
  return `<div class="control-group status-row" data-row="door:${esc(door.id)}">
    <div class="control-header">
      <span class="control-title">${icon}<span class="status-text status-${cls}" data-status="door">${esc(text)}</span></span>
      ${showName ? `<span class="status-sub">${esc(door.name || door.id)}</span>` : ''}
    </div>
  </div>`;
}

export function motionRowHtml(status) {
  const cls = status === 'on' ? 'on' : status === 'off' ? 'off' : 'unavailable';
  return `<div class="control-group status-row" data-row="motion">
    <div class="control-header">
      ${sectionTitleHtml(ICONS.motion, 'Motion', cls === 'on' ? 'motion-on' : '')}
      <span class="status-tag status-tag-${cls}" data-status="motion">${esc(motionLabel(status))}</span>
    </div>
  </div>`;
}

/**
 * Light rows. `s` is home.lightState[room][channel]; `offline` (haOffline)
 * disables every control in the row. The markup is otherwise what the
 * sidebar has always drawn.
 */
export function mainLightRowHtml(s, offline) {
  const dis = offline ? ' disabled' : '';
  let h = `<div class="control-group" data-row="main">
    <div class="control-header">
      ${sectionTitleHtml(s.on ? ICONS.bulb : ICONS.bulbOff, 'Main light', s.on ? 'light-on' : '')}
      <button class="toggle ${s.on ? 'on' : ''}" data-action="toggle-main"${dis}>
        <div class="toggle-knob"></div>
      </button>
    </div>`;
  if (s.on) {
    const t = s.temp;
    h += `<div class="slider-row">
      <div class="slider-label">Brightness: ${s.bri}%</div>
      <input type="range" class="slider" min="5" max="100" value="${s.bri}"${rangeFillStyle(s.bri, 5, 100)} data-action="bri-main"${dis}>
    </div>
    <div class="slider-row">
      <div class="slider-label">Temperature: ${t}K ${t < 3200 ? 'Warm' : t > 5000 ? 'Cool' : 'Neutral'}</div>
      <input type="range" class="slider temp" min="2700" max="6500" step="100" value="${t}" data-action="temp-main"${dis}>
    </div>`;
  }
  return h + '</div>';
}

/**
 * The ambience row. `name` is the ambient group's display name. While on:
 * ONE colour square showing the channel's current colour, inline with the
 * brightness slider and its value -- [■] ───●─── 17%. The square is a native
 * colour input: tapping it opens the platform picker. `colorable` false (the
 * bound entity is white-only: supportsColor in src/light-color.js) drops the
 * square and leaves the slider.
 */
export function ambientRowHtml(s, name, offline, colorable) {
  const dis = offline ? ' disabled' : '';
  let h = `<div class="control-group" data-row="ambient">
    <div class="control-header">
      ${sectionTitleHtml(s.on ? ICONS.bulb : ICONS.bulbOff, sentenceCase(name), s.on ? 'light-on' : '')}
      <button class="toggle ${s.on ? 'on' : ''}" data-action="toggle-ambient"${dis}>
        <div class="toggle-knob"></div>
      </button>
    </div>`;
  if (s.on) {
    h += `<div class="slider-row inline-row">
      ${colorable === false ? '' : `<input type="color" class="color-square" value="${esc(swatchColor(s.color))}" data-action="color-ambient" aria-label="Colour" title="Colour"${dis}>`}
      <input type="range" class="slider" min="5" max="100" value="${s.bri}"${rangeFillStyle(s.bri, 5, 100)} data-action="bri-ambient" aria-label="Brightness"${dis}>
      <span class="inline-val">${s.bri}%</span>
    </div>`;
  }
  return h + '</div>';
}

export function galaxyRowHtml(s, offline) {
  const dis = offline ? ' disabled' : '';
  let h = `<div class="control-group" data-row="galaxy">
    <div class="control-header">
      ${sectionTitleHtml(s.on ? ICONS.bulb : ICONS.bulbOff, 'Galaxy projector', s.on ? 'light-on' : '')}
      <button class="toggle galaxy ${s.on ? 'on' : ''}" data-action="toggle-galaxy"${dis}>
        <div class="toggle-knob"></div>
      </button>
    </div>`;
  if (s.on) {
    h += `<div class="slider-row">
      <div class="slider-label">Brightness: ${s.bri}%</div>
      <input type="range" class="slider" min="5" max="100" value="${s.bri}"${rangeFillStyle(s.bri, 5, 100)} data-action="bri-galaxy"${dis}>
    </div>`;
  }
  return h + '</div>';
}

export function curtainRowHtml(cu, pct, available, offline) {
  const shown = Math.round(pct);
  const dis = (available && !offline) ? '' : ' disabled';
  return `<div class="control-group" data-row="curtain:${esc(cu.id)}">
    <div class="control-header">
      ${sectionTitleHtml(shown > 0 ? ICONS.curtains : ICONS.curtainsClosed, sentenceCase(cu.label), available ? '' : 'dim')}
      <span class="row-btns">
        <button class="row-ib" data-action="curtain-cmd" data-cmd="close" data-curtain="${esc(cu.id)}" aria-label="Close curtain" title="Close"${dis}>${svgIcon(ICONS.cClose)}</button>
        <button class="row-ib" data-action="curtain-cmd" data-cmd="open" data-curtain="${esc(cu.id)}" aria-label="Open curtain" title="Open"${dis}>${svgIcon(ICONS.cOpen)}</button>
      </span>
    </div>
    <div class="slider-row">
      <div class="slider-label">${available ? ('Open: ' + shown + '%') : 'Unavailable'}</div>
      <input type="range" class="slider" min="0" max="100" value="${shown}"${rangeFillStyle(shown, 0, 100)}
        data-action="curtain-open" data-curtain="${esc(cu.id)}"${dis}>
    </div>
  </div>`;
}

/** `heating`: hvac_action says the radiator is firing now -- the
 *  thermometer turns orange (see climateHeating in index.html). */
export function climateRowHtml(reading, offline, heating) {
  const v = climateView(reading);
  return `<div class="control-group" data-row="climate">
    <div class="control-header">
      ${sectionTitleHtml(ICONS.thermometer, 'Temperature', heating ? 'heat' : '')}
      <span class="status-sub" data-status="climate-current">Now ${esc(v.current)}</span>
    </div>
    <div class="slider-row">
      <div class="slider-label">${v.status === 'Unavailable' ? 'Unavailable' : 'Target: ' + esc(v.target)}</div>
      <input type="range" class="slider" min="${v.min}" max="${v.max}" step="${v.step}" value="${v.value}"${rangeFillStyle(v.value, v.min, v.max)}
        data-action="climate-target"${(v.disabled || offline) ? ' disabled' : ''}>
    </div>
  </div>`;
}

// ---- Drag sender -----------------------------------------------------------

/**
 * The write path for a slider that drives a physical device. One instance
 * per kind (curtains, climate), keyed by target id (curtain id / room id).
 *
 *   build(id, rawValue) -> command | null   (pure mapping; null = send nothing)
 *   dispatch(command, id, delayMs)          (ha.callServiceDebounced, keyed per id)
 *
 * The rules, each of which a code review has had to find at least once:
 *   - NaN / non-numeric / not-sendable -> build() returns null -> nothing sent.
 *   - A drag is: first 'input' starts it (and forgets what was last sent, so
 *     a genuine new command to an earlier value is never suppressed across
 *     drags); 'input' sends debounced; 'change' (release) sends immediately.
 *   - No double send: within one drag, a value equal to the last one sent (or
 *     queued) is dropped. Together with callServiceDebounced clearing its own
 *     pending timer before an immediate send, a release on the last debounced
 *     value reaches HA exactly once.
 *   - The drag LOCK (isDragging) stops a live HA reading repainting the row
 *     under the pointer. It is released on 'change', on pointerup (a drag that
 *     ends on its start value fires no 'change'), pointercancel, blur, and
 *     whenever the row is re-rendered (the element it locked is gone).
 *   - Nothing here runs except from a user event handler.
 *   - cancel(id) drops a send still pending for this id -- called when the
 *     device goes off / unavailable inside the debounce window, and on a
 *     release whose build() refuses (the device changed under the drag).
 *   - A live reading that arrives while the row is locked marks it dirty
 *     (markDirty); releasing the lock then calls onRelease(id, true) so the
 *     row is repainted from the latest state instead of staying stale.
 *
 *   cancel(id)              (optional) ha.cancelDebounced for this id's key
 *   onRelease(id, wasDirty) (optional) called whenever a held lock releases
 *   writable()              (optional) false while HA is offline (haOffline):
 *                           input / commit / press then dispatch NOTHING, and
 *                           commit still drops any pending send and releases
 *                           the lock. A second gate behind the disabled DOM.
 */
/**
 * The light channels rooms.json BINDS per room: roomId -> [channel], for
 * Home3DScene.create's `boundChannels`. A channel with no entities is not a
 * binding. `rooms` null (no rooms.json) -> {}.
 */
export function boundLightChannels(rooms) {
  const out = {};
  Object.entries(rooms || {}).forEach(([rid, groups]) => {
    const chans = Object.entries(groups || {})
      .filter(([, ents]) => Array.isArray(ents) && ents.length > 0)
      .map(([ch]) => ch);
    if (chans.length) out[rid] = chans;
  });
  return out;
}

/**
 * Does a room get its (single) Ambient row?
 *
 * The row is the switch for the room's ambient BINDING, so it comes from
 * rooms.json: shown exactly when the room binds `ambient` to at least one
 * entity -- whether or not geometry draws any ambient fixture (an office
 * whose ambient light is a cornice and desk strips has none). Only when
 * there is no rooms.json at all (a bare demo with nothing to bind) does it
 * fall back to the geometry channel, so the 3D ambient strips can still be
 * switched locally.
 *
 * @param {?Object} rooms        rooms.json `rooms` (null when absent)
 * @param {string}  roomId
 * @param {boolean} hasGeometryChannel  the scene has an ambient channel for it
 */
export function hasAmbientRow(rooms, roomId, hasGeometryChannel) {
  if (!rooms) return !!hasGeometryChannel;
  const ents = rooms[roomId] && rooms[roomId].ambient;
  return Array.isArray(ents) && ents.length > 0;
}

/**
 * The Ambient row's label: the geometry channel's own name when geometry
 * draws one, else "<Room> Ambience" -- a room whose ambient light is only a
 * cornice and a desk strip has no fixture to take a name from.
 */
export function ambientRowLabel(lightGroup, roomName) {
  if (lightGroup && lightGroup.name) return lightGroup.name;
  return (roomName ? roomName + ' ' : '') + 'Ambience';
}

/**
 * Curtain SLIDER value -> command, refusing while the curtain is not
 * confirmed available -- the same rule the Open / Close buttons follow.
 * `coverPositionCommand` is HAClient.coverPositionCommand, injected so this
 * module stays free of the client.
 */
export function curtainSliderCommand(coverPositionCommand, pct, entities, available) {
  if (available !== true) return null;
  return coverPositionCommand(pct, entities);
}

/**
 * Curtains whose SHOWN position is not what Home Assistant last reported
 * (item 349848ef): HA dropped inside a drag's debounce window, so the drag's
 * value was never sent -- yet the panel row and the 3D curtain still show it
 * for the whole outage. Returns [[curtainId, reportedPct]] for each one, for
 * the status-change handler to re-apply while offline. A curtain HA never
 * reported is left alone: there is no HA value to go back to.
 *
 * @param {Map<string, number>} target    curtainId -> position shown now
 * @param {Map<string, number>} reported  curtainId -> position HA last reported
 */
export function curtainsToRevert(target, reported) {
  const out = [];
  if (!target || !reported) return out;
  reported.forEach((pct, id) => {
    if (target.has(id) && target.get(id) !== pct) out.push([id, pct]);
  });
  return out;
}

export function createDragSender({ build, dispatch, cancel, onRelease, writable, debounceMs = 200 }) {
  const canWrite = () => typeof writable !== 'function' || writable() === true;
  const dragging = new Set();
  const dirty = new Set();
  const lastSent = new Map();

  function release(id) {
    if (!dragging.has(id)) return;
    dragging.delete(id);
    const wasDirty = dirty.delete(id);
    if (typeof onRelease === 'function') onRelease(id, wasDirty);
  }

  function dropPending(id) {
    lastSent.delete(id);
    if (typeof cancel === 'function') cancel(id);
  }

  function send(id, raw, delayMs) {
    const cmd = build(id, raw);
    if (!cmd) return null;
    const key = JSON.stringify(cmd.data);
    if (lastSent.has(id) && lastSent.get(id) === key) return null;
    lastSent.set(id, key);
    dispatch(cmd, id, delayMs);
    return cmd;
  }

  return {
    /** Slider 'input'. Starts a drag on the first one. */
    input(id, raw) {
      if (!canWrite()) return null;
      if (!dragging.has(id)) {
        lastSent.delete(id);
        dragging.add(id);
      }
      return send(id, raw, debounceMs);
    },
    /** Slider 'change' (release / key commit): immediate send, then unlock.
     *  If build() now refuses (device went off/unavailable mid-drag), the
     *  earlier input's queued send is cancelled rather than left to fire. */
    commit(id, raw) {
      let cmd = null;
      if (canWrite() && build(id, raw)) cmd = send(id, raw, 0);
      else dropPending(id);
      release(id);
      return cmd;
    },
    /** pointerup / pointercancel / blur: unlock (and repaint if dirty). */
    end(id) { release(id); },
    /** Full panel re-render: every locked element is about to be destroyed,
     *  and the render itself paints fresh state, so no onRelease. */
    clear() { dragging.clear(); dirty.clear(); },
    /** The row is being replaced: drop its lock silently. */
    forget(id) { dragging.delete(id); dirty.delete(id); },
    isDragging(id) { return dragging.has(id); },
    /** A reading arrived while locked: repaint on release. */
    markDirty(id) { if (dragging.has(id)) dirty.add(id); },
    /** Device went off / unavailable: drop any send still pending. */
    cancel(id) { dropPending(id); },
    /**
     * A one-shot button (curtain Open / Close). Always sends -- a button
     * press is its own user action -- through the SAME dispatch key, so it
     * also cancels any slider send still pending for this id. Forgets the
     * last slider value so a later drag back to it is not deduped away.
     */
    press(id, cmd) {
      if (!cmd || !canWrite()) return null;
      lastSent.delete(id);
      dispatch(cmd, id, 0);
      return cmd;
    }
  };
}

/** A light fixture mounted lower than this (cm) is on the floor. */
export const FLOOR_LEVEL_MAX_CM = 50;

/**
 * A room's accent light, counted from the two profile files as authored (no
 * WebGL) -- what a test, a reviewer or a private-house check can count.
 *
 *   emitters      [{ kind: 'channel'|'cornice', id, entities }] -- one per
 *                 non-main light channel the room draws (a 'projector' draws
 *                 nothing and is skipped) and one per lit cornice. `entities`
 *                 is what it follows: its rooms.json channel binding, or the
 *                 cornice's corniceLights entry.
 *   floorFixtures non-main fixture positions below FLOOR_LEVEL_MAX_CM
 *   ambientRows   how many Ambient rows the sidebar shows (0 or 1)
 *
 * @param {Object} geometry  geometry.json as parsed
 * @param {?Object} roomsDoc rooms.json as parsed (null when absent)
 * @param {string} roomId
 */
export function roomAccentSummary(geometry, roomsDoc, roomId) {
  const g = geometry || {};
  const rooms = roomsDoc && roomsDoc.rooms ? roomsDoc.rooms : null;
  const sensors = (roomsDoc && roomsDoc.sensors) || {};
  const bound = (rooms && rooms[roomId]) || {};
  const emitters = [], floorFixtures = [];
  let hasGeometryAmbient = false;
  (g.lights || []).filter(l => l.room === roomId).forEach(l => {
    (l.fixtures || []).forEach(f => {
      if (f.channel === 'main') return;
      if (f.channel === 'ambient') hasGeometryAmbient = true;
      (f.positions || []).forEach((pos, i) => {
        if (pos.heightCm != null && pos.heightCm < FLOOR_LEVEL_MAX_CM) {
          floorFixtures.push({ channel: f.channel, id: pos.label || f.channel + '#' + i, heightCm: pos.heightCm });
        }
      });
      if (f.fixtureType === 'projector') return;
      emitters.push({ kind: 'channel', id: f.channel, entities: (bound[f.channel] || []).slice() });
    });
  });
  (g.curtains || []).filter(c => c.room === roomId).forEach(c => {
    // house-loader's rule: an absent `cornice` is a default cornice, lit.
    const cn = c.cornice || {};
    if (cn.enabled === false || cn.light === false) return;
    emitters.push({ kind: 'cornice', id: c.id, entities: ((sensors.corniceLights || {})[c.id] || []).slice() });
  });
  return { emitters, floorFixtures, ambientRows: hasAmbientRow(rooms, roomId, hasGeometryAmbient) ? 1 : 0 };
}

// ---- Sidebar configuration (rooms.json 1.11 `sidebar`) -----------------------
//
// A room's rows are DERIVED (roomRowKeys in index.html: main, ambient,
// galaxy, door:<id>, motion, curtain:<id>, climate, room-script), and the
// profile may reshape them per room:
//
//   sidebar: { <roomId>: {
//     hide:  ['ambient', 'curtain:lounge_sheer', 'doors', ...],  derived rows to drop
//     show:  ['item:desk_lamp', ...],                           furniture rows, OPT-IN
//     extra: [{ kind: 'light'|'cover'|'switch'|'script', entity, label, confirm? }]
//   } }
//
// A room with no entry, and a profile with no `sidebar`, keeps EXACTLY its
// derived rows. Item rows exist only where `show` names them: no profile
// grows a row it did not ask for. The HA-offline note can never be hidden.

// `hide` group names ('doors', 'curtains', 'vacuums'): one entry hides every row of that kind.
export { SIDEBAR_GROUPS };
/** What the sidebar editor offers to hide (besides each door / curtain by id). */
export const DERIVED_ROW_NAMES = Object.freeze(['main', 'ambient', 'galaxy', 'doors', 'motion', 'curtains', 'climate', 'vacuums', 'room-script']);
export const EXTRA_ROW_KINDS = Object.freeze({ light: ['light'], cover: ['cover'], switch: ['switch', 'input_boolean'], script: ['script'] });
const SIDEBAR_ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;

/**
 * rooms.json `sidebar` -> Map roomId -> { hide: Set, show: [itemKey], extra: [entry] }.
 * An `extra` entry with an unknown kind, an entity of the wrong domain or no
 * label is dropped (the validator reports it).
 */
export function normaliseSidebar(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.entries(raw).forEach(([rid, c]) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return;
    const hide = new Set((Array.isArray(c.hide) ? c.hide : []).filter(k => typeof k === 'string' && k));
    const show = (Array.isArray(c.show) ? c.show : []).filter(k => typeof k === 'string' && /^item:./.test(k));
    const extra = [];
    (Array.isArray(c.extra) ? c.extra : []).forEach(x => {
      const doms = x && EXTRA_ROW_KINDS[x.kind];
      if (!doms || typeof x.entity !== 'string' || !SIDEBAR_ENTITY_RE.test(x.entity)) return;
      if (doms.indexOf(x.entity.split('.')[0]) === -1) return;
      if (typeof x.label !== 'string' || !x.label.trim()) return;
      const v = x.variables;
      extra.push({ kind: x.kind, entity: x.entity, label: x.label.trim(), confirm: x.kind === 'script' && x.confirm === true,
        variables: v && typeof v === 'object' && !Array.isArray(v) ? Object.assign({}, v) : {} });
    });
    out.set(rid, { hide, show, extra });
  });
  return out;
}

const groupOfRow = key => { const i = key.indexOf(':'); return i > 0 ? SIDEBAR_GROUPS[key.slice(0, i)] || null : null; };

/**
 * A room's row keys: `derivedKeys` (roomRowKeys) reshaped by `cfg` (one
 * room's normaliseSidebar entry, or null). No cfg: the derived keys,
 * untouched. Otherwise: the derived rows minus `hide` (by key, or by group:
 * 'doors', 'curtains'), then the `show` item rows in order, then one
 * 'extra:<n>' per extra entry, and the room script last as always.
 */
export function sidebarRows(derivedKeys, cfg) {
  const keys = Array.isArray(derivedKeys) ? derivedKeys : [];
  if (!cfg) return keys.slice();
  const hide = cfg.hide instanceof Set ? cfg.hide : new Set(cfg.hide || []);
  const hidden = k => k !== 'ha-offline' && (hide.has(k) || (groupOfRow(k) !== null && hide.has(groupOfRow(k))));
  const out = keys.filter(k => k !== 'room-script' && !hidden(k));
  (cfg.show || []).forEach(k => { if (/^item:./.test(k) && out.indexOf(k) === -1 && !hide.has(k)) out.push(k); });
  (cfg.extra || []).forEach((x, i) => out.push('extra:' + i));
  if (keys.indexOf('room-script') !== -1 && !hidden('room-script')) out.push('room-script');
  return out;
}

/** An extra / item light row: a power toggle and, while on, a brightness slider. `m` is item-cards' lightRowModel. */
export function extraLightRowHtml(key, label, m, offline) {
  const dis = offline || m.na ? ' disabled' : '';
  let h = '<div class="control-group" data-row="' + esc(key) + '">' +
    '<div class="control-header">' +
      sectionTitleHtml(m.on ? ICONS.bulb : ICONS.bulbOff, sentenceCase(label), m.on ? 'light-on' : m.na ? 'dim' : '') +
      '<button class="toggle ' + (m.on ? 'on' : '') + '" data-action="x-toggle" data-key="' + esc(key) + '" aria-label="' + esc(label) + '"' + dis + '>' +
        '<div class="toggle-knob"></div></button>' +
    '</div>';
  if (m.na) h += '<div class="slider-row"><div class="slider-label">Unavailable</div></div>';
  else if (m.on) {
    h += '<div class="slider-row inline-row">' +
      '<input type="range" class="slider" min="1" max="100" value="' + m.bri + '"' + rangeFillStyle(m.bri, 1, 100) +
        ' data-action="x-bri" data-key="' + esc(key) + '" aria-label="Brightness"' + dis + '>' +
      '<span class="inline-val">' + m.bri + '%</span></div>';
  }
  return h + '</div>';
}

/** An extra / item switch (or media player) row: its state and a power toggle. `m`: { na, on, stateText }. */
export function extraSwitchRowHtml(key, label, m, offline, icon) {
  const dis = offline || m.na ? ' disabled' : '';
  return '<div class="control-group" data-row="' + esc(key) + '">' +
    '<div class="control-header">' +
      sectionTitleHtml(icon || ICONS.plug, sentenceCase(label), m.on ? 'light-on' : m.na ? 'dim' : '') +
      '<span class="row-btns"><span class="status-sub">' + esc(m.stateText || (m.on ? 'On' : 'Off')) + '</span>' +
        '<button class="toggle ' + (m.on ? 'on' : '') + '" data-action="x-toggle" data-key="' + esc(key) + '" aria-label="' + esc(label) + '"' + dis + '>' +
        '<div class="toggle-knob"></div></button></span>' +
    '</div></div>';
}

/** An extra cover row: Close / Open and a position slider. `m`: { na, pct }. */
export function extraCoverRowHtml(key, label, m, offline) {
  const dis = offline || m.na ? ' disabled' : '';
  const pct = Math.round(m.pct || 0);
  return '<div class="control-group" data-row="' + esc(key) + '">' +
    '<div class="control-header">' +
      sectionTitleHtml(pct > 0 ? ICONS.curtains : ICONS.curtainsClosed, sentenceCase(label), m.na ? 'dim' : '') +
      '<span class="row-btns">' +
        '<button class="row-ib" data-action="x-cover-cmd" data-cmd="close" data-key="' + esc(key) + '" aria-label="Close" title="Close"' + dis + '>' + svgIcon(ICONS.cClose) + '</button>' +
        '<button class="row-ib" data-action="x-cover-cmd" data-cmd="open" data-key="' + esc(key) + '" aria-label="Open" title="Open"' + dis + '>' + svgIcon(ICONS.cOpen) + '</button>' +
      '</span></div>' +
    '<div class="slider-row"><div class="slider-label">' + (m.na ? 'Unavailable' : 'Open: ' + pct + '%') + '</div>' +
      '<input type="range" class="slider" min="0" max="100" value="' + pct + '"' + rangeFillStyle(pct, 0, 100) +
        ' data-action="x-cover-pos" data-key="' + esc(key) + '"' + dis + '></div>' +
  '</div>';
}

/** A cover's raw HA state -> { na, pct } for extraCoverRowHtml. */
export function coverRowModel(raw) {
  const st = raw ? raw.state : undefined;
  if (!st || st === 'unavailable' || st === 'unknown') return { na: true, pct: 0 };
  const p = raw.attributes ? raw.attributes.current_position : undefined;
  const pct = typeof p === 'number' && isFinite(p) ? p : st === 'closed' ? 0 : 100;
  return { na: false, pct: Math.max(0, Math.min(100, pct)) };
}
