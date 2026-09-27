#!/usr/bin/env node
/**
 * Camera zoom and two-finger gestures (src/camera-gestures.js), driven with
 * synthetic wheel and two-touch sequences, plus the wiring in
 * src/home3d-scene.js. No framework, no install:
 * `node scripts/test-camera-gestures.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. Wheel zoom-in stops at MIN_DISTANCE and never inverts: the distance
 *      only goes down, never below the minimum, and never crosses zero.
 *      (It used to be additive with a -30 floor, so r crossed zero and the
 *      camera flipped to the far side of the target.)
 *   2. Wheel zoom-out stops at MAX_DISTANCE; line/page deltaMode is scaled.
 *   3. Pinch-in past the minimum stops there, monotonically.
 *   4. A two-finger pan whose finger gap drifts by +/-6% produces no zoom
 *      at all, and the pan still moves.
 *   5. A deliberate pinch zooms smoothly: it locks to pinch, every frame
 *      zooms the same way, and the total is close to the finger ratio.
 *   6. A locked pan becomes a pinch on a strong gap change.
 *   7. home3d-scene.js uses these for the wheel and the touch handlers, no
 *      negative floor survives, and one-finger rotate is untouched but off
 *      while two touches are down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const monotone = (xs, dir) => xs.every((x, i) => i === 0 || (dir < 0 ? x <= xs[i - 1] : x >= xs[i - 1]));

const G = await imp('src/camera-gestures.js');
const { MIN_DISTANCE, MAX_DISTANCE } = G;

// 1. wheel zoom-in past the minimum -----------------------------------------
{
  let r = 5; const trace = [r];
  for (let i = 0; i < 80; i++) { r = G.zoomByWheel(r, -100); trace.push(r); }
  check('wheel in: distance never increases', monotone(trace, -1), trace.slice(0, 12));
  check('wheel in: never below MIN_DISTANCE, never <= 0', trace.every(x => x >= MIN_DISTANCE && x > 0), Math.min(...trace));
  check('wheel in: reaches and holds MIN_DISTANCE', trace.slice(-5).every(x => x === MIN_DISTANCE), trace.slice(-5));
  check('wheel in: the approach is gradual (each notch under 15%)',
    trace.every((x, i) => i === 0 || x / trace[i - 1] > 0.85), trace.slice(0, 6));
  // trackpad: many tiny deltas, same guarantees
  let t = 3; const tt = [t];
  for (let i = 0; i < 2000; i++) { t = G.zoomByWheel(t, -3); tt.push(t); }
  check('trackpad in: monotone and floored', monotone(tt, -1) && tt.every(x => x >= MIN_DISTANCE), tt.slice(-3));
  // a start distance already inside the minimum (e.g. an old preset) is lifted, not inverted
  check('wheel in from below the floor clamps up to it', G.zoomByWheel(0.1, -100) === MIN_DISTANCE);
  check('wheel on a negative r returns a positive distance', G.zoomByWheel(-4, -100) >= MIN_DISTANCE);
}

// 2. wheel zoom-out and deltaMode -------------------------------------------
{
  let r = 5; const trace = [r];
  for (let i = 0; i < 80; i++) { r = G.zoomByWheel(r, 100); trace.push(r); }
  check('wheel out: distance never decreases', monotone(trace, 1));
  check('wheel out: stops at MAX_DISTANCE', trace[trace.length - 1] === MAX_DISTANCE && trace.every(x => x <= MAX_DISTANCE));
  check('wheel in then out is symmetric', Math.abs(G.zoomByWheel(G.zoomByWheel(5, -100), 100) - 5) < 1e-9);
  check('deltaMode 0 passes pixels through', G.wheelDeltaPx(-100, 0) === -100);
  check('deltaMode 1 scales lines to px', G.wheelDeltaPx(-3, 1) === -3 * G.WHEEL_LINE_PX);
  check('deltaMode 2 scales pages to px', G.wheelDeltaPx(1, 2) === G.WHEEL_PAGE_PX);
}

// helpers for two-finger sequences -------------------------------------------
// Two touches either side of a midpoint (mx,my), `gap` apart, along an axis.
const pair = (mx, my, gap, ang = 0) => {
  const hx = Math.cos(ang) * gap / 2, hy = Math.sin(ang) * gap / 2;
  return [{ x: mx - hx, y: my - hy }, { x: mx + hx, y: my + hy }];
};
function runGesture(frames, r0 = 5) {
  const g = G.createTwoFingerGesture();
  g.start(...frames[0]);
  let r = r0, panX = 0, panY = 0;
  const rs = [r], modes = [];
  for (const f of frames.slice(1)) {
    const s = g.move(...f);
    r = G.clampDistance(r * s.zoom);
    panX += s.panDx; panY += s.panDy;
    rs.push(r); modes.push(s.mode);
  }
  g.end();
  return { r, rs, modes, panX, panY, mode: modes[modes.length - 1] };
}

// 3. pinch-in past the minimum -----------------------------------------------
{
  const frames = [];
  for (let i = 0; i <= 120; i++) frames.push(pair(400, 300, 100 * Math.pow(1.05, i)));
  const g = runGesture(frames, 3);
  check('pinch in: locks to pinch', g.mode === 'pinch', g.modes.slice(0, 5));
  check('pinch in: distance never increases', monotone(g.rs, -1), g.rs.slice(0, 8));
  check('pinch in: stops at MIN_DISTANCE, never inverts', g.rs.every(x => x >= MIN_DISTANCE) && g.r === MIN_DISTANCE, g.r);
}

// 4. deliberate pan with natural gap drift -----------------------------------
{
  // Fingers 200px apart drag 300px to the right over 60 frames; the gap
  // wobbles +/-6% (a hand does not hold its fingers still) and the axis
  // between the fingers rotates a little.
  const frames = [];
  for (let i = 0; i <= 60; i++) {
    const gap = 200 * (1 + 0.06 * Math.sin(i * 0.9));
    frames.push(pair(300 + i * 5, 400 + Math.sin(i * 0.4) * 3, gap, 0.3 + 0.05 * Math.sin(i * 0.3)));
  }
  const g = runGesture(frames, 5);
  check('pan with gap drift: locks to pan', g.mode === 'pan', g.modes.slice(0, 5));
  check('pan with gap drift: zero zoom on every frame', g.rs.every(x => x === 5), g.rs.filter(x => x !== 5).slice(0, 5));
  check('pan with gap drift: still pans (> 280px of 300)', g.panX > 280, g.panX);
  // The same sequence through the OLD rule (every gap change is zoom,
  // r -= dGap * 0.05) would have zoomed on nearly every frame.
  let old = 5, oldChanged = 0;
  for (let i = 1; i < frames.length; i++) {
    const gap = f => Math.hypot(f[0].x - f[1].x, f[0].y - f[1].y);
    const n = old - (gap(frames[i]) - gap(frames[i - 1])) * 0.05;
    if (n !== old) oldChanged++;
    old = n;
  }
  check('control: the old rule would have zoomed on most frames', oldChanged > 50, oldChanged);
}

// 5. deliberate pinch ---------------------------------------------------------
{
  const frames = [];
  for (let i = 0; i <= 40; i++) frames.push(pair(500, 300 + i * 0.3, 200 + i * 5)); // 200 -> 400, midpoint drifts 12px
  const g = runGesture(frames, 8);
  check('pinch: locks to pinch', g.mode === 'pinch', g.modes.slice(0, 5));
  check('pinch: zooms in smoothly (monotone)', monotone(g.rs, -1));
  // Fingers doubled their gap; the first ~7% was spent deciding. Expect r close to 8 * 214/400.
  check('pinch: total zoom tracks the finger ratio', g.r > 8 * 0.5 && g.r < 8 * 0.56, g.r);
  // Pinch out (fingers together) zooms out.
  const out = [];
  for (let i = 0; i <= 40; i++) out.push(pair(500, 300, 400 - i * 5));
  const o = runGesture(out, 4);
  check('pinch out: zooms out', o.mode === 'pinch' && o.r > 4 * 1.8, o.r);
}

// 6. pan upgraded to pinch on a strong signal --------------------------------
{
  const frames = [];
  for (let i = 0; i <= 10; i++) frames.push(pair(300 + i * 5, 300, 200)); // clear pan
  for (let i = 1; i <= 30; i++) frames.push(pair(350, 300, 200 * (1 + i * 0.03))); // then spread to 1.9x
  const g = runGesture(frames, 6);
  check('pan -> pinch on a strong spread', g.modes.includes('pan') && g.mode === 'pinch', [g.modes[5], g.mode]);
  check('pan -> pinch then zooms in', g.r < 6 * 0.8, g.r);
  check('pan -> pinch: no zoom while still a pan', g.rs.slice(0, 12).every(x => x === 6), g.rs.slice(0, 12));
  // Tiny stillness: nothing moves while undecided.
  const still = runGesture([pair(300, 300, 200), pair(301, 300, 203), pair(302, 301, 201)], 5);
  check('undecided: sub-threshold jitter moves nothing', still.r === 5 && still.panX === 0 && still.mode === 'pending', still);
}

// 7. wiring in home3d-scene.js ------------------------------------------------
{
  const src = read('src/home3d-scene.js');
  check('scene imports the gesture module', /from '\.\/camera-gestures\.js'/.test(src));
  check('wheel handler uses zoomByWheel', /orb\.r = zoomByWheel\(orb\.r, wheelDeltaPx\(e\.deltaY, e\.deltaMode\)\)/.test(src));
  check('no negative zoom floor survives', !/Math\.max\(-30/.test(src));
  check('touchmove feeds the two-finger gesture', /twoFinger\.move\(/.test(src) && /orb\.r = clampDistance\(orb\.r \* step\.zoom\)/.test(src));
  check('touchend / touchcancel end the gesture', /"touchend", endTouches/.test(src) && /"touchcancel", endTouches/.test(src));
  check('one-finger rotate formula unchanged',
    src.includes('orb.th += (e.clientX - orb.px) * 0.005;') &&
    src.includes('orb.ph = Math.max(0.05, Math.min(Math.PI - 0.05, orb.ph - (e.clientY - orb.py) * 0.005));'));
  check('rotate is off while two touches are down', /if \(orb\.drag && touchIds\.size < 2\)/.test(src) && /orb\.drag = touchIds\.size < 2/.test(src));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
