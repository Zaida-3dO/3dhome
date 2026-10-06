/**
 * Room script button -- the DOM-free half (rooms.json `sensors.roomScripts`).
 *
 * A room bound here gets ONE button at the foot of its sidebar view that runs
 * a Home Assistant script for that room -- typically a "shut down room" script
 * that switches the room's lights, curtains and TVs off. Because that is
 * destructive and a mis-tap would plunge a room into darkness, pressing the
 * button never sends: it opens an explicit "Are you sure?" dialog (title,
 * description, Cancel and a destructive confirm button). Only the dialog's
 * confirm button sends, and it sends exactly once (createConfirmDialog).
 * The row itself then shows Sent / Not sent for a moment (createActionButton,
 * src/script-call.js), which also refuses a second press while it says Sent.
 *
 * Nothing here touches `document`, so the dialog state machine, the copy and
 * the service-call mapping are tested in plain node
 * (scripts/test-room-script.mjs). index.html owns the elements and sends ONLY
 * from the dialog's confirm handler -- nothing is ever sent on render or on a
 * Home Assistant resync.
 *
 * The call is `script.turn_on` with `variables`, targeting the script entity.
 * That is Home Assistant's documented way to pass variables to a script by
 * entity id, and it starts the script WITHOUT waiting for it to finish (the
 * script's own service, `script.<name>`, would block the call until the
 * script completes). The same script can therefore be bound to several rooms,
 * each with its own variables, and several rooms may share identical
 * variables.
 */

import { esc } from './room-panel.js';
import { SCRIPT_ID, scriptCommand } from './script-call.js';

export const DEFAULT_ROOM_SCRIPT_LABEL = 'Shut down room';
/** What the dialog says a default-labelled room script does. */
export const DEFAULT_ROOM_SCRIPT_DESCRIPTION = 'Switches off this room’s lights and devices';

/**
 * rooms.json `sensors.roomScripts` -> Map roomId -> { entity, variables, label }.
 * An entry whose entity is not a `script.*` id, or whose `variables` is not a
 * plain object, is dropped with no button (the validator reports it; the
 * engine never calls a service on something it cannot vouch for).
 */
export function normaliseRoomScripts(raw) {
  const out = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  Object.entries(raw).forEach(([roomId, b]) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return;
    if (typeof b.entity !== 'string' || !SCRIPT_ID.test(b.entity)) return;
    const v = b.variables;
    if (v !== undefined && (v === null || typeof v !== 'object' || Array.isArray(v))) return;
    const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim() : DEFAULT_ROOM_SCRIPT_LABEL;
    out.set(roomId, { entity: b.entity, variables: v ? { ...v } : {}, label });
  });
  return out;
}

/** A binding -> the ONE service call it makes (script-call.js's, shared). */
export function roomScriptCommand(binding) {
  return scriptCommand(binding);
}

/**
 * The "Are you sure?" dialog's state machine. `request(ctx)` opens it for one
 * pending action (`ctx` is whatever the caller needs to run it) and returns
 * true, or false (nothing opens) when `writable()` says Home Assistant is not
 * connected. `confirm()` closes it and hands the ctx to `onConfirm(ctx)`
 * EXACTLY ONCE: the pending ctx is cleared before onConfirm runs, so a double
 * tap, a held Enter's auto-repeat or a re-entrant call from onConfirm itself
 * finds nothing pending and sends nothing. `cancel()` closes it, no send. If
 * Home Assistant went offline while it was open, confirm() closes without
 * sending. `onChange(ctx|null)` is told each time it opens or closes.
 */
export function createConfirmDialog({ onConfirm, writable, onChange }) {
  let pending = null;
  const canWrite = () => typeof writable !== 'function' || writable() === true;
  const changed = () => { if (typeof onChange === 'function') onChange(pending); };
  return {
    get pending() { return pending; },
    get isOpen() { return pending !== null; },
    request(ctx) {
      if (pending !== null || !canWrite()) return false;
      pending = ctx;
      changed();
      return true;
    },
    cancel() {
      if (pending === null) return false;
      pending = null;
      changed();
      return true;
    },
    confirm() {
      if (pending === null) return false;
      const ctx = pending;
      pending = null;
      changed();
      if (!canWrite()) return false;
      onConfirm(ctx);
      return true;
    }
  };
}

