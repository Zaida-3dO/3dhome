#!/usr/bin/env node
/**
 * The /diagnostics benchmark's frame statistics and scripted camera
 * (item 112ec00c): src/diagnostics/stats.js and camera-motion.js.
 * No framework, no install: `node scripts/test-diagnostics-stats.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. Nearest-rank percentiles: always a real sample, the right one.
 *   2. The miss counts use 33.4 / 50 ms and are STRICT (a steady 33.33 ms
 *      30 fps is not a miss).
 *   3. Longest stall is a CONTIGUOUS run summed, not the single max.
 *   4. Jank is relative to the series' own median, and a 120 Hz device is not
 *      charged for an ordinary 17 ms frame.
 *   5. Histogram edges, max-preserving downsampling, drift sign, linear fit.
 *   6. Camera moves are pure functions of time (same pose for the same t,
 *      whatever the frame rate), and the swipe burst's closed form matches a
 *      numeric integration of its velocity profile.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = await import(pathToFileURL(path.join(root, 'src/diagnostics/stats.js')).href);
const M = await import(pathToFileURL(path.join(root, 'src/diagnostics/camera-motion.js')).href);

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- 1. percentiles -----------------------------------------------------------
const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
check('p50 of 1..10 is 5 (nearest rank)', S.percentile(ten, 50) === 5, S.percentile(ten, 50));
check('p90 of 1..10 is 9', S.percentile(ten, 90) === 9, S.percentile(ten, 90));
check('p95 of 1..10 is 10', S.percentile(ten, 95) === 10, S.percentile(ten, 95));
check('p100 is the max', S.percentile(ten, 100) === 10);
check('p0 is the min', S.percentile(ten, 0) === 1);
check('percentile does not mutate its input', ten[0] === 10 && ten[1] === 1);
check('empty -> NaN', Number.isNaN(S.percentile([], 50)));
const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
check('p99 of 1..100 is 99', S.percentile(hundred, 99) === 99, S.percentile(hundred, 99));

// ---- 2-4. summary ------------------------------------------------------------
const steady30 = new Array(60).fill(1000 / 30);
const s30 = S.summarizeIntervals(steady30);
check('steady 30 fps has no >33 misses', s30.over33 === 0, s30);
check('steady 30 fps fps ~30', near(s30.fpsMean, 30, 0.01), s30.fpsMean);
check('33.4 itself is not a miss (strict >)', S.summarizeIntervals([33.4, 33.4]).over33 === 0);
check('33.5 is a miss', S.summarizeIntervals([33.5]).over33 === 1);
check('50 is not a >50 miss', S.summarizeIntervals([50]).over50 === 0);
check('50.1 is a >50 miss', S.summarizeIntervals([50.1]).over50 === 1);

const series = [16, 16, 40, 45, 16, 60, 16, 16, 16, 16];
const ss = S.summarizeIntervals(series);
check('over33 counts 3 frames', ss.over33 === 3, ss);
check('over50 counts 1 frame', ss.over50 === 1, ss);
check('pctOver33 is 30%', ss.pctOver33 === 30, ss.pctOver33);
check('longest stall is the contiguous 40+45 run (85), not the single 60', ss.longestStallMs === 85, ss.longestStallMs);
check('max is 60', ss.maxMs === 60);
check('mean is right', near(ss.meanMs, series.reduce((a, b) => a + b) / series.length, 0.01), ss.meanMs);
check('empty series -> null', S.summarizeIntervals([]) === null);

// jank relative to the median
check('60 Hz: a 34 ms frame (> 2x16.7 and > median+16.7) is jank', S.jankCount([16.7, 16.7, 16.7, 34], 16.7) === 1);
check('60 Hz: a 30 ms frame is not jank (< 2x median)', S.jankCount([16.7, 16.7, 30], 16.7) === 0);
check('120 Hz: a 17 ms frame is NOT jank (not a full 60 Hz refresh over the median)',
  S.jankCount([8.3, 8.3, 8.3, 17], 8.3) === 0);
check('120 Hz: a 26 ms frame IS jank', S.jankCount([8.3, 8.3, 26], 8.3) === 1);
check('jank with no median -> 0', S.jankCount([100], 0) === 0);
check('summary jankPct uses the series median', S.summarizeIntervals([16, 16, 16, 16, 40]).jankFrames === 1);

// ---- 5. histogram, downsample, drift, fit -------------------------------------
const h = S.histogram([5, 8.4, 8.5, 16.7, 33.4, 33.5, 49, 51, 150]);
check('histogram has edges+1 buckets', h.length === S.HIST_EDGES.length + 1);
check('histogram: 5 and 8.4 in bucket 0 (edge inclusive)', h[0] === 2, h);
check('histogram: 33.4 in the <=33.4 bucket, 33.5 above it', h[5] === 1 && h[6] === 2, h);
check('histogram: 150 in the open last bucket', h[h.length - 1] === 1, h);
check('histogram total equals input length', h.reduce((a, b) => a + b) === 9);

const ds = S.downsampleMax([1, 2, 90, 3, 4, 5, 6, 7], 4);
check('downsample keeps <= max points', ds.length <= 4, ds);
check('downsample keeps the stall (bucket max)', ds.indexOf(90) !== -1, ds);
check('downsample of a short series keeps every point', S.downsampleMax([1.26, 2], 10).join() === '1.3,2');

const warming = Array.from({ length: 60 }, (_, i) => (i < 30 ? 16 : 24));
const dr = S.drift(warming, 6);
check('drift is positive when frames slow down', dr.driftPct > 0, dr);
check('drift reports per-window means', dr.windowMeanMs.length === 6 && dr.windowMeanMs[0] === 16 && dr.windowMeanMs[5] === 24, dr);
check('drift of a flat series is 0', S.drift(new Array(60).fill(10), 6).driftPct === 0);
check('drift needs enough samples', S.drift([1, 2, 3], 6) === null);

const fit = S.linearFit([0, 10, 25, 50], [5, 6, 7.5, 10]);
check('linear fit slope 0.1', near(fit.slope, 0.1, 1e-9), fit);
check('linear fit intercept 5', near(fit.intercept, 5, 1e-9), fit);
check('linear fit ignores non-finite points', near(S.linearFit([0, 10, 20], [1, NaN, 3]).slope, 0.1, 1e-9));
check('linear fit with one distinct x is null', S.linearFit([5, 5], [1, 2]) === null);

// ---- 6. camera motion ----------------------------------------------------------
const home = { th: 0.5, ph: 1, r: 10, target: [1, 0, 2] };
const fp = { width: 10, depth: 8 };
check('idle never moves', JSON.stringify(M.motionPose('idle', 7.3, home, fp)) === JSON.stringify(M.motionPose('idle', 0, home, fp)));
check('slow orbit: th advances 0.25 rad/s', near(M.motionPose('orbit-slow', 4, home).th - home.th, 1));
check('fast orbit: th advances 1.5 rad/s', near(M.motionPose('orbit-fast', 2, home).th - home.th, 3));
check('fast orbit is 6x the slow one', near((M.motionPose('orbit-fast', 1, home).th - home.th) / (M.motionPose('orbit-slow', 1, home).th - home.th), 6));
check('pose depends on t only (same t, same pose)',
  JSON.stringify(M.motionPose('pan', 1.234, home, fp)) === JSON.stringify(M.motionPose('pan', 1.234, home, fp)));
check('motionPose never mutates home.target', (M.motionPose('pan', 1, home, fp), home.target.join() === '1,0,2'));
const panX = [...Array(400)].map((_, i) => M.motionPose('pan', i / 100, home, fp).target[0] - home.target[0]);
check('pan stays within +/-30% of the width', Math.max(...panX.map(Math.abs)) <= 0.3 * fp.width + 1e-9 && Math.max(...panX) > 2.9);
const zr = [...Array(300)].map((_, i) => M.motionPose('zoom', i / 100, home).r / home.r);
check('zoom spans 0.55x..1.35x', near(Math.min(...zr), 0.55, 0.01) && near(Math.max(...zr), 1.35, 0.01), [Math.min(...zr), Math.max(...zr)]);

// swipe burst: closed form vs numeric integration of the velocity profile
function swipeNumeric(t) {
  const dt = 1e-4; let a = 0;
  for (let x = 0; x < t; x += dt) {
    const c = Math.floor(x / M.SWIPE_CYCLE_S), local = x - c * M.SWIPE_CYCLE_S;
    const dir = c % 2 === 0 ? 1 : -1;
    const v = local < M.SWIPE_ACTIVE_S ? M.SWIPE_PEAK_RAD_S * (1 - local / M.SWIPE_ACTIVE_S) : 0;
    a += dir * v * dt;
  }
  return a;
}
[0.1, 0.25, 0.4, 0.7, 1.1, 1.9, 3.05].forEach(t => {
  check('swipe closed form matches integration at t=' + t, near(M.swipeAngle(t), swipeNumeric(t), 2e-3), [M.swipeAngle(t), swipeNumeric(t)]);
});
check('swipe burst rocks back (angle returns to ~0 after two cycles)', near(M.swipeAngle(2 * M.SWIPE_CYCLE_S), 0, 1e-9));
check('swipe peak sweep is v0*T/2', near(M.swipeAngle(M.SWIPE_ACTIVE_S), M.SWIPE_PEAK_RAD_S * M.SWIPE_ACTIVE_S / 2));
check('every MOTIONS key is a pose', Object.keys(M.MOTIONS).every(k => Number.isFinite(M.motionPose(k, 1.5, home, fp).th)));

console.log(`test-diagnostics-stats: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
