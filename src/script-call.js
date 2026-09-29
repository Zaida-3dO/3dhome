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

export const ACTION_RESULT_MS = 2500;

/**
 * A single-tap action button's state: 'idle' -> press -> 'sent' | 'failed'
 * -> (after resultMs) 'idle'. Not destructive, so no confirm step; but a
 * press while 'sent' is showing is ignored (a double tap is one launch).
 * A press while not writable() sends nothing and changes nothing (the
 * button is disabled then too). Timers are injectable for the tests.
 */
export function createActionButton({ send, writable, onChange, resultMs = ACTION_RESULT_MS,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let state = 'idle';
  let timer = null;
  const set = next => { if (state === next) return; state = next; if (onChange) onChange(state); };
  return {
    get state() { return state; },
    press() {
      if (state === 'sent') return false;
      if (typeof writable === 'function' && !writable()) return false;
      const ok = send() === true;
      if (timer) clearTimer(timer);
      set(ok ? 'sent' : 'failed');
      timer = setTimer(() => { timer = null; set('idle'); }, resultMs);
      return ok;
    },
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