/**
 * The dialog's copy for one script row. `isRoomScript`: the room's own
 * `roomScripts` button (a default label reads "Shut down <room>?" and carries
 * the standard description); an `extra` script row uses its OWN label, never
 * the shut-down text. `description` is an optional per-row override.
 */
export function confirmDialogCopy(binding, roomName, isRoomScript) {
  const label = (binding && binding.label) || DEFAULT_ROOM_SCRIPT_LABEL;
  const room = roomName || 'this room';
  const isDefault = isRoomScript && label === DEFAULT_ROOM_SCRIPT_LABEL;
  const desc = binding && typeof binding.description === 'string' && binding.description.trim();
  return {
    title: isDefault ? 'Shut down ' + room + '?' : label + ' in ' + room + '?',
    body: desc || (isDefault ? DEFAULT_ROOM_SCRIPT_DESCRIPTION : 'Runs “' + label + '” for ' + room + '.'),
    confirmText: label,
    cancelText: 'Cancel'
  };
}

/** What the button says in each state. */
export function roomScriptButtonText(label, state) {
  if (state === 'sent') return 'Sent';
  if (state === 'failed') return 'Not sent — try again';
  return label;
}

/**
 * Everything the row shows, for the markup below AND for index.html's
 * in-place update (which keeps the button element, and so its keyboard
 * focus, across states). `haState`: 'none' (no Home Assistant configured --
 * nothing to run it on), 'offline', or 'ok'. Disabled unless 'ok'.
 * States: idle | sent | failed (the confirmation lives in the dialog).
 *
 *   state     the state painted ('idle' whenever HA is not ok)
 *   text      the button's text
 *   disabled  the button's disabled flag
 *   note      the small line under it ('' for none)
 *   live      what the persistent role="status" region announces
 */
export function roomScriptView(binding, state, haState) {
  const ok = haState === 'ok';
  const st = ok && (state === 'sent' || state === 'failed') ? state : 'idle';
  const note = haState === 'none' ? 'Needs Home Assistant'
    : haState === 'offline' ? 'Unavailable while Home Assistant is offline' : '';
  const text = roomScriptButtonText(binding.label, st);
  const live = st === 'sent' ? 'Sent.' : st === 'failed' ? 'Not sent. Try again.' : '';
  return { state: st, text, disabled: !ok, note, live };
}

/**
 * The row. The announcement lives in its own role="status" element, which
 * stays in the DOM while the button changes state (a live region must exist
 * before its content changes to be announced).
 */
export function roomScriptRowHtml(binding, state, haState, opts) {
  const v = roomScriptView(binding, state, haState);
  // A sidebar `extra` script row (rooms.json 1.11) is this same row under
  // its own key ('extra:<n>') and action ('x-script'); see index.html.
  const rowKey = (opts && opts.rowKey) || 'room-script';
  const action = (opts && opts.action) || 'room-script';
  return `<div class="control-group room-script-row" data-row="${esc(rowKey)}">
    <button class="room-script-btn ${esc(v.state)}" data-action="${esc(action)}" data-key="${esc(rowKey)}" data-state="${esc(v.state)}"${v.disabled ? ' disabled' : ''}>${esc(v.text)}</button>
    <div class="room-script-note"${v.note ? '' : ' hidden'}>${esc(v.note)}</div>
    <div class="sr-only" role="status" aria-live="polite" data-room-script-live></div>
  </div>`;
}

/**
 * Update a painted row in place to `view` (roomScriptView). Returns false
 * when `row` does not have the expected parts, so the caller can repaint it
 * instead. DOM-light: only textContent / className / attributes.
 */
export function applyRoomScriptView(row, view) {
  const btn = row && (row.querySelector('[data-action="room-script"]') || row.querySelector('[data-action="x-script"]'));
  const note = row && row.querySelector('.room-script-note');
  const live = row && row.querySelector('[data-room-script-live]');
  if (!btn || !note || !live) return false;
  btn.className = 'room-script-btn ' + view.state;
  btn.setAttribute('data-state', view.state);
  btn.textContent = view.text;
  btn.disabled = view.disabled;
  note.textContent = view.note;
  note.hidden = !view.note;
  live.textContent = view.live;
  return true;
}
