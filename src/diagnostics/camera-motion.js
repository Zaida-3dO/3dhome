/**
 * camera-motion.js - the benchmark's scripted camera moves, as pure functions
 * of time (item 112ec00c).
 *
 * Every move is a function of SECONDS SINCE THE STAGE STARTED and the scene's
 * home orbit, and nothing else -- no frame counter, no dt accumulation. So a
 * slow device that draws 20 frames a second and a fast one that draws 120 see
 * the camera in the same place at the same time, and the load each stage puts
 * on the GPU is identical in kind on every device. (A dt-accumulating script
 * would move a slow device's camera LESS per second, flattering it.)
 *
 * Speeds are in radians/second (orbit) and house-footprint fractions (pan),
 * so a big house and a small one are exercised proportionally.
 *
 * Pure ESM, no DOM, no THREE: scripts/test-diagnostics-motion.mjs drives it.
 */

/** name -> human description; the order is the order stages run in. */
export const MOTIONS = Object.freeze({
  idle: 'static camera at the home view, drawing every frame',
  'orbit-slow': 'orbit at 0.25 rad/s (about 25 s per turn)',
  'orbit-fast': 'orbit at 1.5 rad/s (about 4 s per turn)',
  pan: 'pan the target over +/-30% of the footprint (Lissajous, 4 s x 3 s periods)',
  zoom: 'dolly between 0.55x and 1.35x the home distance (3 s period)',
  'swipe-burst': 'repeated flicks: 0.25 s at up to 5 rad/s with ease-out, 0.35 s rest, alternating direction'
});

export const SLOW_ORBIT_RAD_S = 0.25;
export const FAST_ORBIT_RAD_S = 1.5;
const TAU = Math.PI * 2;

/**
 * The orbit pose at time t (seconds) for a move.
 *
 * @param {string} kind   a key of MOTIONS
 * @param {number} t      seconds since the move started (>= 0)
 * @param {{th:number, ph:number, r:number, target:number[]}} home
 * @param {{width:number, depth:number}} [fp]  footprint in metres (pan only)
 * @returns {{th:number, ph:number, r:number, target:number[]}}
 */
export function motionPose(kind, t, home, fp) {
  const tt = Math.max(0, +t || 0);
  const tgt = home.target.slice();
  switch (kind) {
    case 'orbit-slow':
      return { th: home.th + SLOW_ORBIT_RAD_S * tt, ph: home.ph, r: home.r, target: tgt };
    case 'orbit-fast':
      return { th: home.th + FAST_ORBIT_RAD_S * tt, ph: home.ph, r: home.r, target: tgt };
    case 'pan': {
      const w = fp && fp.width > 0 ? fp.width : 10;
      const d = fp && fp.depth > 0 ? fp.depth : 10;
      tgt[0] += 0.3 * w * Math.sin(TAU * tt / 4);
      tgt[2] += 0.3 * d * Math.sin(TAU * tt / 3);
      return { th: home.th, ph: home.ph, r: home.r, target: tgt };
    }
    case 'zoom': {
      // 0.95 +/- 0.4 -> 0.55 .. 1.35
      const k = 0.95 + 0.4 * Math.sin(TAU * tt / 3);
      return { th: home.th, ph: home.ph, r: home.r * k, target: tgt };
    }
    case 'swipe-burst':
      return { th: home.th + swipeAngle(tt), ph: home.ph + 0.08 * Math.sin(TAU * tt / 2.4), r: home.r, target: tgt };
    case 'idle':
    default:
      return { th: home.th, ph: home.ph, r: home.r, target: tgt };
  }
}

export const SWIPE_CYCLE_S = 0.6;
export const SWIPE_ACTIVE_S = 0.25;
export const SWIPE_PEAK_RAD_S = 5;

/**
 * Accumulated azimuth of the swipe burst at time t. Each cycle is a flick
 * whose angular velocity decays linearly from SWIPE_PEAK_RAD_S to 0 over
 * SWIPE_ACTIVE_S (a finger's release with inertia), then a rest; cycles
 * alternate direction, so the camera rocks back and forth rather than
 * drifting away. Closed form, so it is exact at any t.
 */
export function swipeAngle(t) {
  const per = SWIPE_PEAK_RAD_S * SWIPE_ACTIVE_S / 2;   // radians swept by one flick
  const cycle = Math.floor(t / SWIPE_CYCLE_S);
  const local = t - cycle * SWIPE_CYCLE_S;
  // Completed flicks: +per, -per, +per ... sums to `per` after an odd count, 0 after an even one.
  const base = cycle % 2 === 1 ? per : 0;
  const dir = cycle % 2 === 0 ? 1 : -1;
  const a = Math.min(local, SWIPE_ACTIVE_S);
  // integral of v0 * (1 - s/T) ds from 0 to a
  const swept = SWIPE_PEAK_RAD_S * (a - (a * a) / (2 * SWIPE_ACTIVE_S));
  return base + dir * swept;
}
