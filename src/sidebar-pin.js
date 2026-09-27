/**
 * sidebar-pin.js -- the room sidebar's open / pinned state machine. Pure:
 * index.html feeds it events and applies the result; unit-tested in
 * scripts/test-sidebar-pin.mjs.
 *
 * Only where the sidebar is COLLAPSIBLE (narrower than the wide breakpoint
 * in index.html). On a wide layout the panel is always open and there is no
 * pin: every event leaves it open.
 *
 *   state  { open: boolean, pinned: boolean }
 *
 *   'controls'     the Controls button            -> open, PINNED
 *   'roomTap'      a room tapped in the 3D view   -> closed: open UNPINNED;
 *                                                    open: stays, pin unchanged
 *                                                    (the room switches)
 *   'close'        the sidebar's X                -> closed
 *   'togglePin'    the pin button                 -> open: flip pinned
 *   'background'   tap on empty canvas            -> unpinned: close
 *   'objectTap'    tap on a controllable object   -> unpinned: close (its
 *                                                    popover still opens)
 *   'scroll'       page scroll                    -> unpinned: close
 *   'cameraStart'  orbit / pan / zoom begins      -> unpinned: close
 *
 * Pin state is not persisted: a reload starts closed and unpinned.
 */

export const SIDEBAR_INITIAL = Object.freeze({ open: false, pinned: false });

const AUTO_CLOSE = new Set(['background', 'objectTap', 'scroll', 'cameraStart']);

export const SIDEBAR_EVENTS = Object.freeze(['controls', 'roomTap', 'close', 'togglePin', ...AUTO_CLOSE]);

/**
 * @param state  { open, pinned }
 * @param event  one of SIDEBAR_EVENTS
 * @param opts   { collapsible: boolean } -- false on the wide layout
 * @returns the next state (a new object; `state` is never mutated)
 */
export function sidebarReduce(state, event, opts) {
  const s = state || SIDEBAR_INITIAL;
  const collapsible = !opts || opts.collapsible !== false;
  if (!collapsible) return { open: true, pinned: true };
  switch (event) {
    case 'controls': return { open: true, pinned: true };
    case 'roomTap': return s.open ? { open: true, pinned: !!s.pinned } : { open: true, pinned: false };
    case 'close': return { open: false, pinned: false };
    case 'togglePin': return s.open ? { open: true, pinned: !s.pinned } : { open: false, pinned: false };
    default:
      if (AUTO_CLOSE.has(event)) return s.open && !s.pinned ? { open: false, pinned: false } : { open: !!s.open, pinned: !!s.pinned };
      return { open: !!s.open, pinned: !!s.pinned };
  }
}
