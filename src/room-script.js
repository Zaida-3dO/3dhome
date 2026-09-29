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
import { SCRIPT_ID, scriptCommand, createKeyIntent } from './script-call.js';

// The key-intent tracker moved to script-call.js (a card's action buttons
// share it); re-exported so this module's callers keep one import.
export { createKeyIntent };

export const DEFAULT_ROOM_SCRIPT_LABEL = 'Kill room';
export const ARM_TIMEOUT_MS = 4000;
export const RESULT_MS = 2500;
export const MIN_ARM_MS = 400;
// Non-key activations: the repeat guard in createTwoStepConfirm.
export const BURST_WINDOW_MS = 1500;  // 3+ near-regular clicks inside this = a held repeat
export const BURST_GAP_MS = 1000;     // after a burst, ignore clicks until a pause this long
export const QUIET_MS = 500;          // a synthetic confirm waits this long for no further click


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
 * The two-step confirm. `send()` performs the call and returns true when it
 * went out (HAClient.callService's own return value). `writable()` false
 * (HA offline) makes a press disarm and send nothing -- a second gate behind
 * the disabled DOM. Timers and the clock are injectable for the tests.
 *
 * KEYBOARD. The button keeps its focus across states (index.html updates it
 * in place), so a HELD Enter would otherwise confirm: its auto-repeat fires a
 * click every ~30 ms once the repeat delay (250-500 ms, often past
 * minArmMs) has passed. So a press made from the keyboard (`{ keyboard:
 * true }` -- a click that a real Enter / Space keydown on the button drove,
 * see createKeyIntent) that ARMS also demands a key release: until keyUp()
 * is called, no keyboard press can confirm. A deliberate second press
 * (release, press again) confirms as usual. Every other click -- a pointer
 * tap, a screen reader's or switch device's synthetic activation, a scripted
 * el.click() -- is a plain press: it arms, and a second one past minArmMs
 * confirms. Those never deliver a keyup, so they must not wait for one.
 *
 * REPEAT GUARD (non-key clicks). An assistive-tech device may repeat its
 * activation while its switch is held, with no key event reaching the page:
 * the held-Enter hazard, for AT users. The page cannot see the switch, so
 * the guard reads the click cadence instead:
 *   - 3+ non-key clicks inside burstWindowMs (1.5 s) whose last two gaps are
 *     within 2x of each other is a held repeat: the arm is CANCELLED (back
 *     to idle) and every click is refused until a pause of burstGapMs (1 s)
 *     with no click at all.
 *   - A synthetic confirm (detail 0, no key) does not send at once: it waits
 *     quietMs (0.5 s), and any click inside that window is a repeat -- the
 *     confirm is cancelled and the burst lock applies. That catches a repeat
 *     whose first auto-repeat comes after a delay longer than minArmMs,
 *     which the cadence rule alone would let confirm.
 * A deliberate pair (arm, then one more press 0.4-4 s later) still confirms.
 * Pointer confirms stay immediate; pointer taps are still counted for bursts.
 * NOT covered: a device repeating slower than quietMs, or one that emulates
 * a pointer (detail >= 1) with a long initial delay. Neither has been
 * verified against real hardware.
 */
export function createTwoStepConfirm({
  send, writable, onChange,
  timeoutMs = ARM_TIMEOUT_MS, resultMs = RESULT_MS, minArmMs = MIN_ARM_MS,
  burstWindowMs = BURST_WINDOW_MS, burstGapMs = BURST_GAP_MS, quietMs = QUIET_MS,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout
}) {
  let state = 'idle';
  let armedAt = 0;
  let timer = null;
  let awaitKeyUp = false;
  // Repeat guard (non-key activations only).
  let clicks = [];          // recent non-key click times, inside burstWindowMs
  let lastClickAt = -Infinity;
  let locked = false;       // a burst was seen: refuse until a burstGapMs pause
  let pending = false;      // a synthetic confirm waiting out quietMs
  const canWrite = () => typeof writable !== 'function' || writable() === true;

  function go(next, afterMs) {
    if (timer !== null) { clearTimer(timer); timer = null; }
    pending = false;
    const changed = next !== state;
    state = next;
    if (next !== 'armed') awaitKeyUp = false;
    if (afterMs > 0) timer = setTimer(() => { timer = null; go('idle', 0); }, afterMs);
    if (changed && typeof onChange === 'function') onChange(state);
  }

  function fire() {
    if (!canWrite()) { go('idle', 0); return false; }
    let ok = false;
    try { ok = send() === true; } catch (e) { ok = false; }
    go(ok ? 'sent' : 'failed', resultMs);
    return ok;
  }

  // Three or more clicks inside burstWindowMs whose last two gaps are within
  // 2x of each other: the cadence of a held, auto-repeating activation.
  function isBurst() {
    if (clicks.length < 3) return false;
    const n = clicks.length;
    const a = clicks[n - 2] - clicks[n - 3], b = clicks[n - 1] - clicks[n - 2];
    return Math.max(a, b) <= 2 * Math.max(1, Math.min(a, b));
  }

  function burst() {
    locked = true;
    clicks = [];
    go('idle', 0);
  }

  return {
    get state() { return state; },
    /**
     * A click. `opts.keyboard`: a real Enter / Space drove it (createKeyIntent).
     * `opts.synthetic`: no key and no pointer drove it (detail 0) -- a screen
     * reader, a switch device, el.click(). Returns true only on a press that
     * sent the call at once (a synthetic confirm sends after quietMs).
     */
    press(opts) {
      const keyboard = !!(opts && opts.keyboard);
      const synthetic = !keyboard && !!(opts && opts.synthetic);
      if (!canWrite()) { go('idle', 0); return false; }
      if (!keyboard) {
        const t = now();
        const sinceLast = t - lastClickAt;
        lastClickAt = t;
        if (locked) {
          if (sinceLast < burstGapMs) return false;   // the repeat is still going
          locked = false;
        }
        clicks = clicks.filter(c => t - c <= burstWindowMs);
        clicks.push(t);
        if (pending) { burst(); return false; }       // a click inside the quiet window
        if (isBurst()) { burst(); return false; }
      }
      if (state !== 'armed') {
        armedAt = now();
        go('armed', timeoutMs);
        awaitKeyUp = keyboard;
        return false;
      }
      if (pending) return false;                      // (a key press while a synthetic confirm waits)
      if (now() - armedAt < minArmMs) return false;   // one gesture, not a confirm
      if (keyboard && awaitKeyUp) return false;       // the arming key is still held
      if (synthetic) {
        // Wait for quiet: a held switch's NEXT repeat lands inside quietMs
        // and cancels this (above) instead of it having confirmed.
        if (timer !== null) { clearTimer(timer); timer = null; }
        pending = true;
        timer = setTimer(() => { timer = null; if (pending) fire(); }, quietMs);
        return false;
      }
      return fire();
    },
    /** A key was released on the button: the next keyboard press is fresh. */
    keyUp() { awaitKeyUp = false; },
    /** Back to idle, no send (HA went offline, the room was left, the panel
     *  closed). Also clears the repeat guard. */
    reset() { locked = false; clicks = []; go('idle', 0); },
    /** Tear down: a full, SILENT reset (no onChange -- the row may already
     *  be gone). Drops any pending synthetic confirm, so nothing is ever
     *  sent by a timer set before this, and leaves no stale state behind to
     *  swallow the next press if the controller is used again. */
    dispose() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      pending = false;
      awaitKeyUp = false;
      locked = false;
      clicks = [];
      state = 'idle';
    }
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
 * Everything the row shows, for the markup below AND for index.html's
 * in-place update (which keeps the button element, and so its keyboard
 * focus, across states). `haState`: 'none' (no Home Assistant configured --
 * nothing to run it on), 'offline', or 'ok'. Disabled unless 'ok'.
 *
 *   state     the state painted ('idle' whenever HA is not ok)
 *   text      the button's text
 *   disabled  the button's disabled flag
 *   note      the small line under it ('' for none)
 *   live      what the persistent role="status" region announces
 */
export function roomScriptView(binding, state, haState) {
  const ok = haState === 'ok';
  const st = ok ? (state || 'idle') : 'idle';
  const note = haState === 'none' ? 'Needs Home Assistant'
    : haState === 'offline' ? 'Unavailable while Home Assistant is offline'
    : st === 'armed' ? 'Switches off this room’s lights and devices' : '';
  const text = roomScriptButtonText(binding.label, st);
  const live = st === 'armed' ? 'Armed. Press again to confirm: ' + text.replace(/^Tap again to /, '') + '.'
    : st === 'sent' ? 'Sent.'
    : st === 'failed' ? 'Not sent. Try again.'
    : '';
  return { state: st, text, disabled: !ok, note, live };
}

/**
 * The row. The announcement lives in its own role="status" element, which
 * stays in the DOM while the button changes state (a live region must exist
 * before its content changes to be announced).
 */
export function roomScriptRowHtml(binding, state, haState) {
  const v = roomScriptView(binding, state, haState);
  return `<div class="control-group room-script-row" data-row="room-script">
    <button class="room-script-btn ${esc(v.state)}" data-action="room-script" data-state="${esc(v.state)}"${v.disabled ? ' disabled' : ''}>${esc(v.text)}</button>
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
  const btn = row && row.querySelector('[data-action="room-script"]');
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
