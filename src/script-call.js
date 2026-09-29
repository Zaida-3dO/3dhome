/**
 * script-call.js -- running a Home Assistant script from a button, the one
 * guarded path every such button shares: the sidebar's room script ("Kill
 * room", src/room-script.js + index.html) and a furniture card's `actions`
 * row (src/item-cards.js + src/tap-popovers.js).
 *
 * A leaf module (no imports), DOM-free, unit-tested in node.
 *
 * THE CALL is `script.turn_on` with `variables`, targeting the script
 * entity: Home Assistant's documented way to pass variables to a script by
 * entity id, which starts the script WITHOUT waiting for it to finish (the
 * script's own service, `script.<name>`, would block until it completes).
 *
 * THE GUARD (sendScript): nothing unless the entity is a `script.*` id, the
 * client exists, and `writable()` says Home Assistant is connected -- then
 * the client's callService, whose own return value (false when the socket
 * is not authenticated) is the answer. Only ever called from a click: never
 * on render, never on a resync.
 */

export const SCRIPT_ID = /^script\.[a-z0-9_]+$/;

/** A plain object (the only shape `variables` may take). */
export const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** { entity, variables } -> the ONE service call it makes, or null. */
export function scriptCommand(binding) {
  if (!binding || typeof binding.entity !== 'string' || !SCRIPT_ID.test(binding.entity)) return null;
  return {
    domain: 'script',
    service: 'turn_on',
    data: { variables: { ...(binding.variables || {}) } },
    target: { entity_id: binding.entity }
  };
}

/**
 * Send it, guarded. `client` is the HA client (or null), `writable()` true
 * only while Home Assistant is connected.
 * @returns {boolean} true when the call went out
 */
export function sendScript(client, binding, writable) {
  if (!client || typeof client.callService !== 'function') return false;
  if (typeof writable === 'function' && !writable()) return false;
  const cmd = scriptCommand(binding);
  if (!cmd) return false;
  return client.callService(cmd.domain, cmd.service, cmd.data, cmd.target) === true;
}

export const ACTIVATION_KEYS = new Set(['Enter', ' ', 'Spacebar']);

/**
 * Which clicks on the button a real key press drove. `detail === 0` alone is
 * not enough: a screen reader in browse mode, a switch device and a scripted
 * el.click() all click with detail 0 and never send a key event, so treating
 * them as keyboard would arm the button and then refuse every confirm (the
 * release guard waits for a keyup that never comes).
 *
 *   keyDown(key)  an Enter / Space keydown ON the button (a held Enter's
 *                 auto-repeat keydowns included) -> the next click is keyed
 *   click(detail) -> true when that click is keyboard-driven; consumes it
 *   keyUp(key)    -> true for an Enter / Space release (the caller then
 *                 releases the confirm's guard); also ends the key's claim
 *   blur()        focus left: a keydown whose click never came is dropped
 *
 * Space activates on release, so its click follows its keyup and reads as a
 * plain press -- safe, because a held Space never auto-repeats a click.
 */
export function createKeyIntent() {
  let keyed = false;
  return {
    keyDown(key) { if (ACTIVATION_KEYS.has(key)) keyed = true; },
    click(detail) {
      const kb = keyed && detail === 0;
      keyed = false;
      return kb;
    },
    keyUp(key) {
      if (!ACTIVATION_KEYS.has(key)) return false;
      keyed = false;
      return true;
    },
    blur() { keyed = false; }
  };
}

/** An Enter / Space key (the keys that activate a button). */
export const isActivationKey = key => ACTIVATION_KEYS.has(key);

export const ACTION_RESULT_MS = 2500;

/**
 * A single-tap action button's state: 'idle' -> press -> 'sent' | 'failed'
 * -> (after resultMs) 'idle'. Not destructive, so no confirm step; but a
 * press while 'sent' is showing is ignored (a double tap is one launch).
 * A press while not writable() sends nothing and changes nothing (the
 * button is disabled then too). Timers are injectable for the tests.
 *
 * HELD KEY. A held Enter auto-repeats a click on a focused button every
 * ~30 ms, and the card keeps focus on the button across its redraws -- so
 * once "Sent" clears, the repeat would run the script again, every
 * resultMs, for as long as the key is down. So a press made from the
 * keyboard (`{ keyboard: true }`, from createKeyIntent) that SENDS (or
 * fails) blocks every further keyboard press until keyUp() -- a key
 * release anywhere. A pointer tap, a screen reader's or a switch device's
 * activation is a plain press and is not blocked (those never deliver a
 * keyup to wait for).
 */
export function createActionButton({ send, writable, onChange, resultMs = ACTION_RESULT_MS,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let state = 'idle';
  let timer = null;
  let keyHeld = false;   // a keyboard press went through; waiting for its release
  const set = next => { if (state === next) return; state = next; if (onChange) onChange(state); };
  return {
    get state() { return state; },
    press(opts) {
      const keyboard = !!(opts && opts.keyboard);
      if (keyboard && keyHeld) return false;
      if (state === 'sent') return false;
      if (typeof writable === 'function' && !writable()) return false;
      if (keyboard) keyHeld = true;
      const ok = send() === true;
      if (timer) clearTimer(timer);
      set(ok ? 'sent' : 'failed');
      timer = setTimer(() => { timer = null; set('idle'); }, resultMs);
      return ok;
    },
    /** An Enter / Space release: keyboard presses may send again. */
    keyUp() { keyHeld = false; },
    reset() {
      if (timer) { clearTimer(timer); timer = null; }
      set('idle');
    }
  };
}

/** What an action button says in each state. */
export function actionButtonText(label, state, sample) {
  if (state === 'sent') return sample ? 'Sent (sample)' : 'Sent';
  if (state === 'failed') return 'Not sent — try again';
  return label;
}
