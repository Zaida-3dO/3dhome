/**
 * Camera zoom and two-finger gesture maths for the orbit camera in
 * home3d-scene.js. Pure functions and a small state machine with no DOM and no
 * three.js, so node can drive them with synthetic event sequences
 * (scripts/test-camera-gestures.mjs).
 *
 * ZOOM NEVER INVERTS AND NEVER STOPS. The orbit distance used to change
 * additively (`r + deltaY * k`) with a floor of -30, so zooming in far enough
 * carried r through zero. The camera then sat on the far side of the target,
 * still looking at it, and every further zoom-in step made |r| bigger: the
 * view flipped and appeared to zoom out. Now:
 *   - a zoom step is a factor: the camera moves `r * (1 - factor)` along
 *     its view ray, and never less than MIN_PUSH_PER_LOG * |ln factor|, so
 *     the step does not shrink to nothing near the target;
 *   - while r is above PUSH_DISTANCE the step shortens r (ordinary zoom);
 *   - once it would take r below PUSH_DISTANCE, the rest of the step pushes
 *     the orbit TARGET forward along the view ray instead ("dolly-through"),
 *     so the camera flies on into the house at the same speed and later
 *     orbits around the new target. r is always positive.
 *   - The target does not go below the floor: a push that would take it
 *     under FLOOR_Y slides along the floor instead (see pushTarget).
 *   - Zoom-out is a plain factor on r, capped at MAX_DISTANCE.
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

/** Orbit radius kept while zoom-in pushes the target forward, in metres. */
export const PUSH_DISTANCE = 1;
/** Smallest zoom-in travel, in metres per unit of |ln factor| (one wheel notch is about 0.18 m). */
export const MIN_PUSH_PER_LOG = 1.5;
/** The orbit target is kept at or above this height (the floor), in metres. */
export const FLOOR_Y = 0;
/** Below this horizontal share of the view ray (looking almost straight down), a push cannot slide along the floor. */
const MIN_SLIDE = 0.15;
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

/** Keeps an orbit radius positive and within MAX_DISTANCE. */
export function clampDistance(r) {
  if (!Number.isFinite(r) || r <= 0) return PUSH_DISTANCE;
  return Math.min(MAX_DISTANCE, r);
}

/** A wheel event's vertical delta in CSS pixels, whatever unit it was reported in. */
export function wheelDeltaPx(deltaY, deltaMode) {
  const d = Number(deltaY) || 0;
  if (deltaMode === 1) return d * WHEEL_LINE_PX;
  if (deltaMode === 2) return d * WHEEL_PAGE_PX;
  return d;
}

/** The distance factor for a wheel step: below 1 zooms in (wheel forward, trackpad pinch-out). */
export function wheelFactor(deltaPx) {
  return Math.exp(deltaPx * WHEEL_ZOOM_PER_PX);
}

/** The distance factor for a pinch step: fingers apart (the gap grows) is below 1, zoom in. */
export function pinchFactor(prevGap, gap) {
  return Math.max(prevGap, MIN_GAP_PX) / Math.max(gap, MIN_GAP_PX);
}

/**
 * One zoom step. Returns the new orbit radius and how far (metres) to push
 * the target forward along the view ray. Zoom-in always moves the camera
 * forward by `travel` > 0: first by shortening r down to PUSH_DISTANCE, then
 * by pushing the target.
 */
export function dolly(r, factor) {
  const r0 = clampDistance(r);
  if (!(factor > 0) || factor === 1) return { r: r0, push: 0, travel: 0 };
  if (factor > 1) { const r1 = clampDistance(r0 * factor); return { r: r1, push: 0, travel: r0 - r1 }; }
  const travel = Math.max(r0 * (1 - factor), MIN_PUSH_PER_LOG * -Math.log(factor));
  const r1 = Math.max(Math.min(r0, PUSH_DISTANCE), r0 - travel);
  return { r: r1, push: travel - (r0 - r1), travel };
}

/**
 * Moves a target point `push` metres along the unit view direction `dir`
 * (camera towards target), without taking it below FLOOR_Y: a push into the
 * floor keeps its length but runs along the floor in the view's horizontal
 * direction. Looking almost straight down there is no such direction, and
 * the push stops at the floor. Returns a new {x, y, z}.
 */
export function pushTarget(tgt, dir, push) {
  if (!(push > 0)) return { x: tgt.x, y: tgt.y, z: tgt.z };
  // A target a pan already put below the floor is not lifted back up.
  const floor = Math.min(FLOOR_Y, tgt.y);
  const y = tgt.y + dir.y * push;
  if (y >= floor || dir.y >= 0) return { x: tgt.x + dir.x * push, y, z: tgt.z + dir.z * push };
  // Down to the floor along the ray, then the rest along the floor.
  const down = Math.max(0, (tgt.y - floor) / -dir.y);
  const rest = push - down;
  const h = Math.hypot(dir.x, dir.z);
  const at = { x: tgt.x + dir.x * down, y: floor, z: tgt.z + dir.z * down };
  if (h < MIN_SLIDE) return at;
  return { x: at.x + dir.x / h * rest, y: floor, z: at.z + dir.z / h * rest };
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
        zoom: mode === 'pinch' ? pinchFactor(prevGap, gap) : 1
      };
      prevGap = gap; prevMid = mid;
      return out;
    },
    end() { mode = 'idle'; startMid = prevMid = null; }
  };
}
