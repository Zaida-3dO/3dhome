/**
 * preview-orbit.js -- the auto-rotating preview's rise and fall.
 *
 * The preview (?preview=true) orbits the house at a fixed, high pose. This
 * adds a repeating height cycle on top, azimuth untouched:
 *
 *   top hold -> slow descent -> eye-level lap -> slow ascent -> (repeat)
 *   1 lap       0.4 lap         1 lap            1/3 lap
 *
 * At eye level the camera stands OUTSIDE the house (beyond the circle that
 * encloses the footprint, so any azimuth clears the walls) at about 1.7 m,
 * looking at the house's mid-height. At the top the pose is exactly the
 * pre-existing one (cycle phase 0 == today's view), so the interactive
 * overview, which does not use this module, is unaffected.
 *
 * PURE: no DOM, no THREE. previewPose(t, g) is a function of elapsed seconds
 * only, so the phase is deterministic and testable. Tests:
 * scripts/test-preview-orbit.mjs.
 */

export const TOP_HOLD_LAPS = 1;
export const DESCENT_LAPS = 0.4;
export const LOW_HOLD_LAPS = 1;
export const ASCENT_LAPS = 1 / 3;
export const CYCLE_LAPS = TOP_HOLD_LAPS + DESCENT_LAPS + LOW_HOLD_LAPS + ASCENT_LAPS;
export const EYE_HEIGHT_M = 1.7;

export function smoothstep(x) {
  const u = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return u * u * (3 - 2 * u);
}

/** Eased "how far down" in [0,1] after `laps` laps into the cycle. */
export function lowness(laps) {
  const c = ((laps % CYCLE_LAPS) + CYCLE_LAPS) % CYCLE_LAPS;
  const a = TOP_HOLD_LAPS, b = a + DESCENT_LAPS, d = b + LOW_HOLD_LAPS;
  if (c < a) return 0;
  if (c < b) return smoothstep((c - a) / DESCENT_LAPS);
  if (c < d) return 1;
  return 1 - smoothstep((c - d) / ASCENT_LAPS);
}

/**
 * The eye-level horizontal radius: outside the footprint's enclosing circle
 * with a margin, and no nearer than 60% of the top view's horizontal reach so
 * the house still fits the frame.
 */
export function lowRadius(g) {
  return Math.max(g.halfDiag * 1.5 + 3, 0.6 * g.rTop * Math.sin(g.phTop));
}

/**
 * Orbit state {th, ph, r, tgtY} at `t` seconds. g:
 *   rotateSpeed rad/s, th0 start azimuth, rTop / phTop the top pose,
 *   halfDiag half the footprint diagonal (m), midY the house's mid-height (m),
 *   still: true holds the top pose (prefers-reduced-motion keeps today's
 *   behaviour: rotation only, no height change).
 */
export function previewPose(t, g) {
  // A zero / non-finite speed is "frozen" (?rotateSpeed=0): hold today's top
  // pose at the start azimuth. A negative speed spins the other way at the
  // same lap length.
  const speed = Number.isFinite(g.rotateSpeed) ? g.rotateSpeed : 0;
  const frozen = speed === 0 || !Number.isFinite(t);
  const lapSec = frozen ? Infinity : (2 * Math.PI) / Math.abs(speed);
  const e = g.still || frozen ? 0 : lowness(t / lapSec);
  const topH = g.rTop * Math.sin(g.phTop), topY = g.rTop * Math.cos(g.phTop);
  const h = topH + (lowRadius(g) - topH) * e;
  const y = topY + (EYE_HEIGHT_M - topY) * e;       // camera height above the ground
  const tgtY = g.midY * e;
  const dy = y - tgtY;
  return { th: frozen ? g.th0 : g.th0 + speed * t, ph: Math.atan2(h, dy), r: Math.hypot(h, dy), tgtY, camY: y, horiz: h };
}
