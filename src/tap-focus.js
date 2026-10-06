/**
 * tap-focus.js -- the PAGE half of "every interactive tap flies first": the
 * focus function src/tap-dispatch.js calls, and the device view it flies to.
 *
 * Kept out of index.html so scripts/test-tap-focus-contract.mjs can run the
 * exact code the page runs: for every routed kind it proves that a tap
 * requests a device, the focus controller resolves a view for it, and a
 * flight starts. index.html only wires these in (the contract test pins the
 * wiring lines verbatim), so neither a kind check in the page's focus
 * function nor a `return null` for a kind in the view resolver can skip the
 * zoom with the tests green.
 *
 * The ONLY reason createTapFocus returns null is "focus is off" (Settings >
 * "Camera follows selection", ?focus=0). There is no per-kind exit here: a
 * kind that must not fly is a declared opt-out in tap-dispatch.js.
 */

/**
 * The focus function handed to the tap dispatcher.
 * @param o.on    () => bool -- camera focus is switched on
 * @param o.ctl   camera-focus.js createFocusController()
 * @returns (target, point, frame) => Promise | null
 */
export function createTapFocus(o) {
  return function tapFocus(target, point, frame) {
    if (!o.on()) return null;
    const dev = Object.assign({}, target, {
      focusPoint: point && point.clone ? point.clone() : point,
      coverRight: (frame && frame.coverRight) || 0,
    });
    o.ctl.request({ device: dev }, 'explicit');
    return o.ctl.flushNow();
  };
}

/**
 * The pose a tapped device is framed from.
 *
 * A curtain by its own geometry; a light fixture round the fixture; anything
 * else by its own furniture item when it names one (a vacuum, a plant or a
 * clock by id, an item card / radiator / speaker by itemId), else the item
 * whose box holds the tapped point. Whatever the kind, a view that comes
 * back null FALLS BACK to the tapped point (pointView): it never skips the
 * flight. Null only with no point and nothing to frame by id.
 *
 * @param d      the device selection: the tap target plus focusPoint, coverRight
 * @param home   the scene (curtainView, pointView, itemView, furnitureBox, furnitureItemAt)
 * @param inset  { right, width, height } -- what covers the right of the canvas
 */
export function deviceView(d, home, inset) {
  const pt = d.focusPoint || null;
  // The UI the tap opens may cover the right of the canvas too (the sound
  // menu docked beside its speaker): frame the item in what is left.
  const ins = d.coverRight > ((inset && inset.right) || 0) ? Object.assign({}, inset, { right: d.coverRight }) : inset;
  let v = null;
  if (d.kind === 'curtain') v = home.curtainView(d.id, { inset: ins });
  else if (d.kind === 'light') v = pt ? home.pointView(pt, { inset: ins, room: d.roomId }) : null;
  else {
    const ownId = d.itemId || d.id;
    if (ownId && typeof home.furnitureBox === 'function' && home.furnitureBox(ownId)) v = home.itemView(ownId, pt, { inset: ins });
    if (!v) {
      const it = pt && typeof home.furnitureItemAt === 'function' ? home.furnitureItemAt(pt) : null;
      if (it) v = home.itemView(it.id, pt, { inset: ins });
    }
  }
  if (!v && pt) v = home.pointView(pt, { inset: ins });
  return v || null;
}
