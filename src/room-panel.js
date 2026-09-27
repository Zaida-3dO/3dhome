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

// ---- Row markup ------------------------------------------------------------
// Every row is one `.control-group` carrying `data-row="<key>"`, which is what
// lets index.html repaint ONE row in place when its entity reports, instead of
// rebuilding the whole panel.

export function doorRowHtml(door, status, showName) {
  const text = doorLabel(status);
  const cls = status === 'on' ? 'open' : status === 'off' ? 'closed' : 'unavailable';
  return `<div class="control-group status-row" data-row="door:${esc(door.id)}">
    <div class="control-header">
      <span class="status-text status-${cls}" data-status="door">${esc(text)}</span>
      ${showName ? `<span class="status-sub">${esc(door.name || door.id)}</span>` : ''}
    </div>
  </div>`;
}

export function motionRowHtml(status) {
  const cls = status === 'on' ? 'on' : status === 'off' ? 'off' : 'unavailable';
  return `<div class="control-group status-row" data-row="motion">
    <div class="control-header">
      <span class="control-label">MOTION</span>
      <span class="status-tag status-tag-${cls}" data-status="motion">${esc(motionLabel(status))}</span>
    </div>
  </div>`;
}

export function curtainRowHtml(cu, pct, available) {
  const shown = Math.round(pct);
  const dis = available ? '' : ' disabled';
  return `<div class="control-group" data-row="curtain:${esc(cu.id)}">
    <div class="control-header">
      <span class="control-label">${esc(String(cu.label).toUpperCase())}</span>
      <span class="row-btns">
        <button class="row-btn" data-action="curtain-cmd" data-cmd="open" data-curtain="${esc(cu.id)}"${dis}>Open</button>
        <button class="row-btn" data-action="curtain-cmd" data-cmd="close" data-curtain="${esc(cu.id)}"${dis}>Close</button>
      </span>
    </div>
    <div class="slider-row">
      <div class="slider-label">${available ? ('Open: ' + shown + '%') : 'Unavailable'}</div>
      <input type="range" class="slider" min="0" max="100" value="${shown}"
        data-action="curtain-open" data-curtain="${esc(cu.id)}"${dis}>
    </div>
  </div>`;
}

export function climateRowHtml(reading) {
  const v = climateView(reading);
  return `<div class="control-group" data-row="climate">
    <div class="control-header">
      <span class="control-label">TEMPERATURE</span>
      <span class="status-sub" data-status="climate-current">Now ${esc(v.current)}</span>
    </div>
    <div class="slider-row">
      <div class="slider-label">${v.status === 'Unavailable' ? 'Unavailable' : 'Target: ' + esc(v.target)}</div>
      <input type="range" class="slider" min="${v.min}" max="${v.max}" step="${v.step}" value="${v.value}"
        data-action="climate-target"${v.disabled ? ' disabled' : ''}>
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
 * Curtain SLIDER value -> command, refusing while the curtain is not
 * confirmed available -- the same rule the Open / Close buttons follow.
 * `coverPositionCommand` is HAClient.coverPositionCommand, injected so this
 * module stays free of the client.
 */
export function curtainSliderCommand(coverPositionCommand, pct, entities, available) {
  if (available !== true) return null;
  return coverPositionCommand(pct, entities);
}

export function createDragSender({ build, dispatch, cancel, onRelease, debounceMs = 200 }) {
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
      if (build(id, raw)) cmd = send(id, raw, 0);
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
      if (!cmd) return null;
      lastSent.delete(id);
      dispatch(cmd, id, 0);
      return cmd;
    }
  };
}
