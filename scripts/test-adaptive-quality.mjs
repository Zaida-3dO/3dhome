#!/usr/bin/env node
/**
 * Adaptive quality (task 230713da): src/adaptive-quality.js.
 * No framework, no install: `node scripts/test-adaptive-quality.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. The level ladder reproduces the pre-adaptive build exactly where a
 *      device starts: a desktop at the top of what it compiles (every uniform
 *      tier x every shadows= value, against the old formula copied below),
 *      a mobile GPU at PR #54's cap.
 *   2. The controller on SIMULATED frame-time series: a fast device climbs
 *      (first the jump to the start ratio, then a next-load proposal, then
 *      notches to the max) and stops; a slow one descends and proposes a
 *      lower level with a block; the dead band never moves; a single bad
 *      window never moves; an oscillating device reverses at most once.
 *   3. Sample rejection: idle gaps, drag frames at a lowered ratio, the
 *      settle window after a step, stalls.
 *   4. Persistence: throwing storage never throws, garbage is ignored, the
 *      level is clamped, and the key names the GPU.
 *   5. The scene wires it: ?tier= disables it, the loop feeds it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = await import(pathToFileURL(path.join(root, 'src/adaptive-quality.js')).href);

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// ---- 1. the ladder ----------------------------------------------------------
// The pre-adaptive formula, verbatim in effect (home3d-scene.js at f3e0cb2):
// tier from resolveTier, then the shadows= switch, then dropMinor = mobileCaps.
function oldConfig(compileTier, mobile, shadows) {
  let tier = compileTier, capped = false;
  if (mobile && tier === 'ultra') { tier = 'mid'; capped = true; }
  let sunShadow = tier !== 'low';
  let roomShadowLights = tier === 'ultra';
  let shadowMapScale = 1;
  if (shadows === 'off') { sunShadow = false; roomShadowLights = false; }
  else if (shadows === 'low') { sunShadow = tier !== 'low'; roomShadowLights = false; shadowMapScale = 0.25; }
  else if (shadows === 'high') { sunShadow = tier !== 'low'; roomShadowLights = tier !== 'low' && !capped; shadowMapScale = 1; }
  return { tier, sunShadow, roomShadowLights, shadowMapScale, dropMinorFurniture: mobile };
}
const pick = c => ({ tier: c.tier, sunShadow: c.sunShadow, roomShadowLights: c.roomShadowLights,
  shadowMapScale: c.shadowMapScale, dropMinorFurniture: c.dropMinorFurniture });
for (const compileTier of ['low', 'mid', 'ultra']) {
  for (const shadows of ['auto', 'high', 'low', 'off']) {
    for (const mobile of [false, true]) {
      const maxLevel = A.maxLevelFor(compileTier);
      const start = A.defaultLevel(mobile, maxLevel);
      const got = pick(A.levelConfig(start, { maxLevel, mobile, shadows }));
      const want = oldConfig(compileTier, mobile, shadows);
      // The ONE deliberate difference: a mobile GPU that only compiles mid,
      // under an explicit ?shadows=high, was never "capped" before (its tier
      // was mid already) and so got room shadows. It now starts at mid-lite
      // like every mobile GPU and earns them by stepping up to mid (the top
      // of what it compiles) on measured headroom.
      if (compileTier === 'mid' && mobile && shadows === 'high') {
        want.roomShadowLights = false;
        check('mobile mid-compile under high: room shadows come back at its top level',
          A.levelConfig(2, { maxLevel, mobile, shadows }).roomShadowLights === true);
      }
      check(`start config == pre-adaptive: ${compileTier} ${shadows} ${mobile ? 'mobile' : 'desktop'}`,
        JSON.stringify(got) === JSON.stringify(want), { got, want });
    }
  }
}
// ?tier=X pins the build to X's top level, with X's level as the max and the
// mobile caps lifted (resolveTier's mobileCaps is false under an override) --
// which is exactly the old override build: tier min(X, compile), not capped,
// minor furniture kept.
for (const compileTier of ['low', 'mid', 'ultra']) {
  for (const override of ['low', 'mid', 'ultra']) {
    for (const shadows of ['auto', 'high', 'low', 'off']) {
      const rank = t => ['low', 'mid', 'ultra'].indexOf(t);
      const tier = rank(override) <= rank(compileTier) ? override : compileTier;
      const want = oldConfig(tier, false, shadows);
      const lvl = A.levelForTier(tier);
      const got = pick(A.levelConfig(lvl, { maxLevel: lvl, mobile: false, shadows }));
      check(`?tier=${override} build == pre-adaptive: compile ${compileTier}, shadows=${shadows}`,
        JSON.stringify(got) === JSON.stringify(want), { got, want });
    }
  }
}
check('maxLevel: low 0, mid 2, ultra 4', A.maxLevelFor('low') === 0 && A.maxLevelFor('mid') === 2 && A.maxLevelFor('ultra') === 4);
check('mobile starts at mid-lite, desktop at the top', A.defaultLevel(true, 4) === 1 && A.defaultLevel(false, 4) === 4 && A.defaultLevel(true, 0) === 0);
{
  const ctx = { maxLevel: 4, mobile: true, shadows: 'auto' };
  check('the ladder climbs through distinct configs under shadows=auto',
    A.nextDistinctLevel(1, +1, ctx) === 2 && A.nextDistinctLevel(2, +1, ctx) === 3 && A.nextDistinctLevel(3, +1, ctx) === 4 && A.nextDistinctLevel(4, +1, ctx) === null);
  check('level 4 under auto has room shadows, level 3 does not',
    A.levelConfig(4, ctx).roomShadowLights === true && A.levelConfig(3, ctx).roomShadowLights === false);
  const low = { maxLevel: 4, mobile: true, shadows: 'low' };
  check('shadows=low (the embed default): ultra-lite and ultra collapse, so the ladder tops out at 3',
    A.nextDistinctLevel(3, +1, low) === null && A.nextDistinctLevel(2, +1, low) === 3);
  check('never above what compiles (mid device tops out at 2)',
    A.nextDistinctLevel(2, +1, { maxLevel: 2, mobile: true, shadows: 'auto' }) === null);
  check('nextDistinctLevel down from 1 reaches 0', A.nextDistinctLevel(1, -1, ctx) === 0 && A.nextDistinctLevel(0, -1, ctx) === null);
}
check('p95 nearest-rank', A.p95([...Array(100)].map((_, i) => i + 1)) === 95 && A.p95([5]) === 5);

// ---- 2. the controller on simulated series ----------------------------------
function tabletController(extra) {
  return A.createController(Object.assign({
    floor: 1, startRatio: A.MOBILE_START_RATIO, maxRatio: 2, level: 1,
    ctx: { maxLevel: 4, mobile: true, shadows: 'auto' }, blocked: null
  }, extra || {}));
}
// Run a frame-time series through a controller as a probing scene would:
// consecutive frames, time advancing by each interval.
function run(ctl, series, t0) {
  let now = t0 || 10000;
  const out = [];
  for (const ms of series) {
    now += ms;
    const r = ctl.feed({ ms, now, continuous: true, lowered: false });
    if (r && r.decision) out.push(Object.assign({ verdict: r.verdict, p95: r.p95 }, r.decision));
  }
  return { out, now };
}
const frames = (ms, n) => Array(n).fill(ms);
const W = A.WINDOW;

{ // a fast tablet
  const c = tabletController();
  const { out } = run(c, frames(8, 2000));
  const steps = out.map(d => d.kind + ':' + d.to + ':' + d.proposeLevel).join(' ');
  check('fast: first decision jumps 1 -> 1.5 (the start ratio)', out[0] && out[0].to === 1.5 && out[0].proposeLevel === null, steps);
  check('fast: second decision proposes the next level for the next load and steps to 1.75',
    out[1] && out[1].proposeLevel === 2 && out[1].to === 1.75, steps);
  check('fast: then 2, and never above maxRatio', out[2] && out[2].to === 2 && out.length === 3, steps);
  check('fast: nothing left to gain -> canGoUp false', c.canGoUp(1e9) === false && c.ceiling === 2 && c.pending === 2);
}
{ // a fast desktop at DPR 2: today's ramp (1 -> 2 in one jump) and nothing else
  const c = A.createController({ floor: 1, startRatio: 2, maxRatio: 2, level: 4,
    ctx: { maxLevel: 4, mobile: false, shadows: 'auto' } });
  const { out } = run(c, frames(7, 2000));
  check('desktop fast: exactly one decision, 1 -> 2, no level proposal', out.length === 1 && out[0].to === 2 && out[0].proposeLevel === null, out);
}
{ // a slow tablet at level 3, DPR 2
  const c = tabletController({ level: 3 });
  run(c, frames(8, 1000));           // climbs to 1.5, proposes 4, then 1.75, 2
  const before = c.ceiling;
  const { out, now } = run(c, frames(45, 1000), 20000);
  const first = out[0];
  check('slow: the first down-step is one notch, and records the failed notch as a cap',
    first && first.kind === 'down' && first.to === Math.round((before - 0.25) * 100) / 100 && first.cap === first.to, out);
  const revokeAt = out.findIndex(d => d.revoke);
  check('slow: the level-up earned at 1.5 stands until the ceiling drops BELOW 1.5',
    revokeAt !== -1 && out[revokeAt].from === 1.5 && out[revokeAt].to === 1.25 && out.slice(0, revokeAt).every(d => !d.revoke), out);
  check('slow: it descends to the floor and no further', c.ceiling === 1, c.ceiling);
  const lvl = out.find(d => d.proposeLevel != null);
  check('slow: once below the start ratio it proposes the level below, and blocks everything above that',
    lvl && lvl.proposeLevel === 2 && lvl.block && lvl.block.level === 3 && lvl.block.until > now + A.BLOCK_MS - 60000 && lvl.block.until <= now + A.BLOCK_MS, lvl);
  check('slow: only one level proposal per load', out.filter(d => d.proposeLevel != null).length === 1, out);
}
{ // the edges of the band, with no cadence known: < 20 ms is headroom, > 34 ms is slow
  const edge = ms => { const c = tabletController(); return run(c, frames(ms, 4 * W)).out.map(d => d.kind); };
  check('19 ms frames are headroom', edge(19)[0] === 'up', edge(19));
  check('21 ms frames are not', edge(21).length === 0, edge(21));
  check('33.3 ms (vsync-locked 30 fps) holds', edge(33.3).length === 0, edge(33.3));
  check('35 ms frames step down', edge(35)[0] === 'down', edge(35));
}
{ // the dead band never moves
  const c = tabletController();
  const { out } = run(c, frames(25, 3000));
  check('dead band (25 ms): no decision at all', out.length === 0 && c.ceiling === 1, out);
}
{ // a single slow window between fast ones is not "sustained"
  const c = tabletController();
  run(c, frames(8, 2 * W));           // 1 -> 1.5
  // 1.25 s of 50 ms frames: less than one window span (WINDOW_SPAN_MS), so at most one slow window.
  const series = frames(8, W).concat(frames(50, 25), frames(8, 3 * W));
  const { out } = run(c, series, 50000);
  check('one slow window between fast ones: no step down', out.every(d => d.kind !== 'down'), out);
}
{ // oscillating: fast windows and slow windows in pairs, forever
  const c = tabletController();
  const series = [];
  for (let i = 0; i < 40; i++) series.push(...frames(8, 2 * W), ...frames(50, 2 * W));
  const { out } = run(c, series);
  const kinds = out.map(d => d.kind);
  let reversals = 0;
  for (let i = 1; i < kinds.length; i++) if (kinds[i] !== kinds[i - 1]) reversals++;
  const ups = out.filter(d => d.kind === 'up' && d.to != null);
  const afterFirstDown = out.slice(kinds.indexOf('down'));
  check('oscillating: after the first step down it never steps DPR up again',
    kinds.indexOf('down') !== -1 && afterFirstDown.every(d => !(d.kind === 'up' && d.to != null)), out);
  check('oscillating: at most one up->down reversal', reversals <= 1, kinds);
  check('oscillating: bounded number of steps', ups.length <= 3 && out.length <= 8, out.length);
}
{ // a blocked level is not proposed until the block expires
  const blocked = { level: 2, until: 1e12 };
  const c = tabletController({ blocked });
  const { out } = run(c, frames(8, 2000));
  check('blocked level 2: no proposal, DPR still climbs', out.every(d => d.proposeLevel == null) && c.ceiling === 2, out);
  const c2 = tabletController({ blocked: { level: 2, until: 5 } });
  const r2 = run(c2, frames(8, 2000));
  check('expired block: proposes again', r2.out.some(d => d.proposeLevel === 2), r2.out);
}
{ // a desktop that is slow at its start ratio proposes a lower level
  const c = A.createController({ floor: 1, startRatio: 1, maxRatio: 1, level: 4,
    ctx: { maxLevel: 4, mobile: false, shadows: 'auto' } });
  const { out } = run(c, frames(50, 200));
  check('desktop at DPR 1, sustained 50 ms: proposes ultra-lite, blocks ultra',
    out.length === 1 && out[0].to === null && out[0].proposeLevel === 3 && out[0].block.level === 4, out);
  const quiet = A.createController({ floor: 1, startRatio: 1, maxRatio: 1, level: 4,
    ctx: { maxLevel: 4, mobile: false, shadows: 'auto' } });
  check('desktop at DPR 1, fast: nothing happens', run(quiet, frames(6, 2000)).out.length === 0);
}

{ // plan r2 M2: failing 1.75 does not undo a level-up earned at 1.5
  const c = tabletController();
  run(c, frames(8, 6 * W));                     // 1 -> 1.5, then propose mid + 1.75
  check('setup: proposed at 1.5 and now at 1.75', c.pending === 2 && c.ceiling === 1.75, { p: c.pending, c: c.ceiling });
  const { out } = run(c, frames(45, 2 * W), 90000);
  check('a failed 1.75 steps back to 1.5 and keeps the proposal', out.length === 1 && out[0].to === 1.5 && !out[0].revoke && c.pending === 2, out);
}
{ // plan r2 M3: a stored cap is where the session tops out
  const c = tabletController({ dprCap: 1.75 });
  run(c, frames(8, 3000));
  check('dprCap 1.75: never climbs to 2', c.ceiling === 1.75 && c.sessionMax === 1.75, c.ceiling);
  const low = tabletController({ dprCap: 1.25 });
  const { out } = run(low, frames(8, 2 * W));
  check('dprCap below the start ratio: the first jump goes to the cap', out[0] && out[0].to === 1.25, out);
}
{ // plan r2 M4: under shadows=low a step down from ultra blocks its twin too
  const ctx = { maxLevel: 4, mobile: true, shadows: 'low' };
  const c = A.createController({ floor: 1, startRatio: 1.5, maxRatio: 1.5, level: 4, ctx });
  const { out } = run(c, frames(50, 4 * W));
  const d = out.find(x => x.proposeLevel != null);
  check('shadows=low: ultra falls back to mid (ultra-lite is its twin) and blocks 3 and up',
    d && d.proposeLevel === 2 && d.block.level === 3, out);
  const next = A.createController({ floor: 1, startRatio: 1.5, maxRatio: 2, level: 2, ctx, blocked: d && d.block });
  const r = run(next, frames(8, 3000));
  check('the next load at mid never re-proposes the twin', r.out.every(x => x.proposeLevel == null), r.out);
}
{ // plan r2 M5: the cold frame
  const mk = level => A.createController({ floor: 1, startRatio: 1.5, maxRatio: 2, level,
    ctx: { maxLevel: 4, mobile: true, shadows: 'auto' }, defaultLevel: 1 });
  const d = mk(4).coldFrame(4000, 1000);
  check('a 4 s first frame at ultra (above the default) proposes ultra-lite and blocks ultra',
    d && d.proposeLevel === 3 && d.block.level === 4 && d.block.until === 1000 + A.BLOCK_MS, d);
  check('a cold frame under COLD_FRAME_MS does nothing', mk(4).coldFrame(A.COLD_FRAME_MS - 1, 0) === null);
  check('never below the default level (a mobile at mid-lite)', mk(1).coldFrame(60000, 0) === null);
  const desk = A.createController({ floor: 1, startRatio: 2, maxRatio: 2, level: 4,
    ctx: { maxLevel: 4, mobile: false, shadows: 'auto' }, defaultLevel: 4 });
  check('a desktop at its own default build is never touched by a cold frame', desk.coldFrame(45000, 0) === null);
}
{ // plan r2 M1: thresholds relative to the capped cadence
  const hz = f => 1000 / f;
  const minFrame = 1000 / 60 - 1;   // the page's 60 fps cap
  check('estimateVsync snaps the (third) smallest tick to a standard rate',
    Math.abs(A.estimateVsync([8.4, 16.6, 8.3, 25, 8.35]) - hz(120)) < 1e-9 && Math.abs(A.estimateVsync([6.95, 13.9, 6.9, 6.96]) - hz(144)) < 1e-9 &&
    A.estimateVsync([]) === 0 && A.estimateVsync([1, 2]) === 0 && A.estimateVsync([8.3, 8.3]) === 0);
  check('estimateVsync: slow frames cannot inflate it while a few idle ticks are in the history',
    Math.abs(A.estimateVsync([...frames(41.7, 200), 8.33, 8.34, 8.33]) - hz(120)) < 1e-9);
  check('estimateVsync: one freak short gap does not lock in a faster display (plan review r3)',
    Math.abs(A.estimateVsync([...frames(6.94, 100), 4.1]) - hz(144)) < 1e-9);
  check('estimateVsync is sticky: a fully saturated history cannot raise a known refresh (plan review r2, N1)',
    Math.abs(A.estimateVsync(frames(25, 240), hz(120)) - hz(120)) < 1e-9 &&
    Math.abs(A.estimateVsync(frames(40, 240), hz(120)) - hz(120)) < 1e-9);
  check('estimateVsync never reads slower than 60 Hz, even saturated from the start',
    Math.abs(A.estimateVsync(frames(40, 240)) - hz(60)) < 1e-9);
  { // the reviewer's scenario: a mobile at 40 ms frames with a saturated tick history
    const c = tabletController();
    let now = 0, vs = hz(120);
    const ticks = [];
    const out = [];
    for (let i = 0; i < 2000; i++) {
      now += 40;
      ticks.push(40); if (ticks.length > 240) ticks.shift();
      if (i % 30 === 0) vs = A.estimateVsync(ticks, vs);
      const r = c.feed({ ms: 40, now, continuous: true, cadence: A.capCadence(minFrame, vs), vsync: vs, wall: now });
      if (r && r.decision) out.push(r.decision.kind);
    }
    check('saturated 40 ms frames on a 120 Hz tablet never step up', out.length && out.every(k => k === 'down'), out);
  }
  const cad = f => A.capCadence(minFrame, hz(f));
  check('60 fps cap cadence: 16.7 @60/120, 20 @100, 20.8 @144, 26.7 @75',
    Math.abs(cad(60) - 16.667) < 0.01 && Math.abs(cad(120) - 16.667) < 0.01 && Math.abs(cad(100) - 20) < 0.01 &&
    Math.abs(cad(144) - 20.833) < 0.01 && Math.abs(cad(75) - 26.667) < 0.01, [60, 120, 100, 144, 75].map(cad));
  check('uncapped cadence is one refresh', Math.abs(A.capCadence(0, hz(120)) - hz(120)) < 1e-9);
  for (const f of [60, 75, 100, 120, 144]) {
    const t = A.thresholds(cad(f), hz(f));
    check(`${f} Hz + 60 fps cap: the capped cadence is headroom`, cad(f) < t.up, { cad: cad(f), t });
    check(`${f} Hz + 60 fps cap: one missed refresh is not headroom`, cad(f) + hz(f) >= t.up, { t });
    check(`${f} Hz: the dead band is at least a refresh wide, and down >= 34`, t.down - t.up >= hz(f) - 1e-9 && t.down >= A.DOWN_MS, t);
  }
  check('no cadence known: UP_MS / DOWN_MS', A.thresholds(0, 0).up === A.UP_MS && A.thresholds(0, 0).down === A.DOWN_MS);
  // A 144 Hz desktop under the 60 fps cap: every frame lands at 20.8 ms.
  const c = A.createController({ floor: 1, startRatio: 2, maxRatio: 2, level: 4, ctx: { maxLevel: 4, mobile: false, shadows: 'auto' } });
  let now = 0, got = null;
  for (let i = 0; i < 3 * W && !got; i++) {
    now += cad(144);
    const r = c.feed({ ms: cad(144), now, continuous: true, cadence: cad(144), vsync: hz(144) });
    if (r && r.decision) got = r.decision;
  }
  check('144 Hz + 60 fps cap at a steady 20.8 ms: ramps 1 -> 2 (plan r2 M1)', got && got.to === 2, got);
}
{ // block expiry is judged on the wall clock passed in, not the frame clock
  const c = tabletController({ blocked: { level: 2, until: 5000 } });
  let now = 0, proposals = 0;
  for (let i = 0; i < 3000; i++) {
    now += 8;
    const r = c.feed({ ms: 8, now, continuous: true, wall: 1000 });
    if (r && r.decision && r.decision.proposeLevel != null) proposals++;
  }
  check('wall clock before the block expiry: no proposal, though the frame clock is far past it', proposals === 0);
}

{ // browser-side rAF throttling (found live: the review browser idles at 10 Hz)
  check('idle ticks at 10 Hz -> throttled', A.rafThrottle(frames(100, 8)).throttled === true && A.rafThrottle(frames(100, 8)).fps === 10);
  check('idle ticks at 30 Hz (power saving) -> throttled', A.rafThrottle(frames(33.3, 8)).throttled === true);
  check('idle ticks at 60 / 120 Hz -> not throttled',
    A.rafThrottle(frames(16.7, 8)).throttled === false && A.rafThrottle(frames(8.3, 20)).throttled === false);
  check('fewer than 5 idle ticks -> not throttled (no evidence)', A.rafThrottle(frames(100, 4)).throttled === false);
  check('a couple of slow idle ticks among fast ones -> not throttled (median)',
    A.rafThrottle([...frames(16.7, 7), 100, 120]).throttled === false);
  check('a couple of fast idle ticks among slow ones -> still throttled (median, not minimum)',
    A.rafThrottle([...frames(100, 6), 8.3, 8.3]).throttled === true);
  // Code review r1 M1: a throttled device still ends at the start ratio,
  // unmeasured -- what main did -- rather than at the 1.0 first paint forever.
  const at30 = A.rafThrottle(frames(33.3, 8));
  const tab = tabletController();
  const jt = at30.throttled ? tab.jumpToStart() : null;
  check('30 Hz throttled tablet: jumps 1 -> 1.5 unmeasured, no level proposal',
    jt && jt.to === 1.5 && jt.unmeasured === true && jt.proposeLevel == null && tab.ceiling === 1.5 && tab.pending == null, jt);
  const desk = A.createController({ floor: 1, startRatio: 2, maxRatio: 2, level: 4, ctx: { maxLevel: 4, mobile: false, shadows: 'auto' } });
  check('30 Hz throttled high-DPI desktop: ends at DPR 2 (main\'s behaviour)', desk.jumpToStart().to === 2 && desk.ceiling === 2);
  check('jumpToStart is idempotent', desk.jumpToStart() === null);
  check('jumpToStart honours a stored cap', tabletController({ dprCap: 1.25 }).jumpToStart().to === 1.25);
}

// ---- 3. sample rejection ------------------------------------------------------
{
  const c = tabletController();
  let now = 1000;
  const feedN = (n, extra) => { let r = null; for (let i = 0; i < n; i++) { now += 8; r = c.feed(Object.assign({ ms: 8, now, continuous: true, lowered: false }, extra)) || r; } return r; };
  check('idle gaps (continuous=false) never count', feedN(500, { continuous: false }) === null && c.ceiling === 1);
  check('drag frames at a lowered ratio never count', feedN(500, { lowered: true }) === null && c.ceiling === 1);
  check('a stall longer than MAX_SAMPLE_MS never counts', c.feed({ ms: 5000, now: now += 5000, continuous: true }) === null);
  c.quiet(now, 10000);
  check('quiet(): samples inside the quiet window never count', feedN(500) === null && c.ceiling === 1);
  now += 10000;
  const r = feedN(2 * W);
  check('after the quiet window the same frames do count', r && r.verdict === 'up' && c.ceiling === 1.5, r);
  check('a step starts a settle window (SETTLE_MS)', (() => { let hit = null; for (let i = 0; i < 30; i++) { now += 8; hit = c.feed({ ms: 8, now, continuous: true }) || hit; } return hit === null; })());
}

// ---- 4. persistence -----------------------------------------------------------
{
  const mem = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
  const s = mem();
  const key = A.storageKey('ANGLE (ARM, Immortalis-G925 MC12, OpenGL ES 3.2)', 1024, 'low');
  check('key names the GPU, the uniform budget and the shadows mode', key === 'home3d.quality.v1|ANGLE (ARM, Immortalis-G925 MC12, OpenGL ES 3.2)|1024|low', key);
  check('embed (low) and standalone (auto) learn separately', A.storageKey('g', 1024, 'auto') !== A.storageKey('g', 1024, 'low'));
  check('masked/empty name -> unknown', A.storageKey('', 512) === 'home3d.quality.v1|unknown|512|auto');
  const full = { level: 3, blocked: { level: 4, until: 99 }, dprCap: { level: 3, ratio: 1.75, until: 99 }, settled: null };
  check('save then load round-trips', A.saveState(s, key, full) === true &&
    JSON.stringify(A.loadState(s, key, 4)) === JSON.stringify(full), A.loadState(s, key, 4));
  check('stored level is clamped to what compiles', A.loadState(s, key, 2).level === 2);
  s.setItem(key, '{not json');
  check('garbage JSON -> null', A.loadState(s, key, 4) === null);
  s.setItem(key, JSON.stringify({ v: 2, level: 4 }));
  check('wrong version -> null', A.loadState(s, key, 4) === null);
  s.setItem(key, JSON.stringify({ v: 1, level: 'ultra' }));
  check('non-integer level -> no level', A.loadState(s, key, 4).level === null);
  const boom = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('x'); } };
  let threw = false;
  try {
    check('throwing storage: load -> null', A.loadState(boom, key, 4) === null);
    check('throwing storage: save -> false', A.saveState(boom, key, { level: 1 }) === false);
    check('throwing storage: clear -> false', A.clearState(boom, key) === false);
    check('no storage at all: load null, save false', A.loadState(null, key, 4) === null && A.saveState(null, key, { level: 1 }) === false);
  } catch (e) { threw = true; }
  check('storage failures never throw', !threw);
  A.saveState(s, key, { level: 1 });
  check('clearState removes the key', A.clearState(s, key) === true && s.getItem(key) === null);
}

// ---- 5. the scene wires it ----------------------------------------------------
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('scene: imports the controller', /from '\.\/adaptive-quality\.js'/.test(src));
  check('scene: ?tier= (an override) turns adaptation off',
    /adaptiveOff = tierInfo\.overridden \?/.test(src));
  check('scene: the build comes from levelConfig', /levelConfig\(startLevelIdx, levelCtx\)/.test(src));
  check('scene: storage is only touched when adaptation is on',
    /const stored = adaptiveOff \? null : loadState\(/.test(src));
  check('scene: the loop feeds rendered-frame intervals (rAF timestamps) with the continuity flag and cadence',
    /adaptive\.feed\(\{ ms: tickTs - prevRenderAt, now: frameNow, continuous: frameContinuous, lowered: appliedRatio < ceilingRatio - RATIO_EPSILON, cadence: cadenceMs, vsync: vsyncMs, wall: Date\.now\(\) \}\)/.test(src));
  check('scene: the fps cap is timed on the rAF timestamp', /if \(minFrameMs && \(tickTs - lastRenderTs\) < minFrameMs\) \{ gateIdleTicks = 0; return; \}/.test(src));
  check('scene: nothing is fed, and no probe starts, while the browser throttles rAF',
    /if \(prevRenderAt && !browserThrottled\(\)\) \{/.test(src) && /if \(browserThrottled\(\)\) return false;/.test(src));
  check('scene: throttling is judged on idle-gate ticks only',
    /if \(adaptive && \+\+gateIdleTicks >= 3 && lastTickDelta > 0\) \{\s*idleDeltas\.push\(lastTickDelta\);/.test(src) &&
    /gateIdleTicks = 0;/.test(src));
  check('scene: the in-use maintenance probe needs a recent interaction, never runs during one, and is spaced out',
    /if \(interacting \|\| !lastInteractAt \|\| now - lastInteractAt > MAINT_ACTIVE_MS\) return false;/.test(src) &&
    /if \(now - Math\.max\(lastProbeEndAt, warmUntil\) < MAINT_PROBE_EVERY_MS\) return false;/.test(src));
  check('scene: when frames cannot be trusted it jumps to the start ratio unmeasured',
    /if \(throttleNoted \|\| now - warmUntil > UNMEASURED_JUMP_MS\) jumpUnmeasured\(\);/.test(src) &&
    /const d = adaptive && adaptive\.jumpToStart\(\);/.test(src));
  check('scene: resetQuality touches nothing with adaptation off', /resetQuality\(\) \{\s*if \(!adaptive\) return false;/.test(src));
  const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('page: Re-measure is only offered with adaptation on',
    /\(home\.getQualityStatus\(\)\.adaptive\s*\? '<button class="spec-btn" id="panel-quality-reset"/.test(page));
  check('scene: pausing clears continuity', /if \(paused\) \{ frameContinuous = false; gateIdleTicks = 0; return; \}/.test(src));
  check('scene: with adaptation off the old ramp still runs', /\} else \{\s*sampleRampFrame\(frameNow, renderMs, interacting\);/.test(src));
  check('scene: a stored DPR cap only applies to the level it was learned at',
    /stored\.dprCap\.level === startLevelIdx/.test(src));
  check('scene: cold frames are judged on the call time or the gap it left, whichever is longer',
    /sampleColdFrame\(Math\.max\(renderMs, frameContinuous && prevRenderAt \? tickTs - prevRenderAt : 0\)\);/.test(src) && /adaptive\.coldFrame\(renderMs, Date\.now\(\)\)/.test(src));
  check('scene: the on-demand gate and the first-frame gate clear continuity',
    (src.match(/frameContinuous = false;\s*if \(adaptive && \+\+gateIdleTicks >= 3 && lastTickDelta > 0\)/g) || []).length === 2);
  check('scene: no idle evidence yet counts as "cannot measure"', /if \(idleDeltas\.length < 5\) return true;/.test(src));
  check('scene: the ceiling is written from the controller only', /ceilingRatio = d\.to;/.test(src));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
