/**
 * Camera zoom and two-finger gesture maths for the orbit camera in
 * home3d-scene.js. Pure functions and a small state machine with no DOM and no
 * three.js, so node can drive them with synthetic event sequences
 * (scripts/test-camera-gestures.mjs).
 *
 * ZOOM IS MULTIPLICATIVE. The orbit distance used to change additively
 * (`r + deltaY * k`) with a floor of -30, so zooming in far enough carried r
 * through zero. The camera then sat on the far side of the target, still
 * looking at it, and every further zoom-in step made |r| bigger: the view
 * flipped and appeared to zoom out. Scaling r by a positive factor can never
 * cross zero, and the clamp below stops it at MIN_DISTANCE.
 *
 * TWO FINGERS: PAN OR PINCH, NOT BOTH BY ACCIDENT. Fingers dragged together
 * never keep exactly the same gap, and applying every change in the gap as
 * zoom made a two-finger pan zoom in and out as it moved. Each two-finger
 * gesture now starts undecided and locks to one mode:
 *   - pinch, once the gap has changed by PINCH_LOCK (log2 of the ratio)
 *     since the gesture began. Mapbox GL's touch zoom uses the same
 *     measure and the same 0.1 threshold;
 *   - pan, once the midpoint has travelled PAN_LOCK_PX. Hammer.js's pan
 *     recogniser uses the same 10px default.
 * A locked pan ignores gap drift. It becomes a pinch only on a strong signal,
 * a change of PINCH_UPGRADE since the lock. A pinch zooms by the ratio of
 * finger gaps, as three.js OrbitControls does, and still follows the midpoint,
 * so a pinch that drifts sideways still feels natural.
 */

/** Closest the camera may come to its orbit target, in metres. */
export const MIN_DISTANCE = 0.5;
/** Furthest the camera may be from its orbit target, in metres. */
export const MAX_DISTANCE = 30;
/** Wheel zoom gain: distance is scaled by exp(deltaPx * this). One 100px notch is about 13%. */
export const WHEEL_ZOOM_PER_PX = 0.0012;
/** Pixel sizes for wheel events reported in lines (deltaMode 1) or pages (deltaMode 2). */
export const WHEEL_LINE_PX = 16;
export const WHEEL_PAGE_PX = 800;
/** Midpoint travel, in CSS px, that locks an undecided two-finger gesture to pan. */
export const PAN_LOCK_PX = 10;
/** |log2(gap / startGap)| that locks an undecided two-finger gesture to pinch (about 7%). */
export const PINCH_LOCK = 0.1;
/** |log2(gap / gapAtPanLock)| that turns a locked pan into a pinch (about 27%). */
export const PINCH_UPGRADE = 0.35;
/** Smallest finger gap used in a ratio, so two touches at one point cannot divide by zero. */
const MIN_GAP_PX = 1;

export function clampDistance(r) {
  if (!Number.isFinite(r)) return MIN_DISTANCE;
  return Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, r));
}

/** A wheel event's vertical delta in CSS pixels, whatever unit it was reported in. */
export function wheelDeltaPx(deltaY, deltaMode) {
  const d = Number(deltaY) || 0;
  if (deltaMode === 1) return d * WHEEL_LINE_PX;
  if (deltaMode === 2) return d * WHEEL_PAGE_PX;
  return d;
}

/** New orbit distance after a wheel step. Negative delta (wheel forward / trackpad pinch-out) zooms in. */
export function zoomByWheel(r, deltaPx) {
  return clampDistance(clampDistance(r) * Math.exp(deltaPx * WHEEL_ZOOM_PER_PX));
}

/** New orbit distance after a pinch step: fingers apart (gap grows) brings the camera closer. */
export function zoomByPinch(r, prevGap, gap) {
  return clampDistance(clampDistance(r) * (Math.max(prevGap, MIN_GAP_PX) / Math.max(gap, MIN_GAP_PX)));
}

const gapOf = (a, b) => Math.max(Math.hypot(a.x - b.x, a.y - b.y), MIN_GAP_PX);
const midOf = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * One two-finger gesture at a time. start() with the two touch points when the
 * second finger lands, move() on every frame after, end() when fewer than two
 * remain. move() returns what to apply this frame:
 *   { mode, panDx, panDy, zoom }
 * where zoom multiplies the orbit distance (1 = no zoom) and pan is the
 * midpoint's movement in CSS px (0 while undecided).
 */
export function createTwoFingerGesture() {
  let mode = 'idle';
  let startGap = 0, lockGap = 0, prevGap = 0;
  let startMid = null, prevMid = null;
  const none = () => ({ mode, panDx: 0, panDy: 0, zoom: 1 });

  return {
    get mode() { return mode; },
    start(a, b) {
      mode = 'pending';
      startGap = prevGap = gapOf(a, b);
      startMid = prevMid = midOf(a, b);
      lockGap = 0;
    },
    move(a, b) {
      if (mode === 'idle') { this.start(a, b); return none(); }
      const gap = gapOf(a, b);
      const mid = midOf(a, b);
      if (mode === 'pending') {
        const scale = Math.abs(Math.log2(gap / startGap));
        const travel = Math.hypot(mid.x - startMid.x, mid.y - startMid.y);
        if (scale >= PINCH_LOCK) mode = 'pinch';
        else if (travel >= PAN_LOCK_PX) { mode = 'pan'; lockGap = gap; }
        // The frame that decides only records where the fingers are, so the
        // movement spent deciding is not applied as a jump.
        prevGap = gap; prevMid = mid;
        return none();
      }
      if (mode === 'pan' && Math.abs(Math.log2(gap / lockGap)) >= PINCH_UPGRADE) {
        mode = 'pinch';
        prevGap = gap; // start zooming from here rather than jumping by the whole upgrade
      }
      const out = {
        mode,
        panDx: mid.x - prevMid.x,
        panDy: mid.y - prevMid.y,
        zoom: mode === 'pinch' ? prevGap / gap : 1
      };
      prevGap = gap; prevMid = mid;
      return out;
    },
    end() { mode = 'idle'; startMid = prevMid = null; }
  };
}
