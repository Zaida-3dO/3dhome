#!/usr/bin/env node
/**
 * Camera zoom and two-finger gestures (src/camera-gestures.js), driven with
 * synthetic wheel and two-touch sequences, plus the wiring in
 * src/home3d-scene.js. No framework, no install:
 * `node scripts/test-camera-gestures.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. Wheel zoom-in never inverts and never stops. Over 200 notches the
 *      camera keeps moving forward along its view ray, by at least a minimum
 *      step, and the distance to the target stays positive. Past
 *      PUSH_DISTANCE the target is pushed forward instead ("dolly-through").
 *      (Zoom used to be additive with a -30 floor, so r crossed zero and the
 *      camera flipped to the far side of the target.)
 *   2. Wheel zoom-out is a plain factor capped at MAX_DISTANCE; line and page
 *      deltaMode are scaled.
 *   3. Pinching in forever behaves like the wheel: monotone forward travel,
 *      no flip, no stop. The target never goes below the floor; it slides
 *      along it.
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
const { PUSH_DISTANCE, MAX_DISTANCE } = G;

// A camera the way home3d-scene.js drives it: orbit angles th/ph, radius r
// and a target. zoomBy() is the scene's own composition of dolly() and
// pushTarget() (the scene also clamps the target to the house's pan bounds).
function makeCam(th, ph, r, tgt = { x: 0, y: 0, z: 0 }) {
  const c = { th, ph, r, tgt: { ...tgt } };
  c.off = () => ({ x: Math.sin(c.ph) * Math.cos(c.th), y: Math.cos(c.ph), z: Math.sin(c.ph) * Math.sin(c.th) });
  c.pos = () => { const o = c.off(); return { x: c.tgt.x + c.r * o.x, y: c.tgt.y + c.r * o.y, z: c.tgt.z + c.r * o.z }; };
  c.zoomBy = f => {
    const d = G.dolly(c.r, f);
    c.r = d.r;
    if (d.push > 0) { const o = c.off(); c.tgt = G.pushTarget(c.tgt, { x: -o.x, y: -o.y, z: -o.z }, d.push); }
    return d;
  };
  return c;
}
// Forward travel along the INITIAL view ray, sampled after every step.
function zoomRun(cam, factors) {
  const o = cam.off(), fwd = { x: -o.x, y: -o.y, z: -o.z }, p0 = cam.pos();
  const along = p => (p.x - p0.x) * fwd.x + (p.y - p0.y) * fwd.y + (p.z - p0.z) * fwd.z;
  const s = [{ r: cam.r, a: 0, p: cam.pos(), side: 1, ty: cam.tgt.y }];
  for (const f of factors) {
    cam.zoomBy(f);
    const p = cam.pos(), off = cam.off();
    const side = Math.sign((p.x - cam.tgt.x) * off.x + (p.y - cam.tgt.y) * off.y + (p.z - cam.tgt.z) * off.z);
    s.push({ r: cam.r, a: along(p), p, side, ty: cam.tgt.y });
  }
  return s;
}
const strictlyUp = xs => xs.every((x, i) => i === 0 || x > xs[i - 1]);

// 1. wheel zoom-in: never inverts, never stops ------------------------------
{
  // A level view (ph = 90 deg) so the push is not bent by the floor.
  const notch = G.wheelFactor(-100);
  const run = zoomRun(makeCam(0.7, Math.PI / 2, 5, { x: 0, y: 1.5, z: 0 }), Array(200).fill(notch));
  check('wheel in: camera travel is strictly forward on every notch', strictlyUp(run.map(x => x.a)), run.slice(0, 6).map(x => x.a));
  check('wheel in: distance to target always positive', run.every(x => x.r > 0), Math.min(...run.map(x => x.r)));
  check('wheel in: never flips to the far side of the target', run.every(x => x.side === 1));
  check('wheel in: radius settles at PUSH_DISTANCE, never below',
    run.slice(-50).every(x => x.r === PUSH_DISTANCE) && run.every(x => x.r >= PUSH_DISTANCE - 1e-12));
  const late = run.slice(-50).map((x, i, a) => i ? x.a - a[i - 1].a : null).slice(1);
  check('wheel in: late steps keep a minimum size (never stops)',
    late.every(d => d >= G.MIN_PUSH_PER_LOG * -Math.log(notch) - 1e-9), late.slice(0, 3));
  check('wheel in: keeps going (> 25 m travelled over 200 notches)', run[run.length - 1].a > 25, run[run.length - 1].a);
  check('wheel in: each early notch is gradual (< 15% of r)',
    run.slice(0, 10).every((x, i, a) => i === 0 || (a[i - 1].r - x.r) / a[i - 1].r < 0.15));
  // Continuity at the hand-over from shortening r to pushing the target.
  const steps = run.map((x, i, a) => i ? x.a - a[i - 1].a : 0).slice(1);
  check('wheel in: no jump at the push hand-over (steps never grow)',
    steps.every((d, i) => i === 0 || d <= steps[i - 1] + 1e-9), steps.slice(0, 20).map(d => +d.toFixed(3)));
  // trackpad: many tiny deltas, same guarantees
  const tp = zoomRun(makeCam(2, 1.2, 3, { x: 0, y: 2, z: 0 }), Array(3000).fill(G.wheelFactor(-3)));
  check('trackpad in: strictly forward, positive, no flip',
    strictlyUp(tp.map(x => x.a)) && tp.every(x => x.r > 0 && x.side === 1));
  // A radius already inside PUSH_DISTANCE (a preset, setOrbit) pushes at once.
  const d = G.dolly(0.2, notch);
  check('inside PUSH_DISTANCE: r kept, whole step pushes', d.r === 0.2 && d.push > 0 && d.push === d.travel, d);
  check('a non-positive radius is never returned', G.dolly(-4, notch).r > 0 && G.dolly(0, notch).r > 0);
}

// 2. wheel zoom-out and deltaMode -------------------------------------------
{
  const run = zoomRun(makeCam(0, 1, 5), Array(80).fill(G.wheelFactor(100)));
  check('wheel out: radius never decreases', run.every((x, i) => i === 0 || x.r >= run[i - 1].r));
  check('wheel out: stops at MAX_DISTANCE', run[run.length - 1].r === MAX_DISTANCE && run.every(x => x.r <= MAX_DISTANCE));
  check('wheel out: target never moves', run.every(x => x.ty === 0));
  check('wheel in then out is symmetric above PUSH_DISTANCE',
    Math.abs(G.dolly(G.dolly(5, G.wheelFactor(-100)).r, G.wheelFactor(100)).r - 5) < 1e-9);
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
    r = G.dolly(r, s.zoom).r;
    panX += s.panDx; panY += s.panDy;
    rs.push(r); modes.push(s.mode);
  }
  g.end();
  return { r, rs, modes, panX, panY, mode: modes[modes.length - 1] };
}

// 3. pinch in forever, and the floor ----------------------------------------
{
  const frames = [];
  for (let i = 0; i <= 120; i++) frames.push(pair(400, 300, 100 * Math.pow(1.05, i)));
  const g = G.createTwoFingerGesture(); g.start(...frames[0]);
  const factors = frames.slice(1).map(f => g.move(...f).zoom);
  check('pinch in: locks to pinch', g.mode === 'pinch');
  // Looking down at the default 0.32*pi: the push meets the floor and slides.
  const run = zoomRun(makeCam(0.7, Math.PI * 0.32, 3), factors);
  const moving = run.slice(3); // the first frames are the undecided dead zone
  check('pinch in: camera travel strictly forward once zooming', strictlyUp(moving.map(x => x.a)), moving.slice(0, 5).map(x => x.a));
  check('pinch in: positive radius, never flips', run.every(x => x.r > 0 && x.side === 1));
  check('pinch in: target never below the floor', run.every(x => x.ty >= G.FLOOR_Y - 1e-12), Math.min(...run.map(x => x.ty)));
  check('pinch in: camera stays above the floor', run.every(x => x.p.y > G.FLOOR_Y), Math.min(...run.map(x => x.p.y)));
  // pushTarget directly
  const t = G.pushTarget({ x: 0, y: 0.5, z: 0 }, { x: 0.6, y: -0.8, z: 0 }, 2);
  check('pushTarget: into the floor keeps its length along it', t.y === 0 && Math.abs(t.x - (0.375 + 1.375)) < 1e-9, t);
  const top = G.pushTarget({ x: 0, y: 0.5, z: 0 }, { x: 0.01, y: -0.9999, z: 0 }, 2);
  check('pushTarget: straight down stops at the floor', top.y === 0 && Math.abs(top.x) < 0.01, top);
  const lvl = G.pushTarget({ x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: -1 }, 3);
  check('pushTarget: level push goes straight on', lvl.x === 1 && lvl.y === 1 && lvl.z === -2, lvl);
  const under = G.pushTarget({ x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 }, 1);
  check('pushTarget: a target already below the floor is not lifted', under.y === -1, under);
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
  check('wheel handler zooms through zoomBy', /zoomBy\(wheelFactor\(wheelDeltaPx\(e\.deltaY, e\.deltaMode\)\)\)/.test(src));
  check('zoomBy composes dolly + pushTarget', /const d = dolly\(orb\.r, factor\);/.test(src) && /pushTarget\(orb\.tgt, dir, d\.push\)/.test(src));
  check('push direction is the view ray (minus the camera offset)',
    src.includes('const dir = { x: -sp * Math.cos(orb.th), y: -Math.cos(orb.ph), z: -sp * Math.sin(orb.th) };'));
  check('no negative zoom floor survives', !/Math\.max\(-30/.test(src));
  check('touchmove feeds the two-finger gesture', /twoFinger\.move\(/.test(src) && /if \(step\.zoom !== 1\) zoomBy\(step\.zoom\)/.test(src));
  check('touchend / touchcancel end the gesture', /"touchend", endTouches/.test(src) && /"touchcancel", endTouches/.test(src));
  check('one-finger rotate formula unchanged',
    src.includes('orb.th += (e.clientX - orb.px) * 0.005;') &&
    src.includes('orb.ph = Math.max(0.05, Math.min(Math.PI - 0.05, orb.ph - (e.clientY - orb.py) * 0.005));'));
  check('rotate is off while two touches are down', /if \(orb\.drag && touchIds\.size < 2\)/.test(src) && /orb\.drag = touchIds\.size < 2/.test(src));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
