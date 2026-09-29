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
 *   6-7. The probe scheduler, end to end and gate by gate.
 *   8. Detail first (task e7e10870): the v2 record, the strike, the manual
 *      pin, resolveStart/recordFor and the Settings choices. Load after load:
 *      scripts/test-adaptive-convergence.mjs.
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
  // Task e7e10870 (detail first): this is a MOBILE controller, so the level
  // is no longer proposed down on the way through 1.25 -- only once it fails
  // AT the floor, and then first as a strike; a second load that fails at
  // the floor again proposes it. (Was: proposed on crossing below 1.5.)
  check('slow (mobile): nothing is proposed while the ratio can still fall',
    out.filter(d => d.to != null).every(d => d.proposeLevel == null && !d.strike), out);
  const strike = out.find(d => d.strike);
  check('slow (mobile): failing at the floor records a strike at this level, not a proposal',
    strike && strike.from === 1 && strike.to === null && strike.strike.level === 3 &&
    out.every(d => d.proposeLevel == null) && c.pending === null && c.strike && c.strike.level === 3, out);
  const again = tabletController({ level: 3, strike: c.strike });
  const r2 = run(again, frames(45, 1000), 20000);
  const lvl = r2.out.find(d => d.proposeLevel != null);
  check('slow (mobile): failing at the floor again on the next load proposes the level below, and blocks everything above that',
    lvl && lvl.proposeLevel === 2 && lvl.from === 1 && lvl.block && lvl.block.level === 3 &&
    lvl.block.until > r2.now + A.BLOCK_MS - 60000 && lvl.block.until <= r2.now + A.BLOCK_MS, lvl);
  check('slow: only one level proposal per load', r2.out.filter(d => d.proposeLevel != null).length === 1, r2.out);
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
  // Two loads failing at the floor (task e7e10870: a mobile level-down needs
  // a strike first); the second is where the proposal and the block land.
  const c0 = A.createController({ floor: 1, startRatio: 1.5, maxRatio: 1.5, level: 4, ctx });
  run(c0, frames(50, 4 * W));
  const c = A.createController({ floor: 1, startRatio: 1.5, maxRatio: 1.5, level: 4, ctx, strike: c0.strike });
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
  // Re-measure: forget() drops the proposal and the block, so nothing in
  // memory can re-write them.
  const f = tabletController({ blocked: { level: 3, until: 1e15 } });
  run(f, frames(8, 6 * W));
  const had = f.pending;
  f.forget();
  check('forget() clears the pending proposal and the block', had === 2 && f.pending === null && f.blocked === null, { had });
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
  // v2 since task e7e10870 (the detail-first ladder): see section 8.
  check('key names the GPU, the uniform budget and the shadows mode', key === 'home3d.quality.v2|ANGLE (ARM, Immortalis-G925 MC12, OpenGL ES 3.2)|1024|low', key);
  check('embed (low) and standalone (auto) learn separately', A.storageKey('g', 1024, 'auto') !== A.storageKey('g', 1024, 'low'));
  check('masked/empty name -> unknown', A.storageKey('', 512) === 'home3d.quality.v2|unknown|512|auto');
  const full = { level: 3, blocked: { level: 4, until: 99 }, dprCap: { level: 3, ratio: 1.75, until: 99 }, strike: { level: 3, at: 42 }, settled: null };
  check('save then load round-trips', A.saveState(s, key, full) === true &&
    JSON.stringify(A.loadState(s, key, 4)) === JSON.stringify(full), A.loadState(s, key, 4));
  check('stored level is clamped to what compiles', A.loadState(s, key, 2).level === 2);
  s.setItem(key, '{not json');
  check('garbage JSON -> null', A.loadState(s, key, 4) === null);
  s.setItem(key, JSON.stringify({ v: 1, level: 4 }));
  check('wrong version (a v1 value under the v2 key) -> null', A.loadState(s, key, 4) === null);
  s.setItem(key, JSON.stringify({ v: 2, level: 'ultra' }));
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
  check('scene: nothing is fed while the browser throttles rAF, and the probe scheduler asks the same question',
    /if \(prevRenderAt && !browserThrottled\(\)\) \{/.test(src) && /throttled: browserThrottled,/.test(src));
  // The probe/jump decisions are behaviour-tested in section 6; this only pins
  // that the scene runs them through the scheduler and wires its side effects.
  check('scene: probes are decided by createProbeScheduler, and the loop asks it every tick',
    /const probes = createProbeScheduler\(\{/.test(src) &&
    /function tickProbe\(now, interacting\) \{ return probes\.tick\(now, interacting\); \}/.test(src) &&
    /if \(tickProbe\(frameNow, interacting\)\) needsRender = true;/.test(src));
  check('scene: the scheduler jumps through the controller and applies the decision',
    /jumpToStart: \(\) => adaptive\.jumpToStart\(\),/.test(src) &&
    /applyJump\(d, noted\) \{\s*applyAdaptiveDecision\(d, noted/.test(src));
  check('scene: throttling is judged on idle-gate ticks only',
    /if \(adaptive && \+\+gateIdleTicks >= 3 && lastTickDelta > 0\) \{\s*idleDeltas\.push\(lastTickDelta\);/.test(src) &&
    /gateIdleTicks = 0;/.test(src));
  check('scene: Re-measure cannot be undone later in the session (visual review r1 L1)',
    /if \(!adaptive \|\| qualityForgotten \|\| adaptive\.locked\) return;/.test(src) &&
    /qualityForgotten = true;\s*adaptive\.forget\(\);[^\n]*\n\s*dprCapState = null;\s*const ok = clearState/.test(src));
  check('scene: "capped from" only when this load is built below what compiles (visual review r1 L2)',
    /\$\{!tierInfo\.overridden && tier !== tierInfo\.compileTier \? '; capped from ' \+ tierInfo\.compileTier : ''\}/.test(src));
  check('scene: resetQuality touches nothing with adaptation off', /resetQuality\(\) \{\s*if \(!adaptive\) return false;/.test(src));
  const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('page: Re-measure is only offered with adaptation on, in Auto',
    /\(qs\.adaptive && qs\.mode === 'auto' && !pendingChange\s*\? '<button class="spec-btn quality-btn" id="panel-quality-reset"/.test(page));
  check('scene: pausing clears continuity', /if \(paused\) \{ frameContinuous = false; gateIdleTicks = 0; return; \}/.test(src));
  check('scene: with adaptation off the old ramp still runs', /\} else \{\s*sampleRampFrame\(frameNow, renderMs, interacting\);/.test(src));
  // resolveStart() is behaviour-tested in section 8; this pins that the
  // scene takes the cap (and the block, strike and lock) from it.
  check('scene: the stored DPR cap, block, strike and lock come from resolveStart',
    /const loadStart = resolveStart\(\{ stored, pin: manualLevel,/.test(src) && /const storedCap = loadStart\.dprCap;/.test(src) &&
    /blocked: loadStart\.blocked,/.test(src) && /strike: loadStart\.strike,/.test(src) && /locked: loadStart\.locked\s*\}\);/.test(src));
  check('scene: the manual pin is read only when ?tier=, the diagnostics level and the preview leave the build open',
    /const pinAllowed = !tierInfo\.overridden && !levelPinned && !autoRotate;/.test(src) &&
    /const manualLevel = pinAllowed \? loadPin\(qStorage, qPinKey, maxLevel\) : null;/.test(src) &&
    /const startLevelIdx = tierInfo\.overridden \? maxLevel\s*: levelPinned \? Math\.max\(0, Math\.min\(maxLevel, opts\.level\)\)\s*: loadStart\.level;/.test(src));
  check('scene: the record written is recordFor() (level, block, cap and strike)',
    /saveState\(qStorage, qKey, recordFor\(adaptive, startLevelIdx, dprCapState, extra\)\)/.test(src));
  check('scene: a strike, or a cleared one, is persisted when it happens',
    /if \(d\.proposeLevel != null \|\| d\.revoke \|\| d\.block \|\| d\.cap != null \|\| d\.strike \|\| d\.strikeCleared\) persistQuality\(\);/.test(src));
  check('scene: setQualityPin refuses when the build is decided elsewhere, and an unavailable level',
    /setQualityPin\(level\) \{\s*if \(!pinAllowed\) return \{ ok: false,/.test(src) &&
    /if \(!opt \|\| !opt\.available\) return \{ ok: false,/.test(src));
  check('page: the Quality choice sets the pin, and a pending change offers a Reload (never a live recompile)',
    /home\.setQualityPin\(v === 'auto' \? null : parseInt\(v, 10\)\)/.test(page) &&
    /\(pendingChange\s*\? '<button class="spec-btn quality-btn" id="panel-quality-reload"/.test(page) &&
    /panelQualityReload\.addEventListener\('click', \(\) => \{ location\.reload\(\); \}\)/.test(page));
  check('page: the readout leads with Auto / Manual', /const mode = s\.mode === 'manual' \? 'Manual' : s\.mode === 'auto' \? 'Auto' : 'Fixed';/.test(page));
  check('scene: cold frames are judged on the call time or the gap it left, whichever is longer',
    /sampleColdFrame\(Math\.max\(renderMs, frameContinuous && prevRenderAt \? tickTs - prevRenderAt : 0\)\);/.test(src) && /adaptive\.coldFrame\(renderMs, Date\.now\(\)\)/.test(src));
  check('scene: the on-demand gate and the first-frame gate clear continuity',
    (src.match(/frameContinuous = false;\s*if \(adaptive && \+\+gateIdleTicks >= 3 && lastTickDelta > 0\)/g) || []).length === 2);
  check('scene: no idle evidence yet counts as "cannot measure"', /if \(idleDeltas\.length < 5\) return true;/.test(src));
  check('scene: the ceiling is written from the controller only', /ceilingRatio = d\.to;/.test(src));
}

// ---- 6. the probe scheduler, driven end to end (task 7991c667) ----------------
// A harness standing in for the scene's loop: ticks at a fixed rate, the
// scene's own throttle test (under 5 idle deltas = cannot measure, else
// rafThrottle), a real controller, and a scene-side ceiling that only moves
// when applyJump is called -- so a jump the scheduler decides but never
// applies is caught, as is a forced frame while the browser throttles.
{
  function runIdle(hz, seconds) {
    const ctl = A.createController({ floor: 1, startRatio: 1.5, maxRatio: 2, level: 1,
      ctx: { maxLevel: 3, mobile: true, shadows: 'auto' } });
    const idleDeltas = [];
    let noted = false;
    let sceneCeiling = 1;
    let applies = 0;
    let settled = 0;
    const throttled = () => {
      if (idleDeltas.length < 5) return true;
      noted = A.rafThrottle(idleDeltas).throttled;
      return noted;
    };
    const probes = A.createProbeScheduler({
      enabled: true, probeMs: 4000, maxProbes: 6, budgetMs: 20000, warmupMs: 900,
      maintEveryMs: 180000, maintMs: 2500, maintActiveMs: 60000, unmeasuredJumpMs: 8000,
      throttled, throttleNoted: () => noted,
      jumpToStart: () => ctl.jumpToStart(),
      applyJump(d) { applies++; if (d && d.to != null) sceneCeiling = d.to; },
      furnitureBusy: () => false,
      onSettled: () => { settled++; }
    });
    const step = 1000 / hz;
    let forced = 0, forcedWhileThrottled = 0, gateIdleTicks = 0;
    for (let now = 0; now < seconds * 1000; now += step) {
      const wasThrottled = idleDeltas.length < 5 || A.rafThrottle(idleDeltas).throttled;
      if (probes.tick(now, false)) {
        forced++;
        if (wasThrottled) forcedWhileThrottled++;
        gateIdleTicks = 0;
      } else if (++gateIdleTicks >= 3) {
        idleDeltas.push(step);
        if (idleDeltas.length > 20) idleDeltas.shift();
      }
    }
    return { sceneCeiling, applies, forced, forcedWhileThrottled, noted, settled, probes };
  }

  const r30 = runIdle(30, 30);
  check('scheduler @30 Hz idle: the browser is noted as throttling', r30.noted === true);
  check('scheduler @30 Hz idle: the unmeasured jump is APPLIED (scene ends at the start ratio)',
    r30.sceneCeiling === 1.5, r30.sceneCeiling);
  check('scheduler @30 Hz idle: the jump is applied exactly once', r30.applies === 1, r30.applies);
  check('scheduler @30 Hz idle: zero forced renders over 30 s', r30.forced === 0, r30.forced);
  check('scheduler @30 Hz idle: still wants to measure (throttling is not an answer)',
    r30.probes.wantProbe === true && r30.settled === 0);

  // Non-vacuity: the same harness at 60 Hz is not throttled, so it DOES
  // force frames (probes) -- and never while the throttle test says no.
  const r60 = runIdle(60, 30);
  check('scheduler @60 Hz idle: not throttled, so probes force frames', r60.noted === false && r60.forced > 0, r60.forced);
  check('scheduler @60 Hz idle: no forced frame before idle evidence exists', r60.forcedWhileThrottled === 0, r60.forcedWhileThrottled);
  check('scheduler @60 Hz idle: no unmeasured jump when frames can be measured', r60.applies === 0 && r60.sceneCeiling === 1);
  check('scheduler @60 Hz idle: the load-probe budget runs out and it settles',
    r60.probes.wantProbe === false && r60.settled === 1 && r60.probes.probesRun === 5 && r60.probes.probeSpentMs >= 20000,
    { probesRun: r60.probes.probesRun, spent: r60.probes.probeSpentMs });

  // Disabled: never probes, never jumps.
  const off = A.createProbeScheduler({ enabled: false, throttled: () => { throw new Error('asked'); },
    jumpToStart: () => { throw new Error('asked'); } });
  let offForced = false;
  for (let t = 0; t < 20000; t += 16) offForced = off.tick(t, false) || offForced;
  check('scheduler disabled: never forces a frame and asks nothing', offForced === false && off.wantProbe === false);
}

// ---- 7. the scheduler's gates, one at a time (follow-up 968b0d4c) -------------
// Each gate driven with fake time and a scripted interaction series, with
// every other gate held open, so deleting that one gate changes an outcome:
// the no-interaction guard, maintenance spacing, the maintenance throttle
// check, maintenance probes kept out of the load budget, the 8 s unmeasured
// jump, the furniture-busy check and the warm-up gate.
{
  function sched(over) {
    const env = { throttled: false, noted: false, busy: false, jumps: [], settled: 0, jumpLeft: 1 };
    const cfg = Object.assign({
      enabled: true, probeMs: 4000, maxProbes: 6, budgetMs: 20000, warmupMs: 900,
      maintEveryMs: 180000, maintMs: 2500, maintActiveMs: 60000, unmeasuredJumpMs: 8000,
      throttled: () => env.throttled, throttleNoted: () => env.noted,
      jumpToStart: () => (env.jumpLeft-- > 0 ? { to: 1.5 } : null),
      applyJump(d, noted) { env.jumps.push({ at: env.now, to: d.to, noted }); },
      furnitureBusy: () => env.busy,
      onSettled: () => { env.settled++; }
    }, over || {});
    const s = A.createProbeScheduler(cfg);
    return { s, env, cfg };
  }
  // Drive ticks every 16 ms; interactAt(now) says whether this tick is a drag.
  // Returns the start time of every probe (a false->true edge of `probing`).
  function drive(h, fromMs, toMs, interactAt, onTick) {
    const starts = [];
    for (let now = fromMs; now < toMs; now += 16) {
      h.env.now = now;
      if (onTick) onTick(now, h);
      const was = h.s.probing;
      h.s.tick(now, interactAt ? interactAt(now) : false);
      if (!was && h.s.probing) starts.push(now);
    }
    return starts;
  }
  // Load probes are done (settled), so only the maintenance branch is live.
  function maintOnly(over) { const h = sched(over); h.s.wantProbe = false; return h; }
  // A drag of one tick every 10 s: "the user is using it".
  const dragEvery10s = (now) => now % 10000 < 16;

  // (1) No interaction yet: never a maintenance probe, however long it sits.
  {
    const h = maintOnly({ maintEveryMs: 5000 });
    const starts = drive(h, 0, 30000, null);
    check('maint: no maintenance probe before the first interaction', starts.length === 0, starts);
    // Non-vacuity: the same config with a drag DOES maintenance-probe.
    const h2 = maintOnly({ maintEveryMs: 5000 });
    const s2 = drive(h2, 0, 30000, (now) => now === 16);
    check('maint: the same config probes once the user has interacted', s2.length > 0, s2);
  }

  // (2) Spacing: at most one maintenance probe per maintEveryMs, counted from
  // the end of the last probe (or warm-up), even while the user keeps dragging.
  {
    const h = maintOnly();
    const starts = drive(h, 0, 600000, dragEvery10s);
    const warmEnd = 900;
    check('maint: the first maintenance probe waits maintEveryMs after warm-up',
      starts.length > 0 && starts[0] - warmEnd >= 180000, starts);
    let spaced = starts.length >= 2;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] - (starts[i - 1] + 2500) < 180000) spaced = false;
    }
    check('maint: consecutive maintenance probes are maintEveryMs apart (end to start)',
      spaced && starts.length <= 3, starts);
  }

  // (3) Throttled: no maintenance probe (its frames could not be trusted).
  {
    const h = maintOnly();
    h.env.throttled = true;
    const starts = drive(h, 0, 600000, dragEvery10s);
    check('maint: a throttled browser gets no maintenance probe', starts.length === 0, starts);
  }

  // (4) Maintenance probes are free: they never spend the load-probe budget.
  {
    const h = maintOnly();
    const starts = drive(h, 0, 200000, dragEvery10s);
    check('maint: a maintenance probe ran and ended', starts.length === 1 && !h.s.probing, starts);
    check('maint: the maintenance probe spent none of the load budget',
      h.s.probeSpentMs === 0, h.s.probeSpentMs);
  }

  // (5) Unmeasured jump: throttled but never NOTED (under 5 idle deltas, no
  // evidence either way) still jumps to the start ratio after
  // unmeasuredJumpMs past warm-up -- and not before.
  {
    const h = sched();
    h.env.throttled = true;
    drive(h, 0, 8800, null);
    check('jump: none before unmeasuredJumpMs has passed', h.env.jumps.length === 0, h.env.jumps);
    drive(h, 8800, 12000, null);
    check('jump: applied once, unnoted, just after warm-up + unmeasuredJumpMs',
      h.env.jumps.length === 1 && h.env.jumps[0].noted === false &&
      h.env.jumps[0].at > 8900 && h.env.jumps[0].at <= 8900 + 16 && h.env.jumps[0].to === 1.5,
      h.env.jumps);
  }

  // (6) Furniture still building: no load probe until it finishes.
  {
    const h = sched();
    h.env.busy = true;
    const starts = drive(h, 0, 30000, null, (now, hh) => { if (now >= 20000) hh.env.busy = false; });
    check('load: no probe while furniture is building', starts.length > 0 && starts[0] >= 20000, starts);
  }

  // (7) Warm-up: no load probe inside the first warmupMs.
  {
    const h = sched({ warmupMs: 3000 });
    const starts = drive(h, 0, 10000, null);
    check('load: the first probe waits out warm-up', starts.length > 0 && starts[0] >= 3000, starts);
  }
}

// ---- 8. detail first, the v2 record and the manual level (task e7e10870) -------
// The load-after-load behaviour is in scripts/test-adaptive-convergence.mjs;
// these are the pieces, one at a time.
{
  const mem = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
  const gpu = 'Mali-G925-Immortalis MC12';

  // The migration: a v1 record under the v1 key is simply not the key any more.
  const s = mem();
  const v1Key = 'home3d.quality.v1|' + gpu + '|4096|low';
  s.setItem(v1Key, JSON.stringify({ v: 1, level: 0, blocked: { level: 1, until: 9e15 }, dprCap: null, settled: null }));
  const v2Key = A.storageKey(gpu, 4096, 'low');
  check('v2: the key moved off v1', v2Key.indexOf('home3d.quality.v2|') === 0 && v2Key !== v1Key, v2Key);
  check('v2: the tablet\'s v1 record (low, mid-lite+ blocked) is not read', A.loadState(s, v2Key, 4) === null);
  const st = A.resolveStart({ stored: A.loadState(s, v2Key, 4), pin: null, defaultLevel: 1, wall: 1000 });
  check('v2: so the next load starts at the mobile default (mid-lite), unblocked', st.level === 1 && st.from === 'default' && st.blocked === null, st);
  check('every key shares STORAGE_PREFIX (diagnostics guards them all)',
    v2Key.indexOf(A.STORAGE_PREFIX) === 0 && A.pinKey(gpu, 4096, 'low').indexOf(A.STORAGE_PREFIX) === 0 && v1Key.indexOf(A.STORAGE_PREFIX) === 0);

  // The pin: per GPU/budget/shadows mode, separate from the adaptive record.
  const pk = A.pinKey(gpu, 4096, 'low');
  check('pin: the popup (low) and the page (auto) keep separate pins', pk !== A.pinKey(gpu, 4096, 'auto') && pk !== v2Key, pk);
  check('pin: nothing stored -> null (Auto)', A.loadPin(s, pk, 4) === null);
  check('pin: save then load round-trips', A.savePin(s, pk, 3) === true && A.loadPin(s, pk, 4) === 3);
  check('pin: the page is not pinned by the popup\'s choice', A.loadPin(s, A.pinKey(gpu, 4096, 'auto'), 4) === null);
  check('pin: a level this GPU cannot compile -> null, not clamped', A.loadPin(s, pk, 2) === null);
  check('pin: Auto (null) removes it', A.savePin(s, pk, null) === true && s.getItem(pk) === null && A.loadPin(s, pk, 4) === null);
  s.setItem(pk, '{nope'); check('pin: garbage -> null', A.loadPin(s, pk, 4) === null);
  s.setItem(pk, JSON.stringify({ v: 1, level: 'ultra' })); check('pin: non-integer -> null', A.loadPin(s, pk, 4) === null);
  s.setItem(pk, JSON.stringify({ v: 2, level: 1 })); check('pin: unknown version -> null', A.loadPin(s, pk, 4) === null);
  const boom = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  check('pin: throwing storage never throws', A.loadPin(boom, pk, 4) === null && A.savePin(boom, pk, 1) === false && A.savePin(null, pk, 1) === false);
  check('Re-measure (clearState on the adaptive key) leaves the pin alone',
    (A.savePin(s, pk, 2), A.saveState(s, v2Key, { level: 3 }), A.clearState(s, v2Key), A.loadPin(s, pk, 4) === 2));

  // resolveStart: the scene's start, exactly.
  const stored = { level: 3, blocked: { level: 4, until: 5000 }, dprCap: { level: 3, ratio: 1, until: 5000 }, strike: { level: 3, at: 10 }, settled: null };
  const a = A.resolveStart({ stored, pin: null, defaultLevel: 1, wall: 1000 });
  check('resolveStart: the stored level, its cap, block and strike', a.level === 3 && a.from === 'stored' && !a.locked &&
    a.dprCap === stored.dprCap && a.blocked === stored.blocked && a.strike === stored.strike, a);
  const b = A.resolveStart({ stored, pin: 1, defaultLevel: 1, wall: 1000 });
  check('resolveStart: a manual level wins, locks, and drops the strike and the other level\'s cap',
    b.level === 1 && b.from === 'manual' && b.locked === true && b.strike === null && b.dprCap === null, b);
  const b2 = A.resolveStart({ stored, pin: 3, defaultLevel: 1, wall: 1000 });
  check('resolveStart: a manual level keeps the ratio cap learnt at that level', b2.dprCap === stored.dprCap && b2.strike === null, b2);
  const c = A.resolveStart({ stored, pin: null, defaultLevel: 1, wall: 6000 });
  check('resolveStart: an expired cap is dropped', c.dprCap === null && c.level === 3, c);
  const c30 = A.resolveStart({ stored, pin: null, defaultLevel: 1, wall: 30 * 24 * 3600e3 });
  check('resolveStart: a strike has no clock -- still there 30 days later (round 2)', c30.strike === stored.strike, c30);
  const mb = A.resolveStart({ stored: Object.assign({}, stored, { blocked: { level: 4, until: 5000, loadsLeft: 3 } }), pin: null, defaultLevel: 1, wall: 1000 });
  check('resolveStart: a mobile block counts this load (loadsLeft 3 -> 2), without touching the stored object',
    mb.blocked.loadsLeft === 2 && mb.blocked.until === 5000 && mb.blocked !== stored.blocked, mb.blocked);
  const mp = A.resolveStart({ stored: Object.assign({}, stored, { blocked: { level: 4, until: 5000, loadsLeft: 3 } }), pin: 3, defaultLevel: 1, wall: 1000 });
  check('resolveStart: a manual load does not count against a block', mp.blocked.loadsLeft === 3, mp.blocked);
  const e = A.resolveStart({ stored: Object.assign({}, stored, { level: 2 }), pin: null, defaultLevel: 1, wall: 1000 });
  check('resolveStart: a cap or strike learnt at another level is dropped', e.level === 2 && e.dprCap === null && e.strike === null, e);
  check('resolveStart: nothing stored -> the default', A.resolveStart({ stored: null, pin: null, defaultLevel: 4, wall: 0 }).level === 4);
  check('resolveStart: pin 0 (Low) is a pin, not "nothing"', A.resolveStart({ stored, pin: 0, defaultLevel: 1, wall: 0 }).level === 0);

  // recordFor
  const ctl = tabletController({ level: 2 });
  run(ctl, frames(8, 6 * W));
  const rec = A.recordFor(ctl, 2, { level: 2, ratio: 1.5, until: 9 }, { settled: { level: 2 } });
  check('recordFor: the proposal as the next level, the cap, the strike, extras', rec.level === ctl.pending && rec.level === 3 &&
    rec.dprCap.ratio === 1.5 && rec.strike === null && rec.settled.level === 2, rec);
  check('recordFor: with no proposal the level stays', A.recordFor(tabletController({ level: 2 }), 2, null).level === 2);

  // The locked (manual) controller.
  const lk = tabletController({ level: 3, locked: true });
  const lr = run(lk, frames(8, 2000));
  check('locked, fast: DPR climbs, no level proposal', lk.ceiling === 2 && lr.out.every(d => d.proposeLevel == null) && lk.pending === null, lr.out);
  check('locked: canGoUp is false once the ratio is at the top', lk.canGoUp(1e9) === false);
  const ls = tabletController({ level: 3, locked: true, strike: { level: 3, until: 1e15 } });
  const lsr = run(ls, frames(60, 3000));
  check('locked, slow: DPR falls to the floor and nothing else -- no proposal, no strike, no block',
    ls.ceiling === 1 && lsr.out.every(d => d.proposeLevel == null && !d.strike && !d.block) && ls.blocked === null, lsr.out);
  check('locked: a cold frame changes nothing', tabletController({ level: 4, locked: true, defaultLevel: 1 }).coldFrame(60000, 0) === null);

  // The strike, one rule at a time.
  const sk = tabletController({ level: 3, strike: { level: 3, until: 1e15 } });
  const skr = run(sk, frames(8, 2 * W));
  check('strike: sustained headroom at the level clears an earlier load\'s strike (and says so)',
    sk.strike === null && skr.out[0] && skr.out[0].strikeCleared === true, skr.out);
  const other = tabletController({ level: 2, strike: { level: 3, until: 1e15 } });
  check('strike: one recorded at another level is ignored', other.strike === null);
  // Round 2: a strike has no clock. Recorded long ago (a tablet reloaded
  // monthly) it still confirms the next failure at the floor.
  const exp = tabletController({ level: 3, strike: { level: 3, at: 5 } });
  const er = run(exp, frames(60, 3000), 60 * 24 * 3600e3);
  check('strike: an old one (60 days) still confirms -- proposed down and blocked',
    er.out.some(d => d.proposeLevel === 2 && d.block && d.block.level === 3) && er.out.every(d => !d.strike), er.out);
  // Round 2: on a mobile GPU a block also outlasts BLOCK_LOADS loads.
  const blk = er.out.find(d => d.block).block;
  check('block (mobile): carries BLOCK_LOADS loads as well as BLOCK_MS', blk.loadsLeft === A.BLOCK_LOADS && A.BLOCK_LOADS >= 2, blk);
  const late = tabletController({ level: 2, dprCap: 1, blocked: { level: 3, until: 5, loadsLeft: 1 } });
  run(late, frames(8, 3 * W), 1e9);
  check('block (mobile): past BLOCK_MS but with loads left, still blocks', late.pending === null, late.pending);
  const done = tabletController({ level: 2, dprCap: 1, blocked: { level: 3, until: 5 } });
  run(done, frames(8, 3 * W), 1e9);
  check('block (mobile): past BLOCK_MS and no loads left, expires', done.pending === 3, done.pending);
  const deskBlk = A.createController({ floor: 1, startRatio: 1, maxRatio: 1, level: 4, ctx: { maxLevel: 4, mobile: false, shadows: 'auto' } });
  const dbr = run(deskBlk, frames(50, 200)).out.find(d => d.block);
  check('block (desktop): wall-clock only, as before -- no load count', dbr && dbr.block.loadsLeft === undefined, dbr);
  const twice = tabletController({ level: 3 });
  const tr = run(twice, frames(60, 6000));
  check('strike: failing at the floor all session long is ONE strike, never a proposal in the same load',
    tr.out.filter(d => d.strike).length === 1 && tr.out.every(d => d.proposeLevel == null), tr.out);
  const up = tabletController({ level: 1 });
  run(up, frames(8, 3 * W));                       // 1 -> 1.5
  run(up, frames(50, 8 * W), 40000);               // 1.5 -> 1.25 -> 1, then strike
  const upr = run(up, frames(8, 8 * W), 90000);    // holds at 1 again
  check('strike: a level that failed at the floor this load proposes no level up this load',
    up.strike && up.strike.level === 1 && up.pending === null && upr.out.every(d => d.proposeLevel == null), { out: upr.out, strike: up.strike });
  // A stored cap of 1.0 puts the start ratio at the floor, so the level-up
  // is earned there; then the floor fails.
  const rv2 = tabletController({ level: 3, dprCap: 1 });
  run(rv2, frames(8, 2 * W));                      // at the floor with headroom: proposes 4
  const rvp = rv2.pending;
  const rvr = run(rv2, frames(60, 4 * W), 50000);
  check('strike: a floor failure withdraws a level-up proposed this load',
    rvp === 4 && rv2.pending === null && rvr.out.some(d => d.revoke && d.strike), { rvp, out: rvr.out });

  // levelOptions: what Settings offers.
  const full = A.levelOptions({ maxLevel: 4, mobile: true, shadows: 'auto' });
  check('options: five levels in ladder order with plain labels', full.map(o => o.label).join('|') === 'Low|Medium (lite)|Medium|High|Max' && full.every(o => typeof o.hint === 'string' && o.hint.length > 0) &&
    full.map(o => o.name).join() === 'low,mid-lite,mid,ultra-lite,ultra', full);
  check('options: all available on an ultra-compiling GPU on the page', full.every(o => o.available && o.reason === null), full);
  const mid = A.levelOptions({ maxLevel: 2, mobile: true, shadows: 'auto' });
  check('options: above what compiles -> disabled, with the reason', mid[3].available === false && mid[4].available === false &&
    /cannot compile/.test(mid[3].reason) && mid[2].available === true, mid);
  const popup = A.levelOptions({ maxLevel: 4, mobile: true, shadows: 'low' });
  check('options: in the popup (shadows=low) Max builds what High builds -> disabled, says so',
    popup[4].available === false && popup[4].reason === 'same as High here' && popup[3].available === true, popup);
  // Round 2: a running level is NAMED as the cheapest level that builds the same thing.
  check('equivalentLevel: ultra in the popup is High (ultra-lite)', A.equivalentLevel(4, { maxLevel: 4, mobile: false, shadows: 'low' }) === 3);
  check('equivalentLevel: ultra on the page is itself', A.equivalentLevel(4, { maxLevel: 4, mobile: false, shadows: 'auto' }) === 4);
  check('equivalentLevel: every other level is itself on the page',
    [0, 1, 2, 3].every(l => A.equivalentLevel(l, { maxLevel: 4, mobile: true, shadows: 'auto' }) === l));
  {
    const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
    const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    check('scene: the readout label is the equivalent level\'s',
      src.indexOf('levelLabel: LEVEL_LABELS[equivalentLevel(startLevelIdx, levelCtx)],') !== -1 &&
      src.indexOf('levelLabelName: LEVELS[equivalentLevel(startLevelIdx, levelCtx)].name,') !== -1);
    const BS = String.fromCharCode(92);
    check('page: the readout keeps each item whole (no-break spaces, word joiner after - and the en dash)',
      page.indexOf("b.replace(/ /g, '" + BS + "u00a0').replace(/([-" + BS + "u2013])/g, '$1" + BS + "u2060')") !== -1);
    check('page: each option carries its hint as a tooltip', page.indexOf(`' title="' + o.hint + '">' + o.label`) !== -1);
  }
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
