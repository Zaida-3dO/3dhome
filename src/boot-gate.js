/**
 * boot-gate.js -- "is the house visually complete yet?", for the cold-start
 * loading overlay. Pure: no three.js, no DOM, timers injected. Driven by
 * src/home3d-scene.js (create(): the onFurnished option) and unit-tested in
 * scripts/test-boot-gate.mjs.
 *
 * WHY. The overlay used to come down on onReady -- the house's own shader
 * precompile -- and the furniture was built, compiled and attached AFTER
 * that, so every load showed an empty house that furnished itself a second
 * or more later (owner request, 2026-10-06: "the loading screens should not go away
 * until the app is fully ready"). This gate is the "fully ready" signal:
 *
 *   1. every named wait has settled -- resolved OR rejected; a failure is
 *      not a reason to keep the overlay up (the house renders without the
 *      thing that failed, exactly as it did before), and
 *   2. AFTER that, one frame has actually been drawn (frameRendered()), so
 *      what the overlay reveals is the finished picture, not the frame
 *      before it.
 *
 * Or the timeout fires first: a slow or hung asset must never hold the
 * overlay forever. The timeout runs from startTimeout(), not from creation,
 * so the scene can start it once the house itself is drawable (the house
 * precompile has its own fallback).
 *
 * Single-shot: onDone is called exactly once (or never, after cancel()).
 *
 *   const gate = createBootGate({ onDone, requestFrame, setTimer, clearTimer, now });
 *   gate.wait('house', promise); gate.wait('furniture', promise); ...
 *   gate.seal();                 // no more waits; may complete from here on
 *   gate.startTimeout(15000);
 *   ...render loop, after each drawn frame: gate.frameRendered();
 *
 * onDone({ timedOut, pending, ms }): `pending` names the waits still open
 * when it timed out (empty otherwise); `ms` is now() since creation.
 */

export function createBootGate(opts) {
  const o = opts || {};
  const setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer || (t => clearTimeout(t));
  const now = o.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const t0 = now();
  const pending = new Set();
  let sealed = false;
  let awaitingFrame = false;
  let done = false;
  let timer = null;

  function finish(timedOut) {
    if (done) return;
    done = true;
    awaitingFrame = false;
    if (timer !== null) { clearTimer(timer); timer = null; }
    const info = { timedOut: !!timedOut, pending: [...pending], ms: now() - t0 };
    if (typeof o.onDone === 'function') {
      try { o.onDone(info); } catch (e) { /* a caller's callback must not break the scene */ }
    }
  }

  function check() {
    if (done || !sealed || awaitingFrame || pending.size) return;
    // Everything has settled: the NEXT drawn frame is the complete one.
    awaitingFrame = true;
    if (typeof o.requestFrame === 'function') o.requestFrame();
  }

  return {
    /** Hold the gate until `promise` settles (either way). Ignored once sealed. */
    wait(name, promise) {
      if (done || sealed) return;
      pending.add(name);
      Promise.resolve(promise).then(() => {}, () => {}).then(() => {
        pending.delete(name);
        check();
      });
    },
    /** No more waits will be added; the gate may now complete. */
    seal() {
      sealed = true;
      check();
    },
    /** Arm the fallback: after `ms`, complete anyway (timedOut: true). Once. */
    startTimeout(ms) {
      if (done || timer !== null) return;
      timer = setTimer(() => { timer = null; finish(true); }, ms);
    },
    /** Call after every drawn frame. Completes the gate once it is waiting for one. */
    frameRendered() {
      if (awaitingFrame) finish(false);
    },
    /** Stop without ever calling onDone (the scene was disposed). */
    cancel() {
      done = true;
      awaitingFrame = false;
      if (timer !== null) { clearTimer(timer); timer = null; }
    },
    isDone() { return done; },
    pending() { return [...pending]; }
  };
}
