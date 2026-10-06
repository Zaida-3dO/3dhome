/**
 * tap-dispatch.js -- THE ONE CHOKE POINT for a tap on an interactive object.
 *
 * Every interactive thing in the scene (a light, a curtain, a radiator, a
 * vacuum, a plant, an item card, a clock, a speaker that opens the sound
 * menu, a door chip ...) is a ROUTE in one table, keyed by the tap target's
 * `kind`. A route only says what to OPEN; it never decides whether the
 * camera flies first. The dispatcher does that, for every route the same way:
 *
 *   tap -> focus(target, point) -- the camera flies to frame the item --
 *       -> the flight lands (or is cancelled, or reduced motion jumps)
 *       -> route.open(target, point, at)   ONLY if no newer tap, Escape,
 *                                          wheel or pointer down superseded it
 *
 * So a new kind of interactive furniture gets the zoom-to-item with no code of
 * its own: register `{ kind, open }` and it flies. Forgetting is impossible --
 * there is no flag to forget. Skipping the flight takes an EXPLICIT opt-out,
 * `{ focus: false, reason }`, and only for a kind listed in FOCUS_OPT_OUTS
 * below; defineTapRoutes throws on anything else. scripts/test-tap-focus-
 * contract.mjs pins that list, so a new opt-out is a visible diff in review.
 *
 * Focus switched off (Settings > "Camera follows selection", ?focus=0): the
 * page's focus() returns null and every route opens at once, as before.
 *
 * The page's tap handler (src/tap-popovers.js onClick) calls dispatch() and
 * nothing else that opens UI; the contract test fails on any other call site
 * of a card / modal opener.
 */

import { focusThenOpen } from './camera-focus.js';

/**
 * The ONLY kinds allowed to open without the camera flying first, and why.
 * Adding one here is a deliberate, reviewed decision (the contract test lists
 * this object verbatim).
 */
export const FOCUS_OPT_OUTS = Object.freeze({
  door: 'door chip: a one-line open/closed status read at a glance; flying the camera to a door frame would move the view for a chip with no controls (camera focus, PR #132)',
});

const ROUTE_KEYS = new Set(['kind', 'open', 'focus', 'reason', 'cover']);

/**
 * Validate a route list into the frozen table the dispatcher reads.
 *
 * A route: { kind, open(target, point, at), focus?: false, reason?, cover? }
 *   open    called by the dispatcher only, after the flight (never from a click)
 *   focus   omit it -- the default, and the only value besides `false`
 *   reason  required with focus: false, and the kind must be in FOCUS_OPT_OUTS
 *   cover   optional () => px: how much of the canvas's right edge the opened
 *           UI will cover (a modal docked to the side), so the flight frames
 *           the item in what is left visible
 * Throws on a duplicate kind, an unknown key, an undeclared opt-out.
 */
export function defineTapRoutes(list) {
  const out = new Map();
  (list || []).forEach(r => {
    if (!r || typeof r.kind !== 'string' || !r.kind) throw new Error('tap route: missing kind');
    if (typeof r.open !== 'function') throw new Error('tap route ' + r.kind + ': open must be a function');
    Object.keys(r).forEach(k => { if (!ROUTE_KEYS.has(k)) throw new Error('tap route ' + r.kind + ': unknown key "' + k + '"'); });
    if (out.has(r.kind)) throw new Error('tap route ' + r.kind + ': registered twice');
    if ('focus' in r && r.focus !== false) throw new Error('tap route ' + r.kind + ': focus may only be omitted or false');
    if (r.focus === false) {
      if (!Object.prototype.hasOwnProperty.call(FOCUS_OPT_OUTS, r.kind)) {
        throw new Error('tap route ' + r.kind + ': focus: false is not a declared opt-out (FOCUS_OPT_OUTS in src/tap-dispatch.js)');
      }
      if (typeof r.reason !== 'string' || !r.reason.trim()) throw new Error('tap route ' + r.kind + ': an opt-out needs a reason');
    }
    if (r.cover != null && typeof r.cover !== 'function') throw new Error('tap route ' + r.kind + ': cover must be a function');
    out.set(r.kind, Object.freeze({ kind: r.kind, open: r.open, focus: r.focus !== false, reason: r.reason || null, cover: r.cover || null }));
  });
  return out;
}

/**
 * @param o.routes     defineTapRoutes(...)
 * @param o.gate       camera-focus.js createFocusGate() -- one generation per tap
 * @param o.focus      OPTIONAL (target, point, frame) => Promise | null -- start
 *                     the flight (frame: { coverRight }); null = focus is off
 * @param o.onAbandon  OPTIONAL (target) => void -- a newer tap / Escape /
 *                     wheel superseded this one while it flew
 */
export function createTapDispatcher(o) {
  const routes = o.routes;
  let inFlight = 0;
  return {
    /**
     * Fly to the target, then open its route. `at` is the tap's client
     * position { x, y } (a route that cannot follow the item uses it).
     * Resolves true when the route opened. An unknown kind opens nothing.
     */
    dispatch(target, point, at) {
      const route = target && routes.get(target.kind);
      if (!route) return Promise.resolve(false);
      const cover = route.cover ? Math.max(0, +route.cover() || 0) : 0;
      const flight = route.focus && typeof o.focus === 'function' ? o.focus(target, point, { coverRight: cover }) : null;
      if (!flight) {
        o.gate.invalidate();   // an older tap still in the air must not open over this one
        route.open(target, point, Object.assign({ flew: false }, at));
        return Promise.resolve(true);
      }
      inFlight++;
      return focusThenOpen(o.gate, () => flight, () => route.open(target, point, Object.assign({ flew: true }, at)), () => {
        if (typeof o.onAbandon === 'function') { try { o.onAbandon(target); } catch (e) { /* ignore */ } }
      }).finally(() => { inFlight--; });
    },
    /** Taps whose flight has not resolved yet. */
    inFlight: () => inFlight,
    /** The registered kinds, and one route (read-only; tests). */
    kinds: () => [...routes.keys()],
    route: kind => routes.get(kind) || null,
  };
}
