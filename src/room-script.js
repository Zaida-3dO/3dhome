/**
 * Room script button -- the DOM-free half (rooms.json `sensors.roomScripts`).
 *
 * A room bound here gets ONE button at the foot of its sidebar view that runs
 * a Home Assistant script for that room -- typically a "kill room" script that
 * switches the room's lights, curtains and TVs off. Because that is
 * destructive and a mis-tap would plunge a room into darkness, the button is
 * a TWO-STEP confirm:
 *
 *   idle  --press-->  armed ("Tap again to ...")  --press-->  sent | failed
 *     ^                  |  (after timeoutMs, untouched)          |
 *     +------------------+----------------------------------------+ (after resultMs)
 *
 * A second press that lands within minArmMs of the first is ignored (the
 * button stays armed): a double-tap or a bounced click is ONE gesture, and
 * must not arm and confirm in one go.
 *
 * Nothing here touches `document`, so the state machine and the service-call
 * mapping are tested in plain node (scripts/test-room-script.mjs). index.html
 * owns the element and calls press() from the click handler ONLY -- nothing
 * is ever sent on render or on a Home Assistant resync.
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

export const DEFAULT_ROOM_SCRIPT_LABEL = 'Kill room';
export const ARM_TIMEOUT_MS = 4000;
export const RESULT_MS = 2500;
export const MIN_ARM_MS = 400;

const SCRIPT_ID = /^script\.[a-z0-9_]+$/;

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

/** A binding -> the ONE service call it makes. */
export function roomScriptCommand(binding) {
  if (!binding || typeof binding.entity !== 'string' || !SCRIPT_ID.test(binding.entity)) return null;
  return {
    domain: 'script',
    service: 'turn_on',
    data: { variables: { ...(binding.variables || {}) } },
    target: { entity_id: binding.entity }
  };
}

/**
 * The two-step confirm. `send()` performs the call and returns true when it
 * went out (HAClient.callService's own return value). `writable()` false
 * (HA offline) makes a press disarm and send nothing -- a second gate behind
 * the disabled DOM. Timers and the clock are injectable for the tests.
 */
export function createTwoStepConfirm({
  send, writable, onChange,
  timeoutMs = ARM_TIMEOUT_MS, resultMs = RESULT_MS, minArmMs = MIN_ARM_MS,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout
}) {
  let state = 'idle';
  let armedAt = 0;
  let timer = null;
  const canWrite = () => typeof writable !== 'function' || writable() === true;

  function go(next, afterMs) {
    if (timer !== null) { clearTimer(timer); timer = null; }
    const changed = next !== state;
    state = next;
    if (afterMs > 0) timer = setTimer(() => { timer = null; go('idle', 0); }, afterMs);
    if (changed && typeof onChange === 'function') onChange(state);
  }

  return {
    get state() { return state; },
    /** A click. Returns true only on the press that sent the call. */
    press() {
      if (!canWrite()) { go('idle', 0); return false; }
      if (state !== 'armed') {
        armedAt = now();
        go('armed', timeoutMs);
        return false;
      }
      if (now() - armedAt < minArmMs) return false; // one gesture, not a confirm
      let ok = false;
      try { ok = send() === true; } catch (e) { ok = false; }
      go(ok ? 'sent' : 'failed', resultMs);
      return ok;
    },
    /** Back to idle, no send (HA went offline, the room was left). */
    reset() { go('idle', 0); },
    dispose() { if (timer !== null) { clearTimer(timer); timer = null; } }
  };
}

/** What the button says in each state. */
export function roomScriptButtonText(label, state) {
  if (state === 'armed') return 'Tap again to ' + label.charAt(0).toLowerCase() + label.slice(1);
  if (state === 'sent') return 'Sent';
  if (state === 'failed') return 'Not sent — try again';
  return label;
}

/**
 * The row. `haState`: 'none' (no Home Assistant configured -- nothing to run
 * it on), 'offline', or 'ok'. Disabled unless 'ok'.
 */
export function roomScriptRowHtml(binding, state, haState) {
  const st = haState === 'ok' ? (state || 'idle') : 'idle';
  const dis = haState === 'ok' ? '' : ' disabled';
  const note = haState === 'none' ? 'Needs Home Assistant'
    : haState === 'offline' ? 'Unavailable while Home Assistant is offline'
    : st === 'armed' ? 'Switches off this room’s lights and devices' : '';
  return `<div class="control-group room-script-row" data-row="room-script">
    <button class="room-script-btn ${esc(st)}" data-action="room-script" data-state="${esc(st)}"
      aria-live="polite"${dis}>${esc(roomScriptButtonText(binding.label, st))}</button>
    ${note ? `<div class="room-script-note">${esc(note)}</div>` : ''}
  </div>`;
}
