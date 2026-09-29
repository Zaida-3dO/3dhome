#!/usr/bin/env node
/**
 * Adaptive quality, load after load (task e7e10870): does the ladder settle
 * where it should, and stay there? No framework: `node scripts/test-adaptive-convergence.mjs`.
 *
 * Each simulated LOAD does what the scene (src/home3d-scene.js) does, with
 * the module's own functions: loadState/loadPin -> resolveStart ->
 * createController + createProbeScheduler -> frames at 60 Hz whose interval
 * comes from a device PROFILE (level x pixel ratio) -> each decision applied
 * and persisted with recordFor/saveState exactly as applyAdaptiveDecision and
 * logAdaptiveSettled do. The next load reads what this one wrote.
 *
 * THE TABLET PROFILE is shaped like the wall tablet's measurements (Galaxy
 * Tab S11, Mali-G925, Home Assistant app WebView, 60 Hz; 5 /diagnostics runs
 * on 2026-09-28). Synthetic numbers -- no run file is read or committed:
 *
 *   level        DPR 1        1.5          2
 *   low          16.7         16.7         16.7
 *   mid-lite     16.7         50           60
 *   mid          16.7         50           60
 *   ultra-lite   16.8         50           66.7
 *   ultra        100          150          200
 *
 * Every frame of a probe takes the table's p95 (so p95 == the table). The
 * runs did not measure 1.25 or 1.75: the PESSIMISTIC variant gives an
 * unmeasured ratio the next measured ratio above it (1.25 behaves like 1.5),
 * the OPTIMISTIC one the next below (1.25 behaves like 1.0).
 *
 * Starting state: the tablet's real stored record under the old key --
 * `low`, with mid-lite and above blocked for a week (a v1 record, synthetic
 * values in the real shape).
 */
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

const VSYNC = 1000 / 60;
const MIN_FRAME = 1000 / 60 - 1;           // the page's 60 fps cap (index.html maxFps 60)
const CADENCE = A.capCadence(MIN_FRAME, VSYNC);
const HOUR = 3600 * 1000;
const WALL0 = Date.UTC(2026, 8, 29, 9, 0, 0);
const GPU = 'Mali-G925-Immortalis MC12';
const FRAG_U = 4096;

// ---- device profiles --------------------------------------------------------
const TABLET = {
  low: { 1: 16.7, 1.5: 16.7, 2: 16.7 },
  'mid-lite': { 1: 16.7, 1.5: 50, 2: 60 },
  mid: { 1: 16.7, 1.5: 50, 2: 60 },
  'ultra-lite': { 1: 16.8, 1.5: 50, 2: 66.7 },
  ultra: { 1: 100, 1.5: 150, 2: 200 }
};
const MEASURED = [1, 1.5, 2];
function profileMs(table, variant) {
  return (levelName, dpr) => {
    const row = table[levelName];
    if (row[dpr] != null) return row[dpr];
    const up = MEASURED.find(r => r > dpr), down = MEASURED.slice().reverse().find(r => r < dpr);
    return variant === 'optimistic' ? row[down] : row[up];
  };
}

function mem(init) {
  const m = new Map(Object.entries(init || {}));
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}

/**
 * One load. dev: { mobile, maxRatio, frameMs(levelName, dpr), coldMs(levelName, loadIndex) }.
 * Returns { level, levelName, from, dpr, decisions, record }.
 */
function simulateLoad(storage, dev, shadows, loadIndex) {
  const wall0 = WALL0 + loadIndex * HOUR;
  const maxLevel = 4;
  const ctx = { maxLevel, mobile: dev.mobile, shadows };
  const key = A.storageKey(GPU, FRAG_U, shadows);
  const pin = A.loadPin(storage, A.pinKey(GPU, FRAG_U, shadows), maxLevel);
  const def = A.defaultLevel(dev.mobile, maxLevel);
  const start = A.resolveStart({ stored: A.loadState(storage, key, maxLevel), pin, defaultLevel: def, wall: wall0 });
  const ctl = A.createController({
    floor: 1, startRatio: dev.mobile ? Math.min(dev.maxRatio, A.MOBILE_START_RATIO) : dev.maxRatio, maxRatio: dev.maxRatio,
    level: start.level, ctx, blocked: start.blocked, dprCap: start.dprCap ? start.dprCap.ratio : null,
    defaultLevel: def, strike: start.strike, locked: start.locked
  });
  const levelName = A.LEVELS[start.level].name;
  let dprCapState = start.dprCap;
  let now = 0;
  const wall = () => wall0 + now;
  const decisions = [];
  let settledLogged = false;
  const persist = extra => { if (!ctl.locked) A.saveState(storage, key, A.recordFor(ctl, start.level, dprCapState, extra)); };
  function apply(d) {
    decisions.push(d);
    if (d.cap != null) dprCapState = { level: start.level, ratio: d.cap, until: wall() + A.BLOCK_MS };
    if (d.proposeLevel != null || d.revoke || d.block || d.cap != null || d.strike || d.strikeCleared) persist();
    if (d.kind === 'down') settledLogged = false;
  }
  function settle() {
    if (settledLogged) return;
    settledLogged = true;
    persist({ settled: { level: start.level, dpr: ctl.ceiling, p95: ctl.lastP95, at: wall() } });
  }
  const probes = A.createProbeScheduler({
    enabled: true, probeMs: 4000, maxProbes: 6, budgetMs: 20000, warmupMs: 900,
    maintEveryMs: 180000, maintMs: 2500, maintActiveMs: 60000, unmeasuredJumpMs: 8000,
    throttled: () => false, throttleNoted: () => false,
    jumpToStart: () => ctl.jumpToStart(), applyJump: d => apply(d),
    furnitureBusy: () => false, onSettled: settle
  });
  // The cold frames: the first five rendered after ready (the scene's
  // coldFramesLeft), judged on their own.
  let coldLeft = 5;
  let continuous = false;
  while (now < 60000) {
    if (!probes.tick(now, false)) { continuous = false; now += VSYNC; continue; }
    const ms = dev.frameMs(levelName, ctl.ceiling);
    now += ms;
    if (coldLeft > 0) {
      coldLeft--;
      const cold = dev.coldMs ? dev.coldMs(levelName, loadIndex, 5 - coldLeft) : ms;
      const d = ctl.coldFrame(cold, wall());
      if (d) { coldLeft = 0; apply(d); }
    }
    if (continuous) {
      const r = ctl.feed({ ms, now, continuous: true, lowered: false, cadence: CADENCE, vsync: VSYNC, wall: wall() });
      if (r) {
        if (r.decision) apply(r.decision);
        if (r.verdict !== 'pending') {
          probes.end(now);
          probes.wantProbe = !!(r.decision && r.decision.to != null);
          if (!probes.wantProbe) settle();
        }
      }
    }
    continuous = true;
  }
  return { level: start.level, levelName, from: start.from, dpr: ctl.ceiling, decisions,
    record: A.loadState(storage, key, maxLevel) };
}

function simulate(storage, dev, shadows, loads, firstIndex) {
  const out = [];
  for (let i = 0; i < loads; i++) out.push(simulateLoad(storage, dev, shadows, (firstIndex || 0) + i));
  return out;
}
const path2str = p => p.map((l, i) => `L${i + 1} ${l.levelName}@${l.dpr}`).join(' -> ');

// The tablet's stored records today, under the OLD key (v1): low, mid-lite
// and above blocked for a week, in both the page (auto) and the popup (low).
function staleTabletStorage() {
  const v1 = s => 'home3d.quality.v1|' + GPU + '|' + FRAG_U + '|' + s;
  return mem({
    [v1('auto')]: JSON.stringify({ v: 1, level: 0, blocked: { level: 1, until: WALL0 + 6 * 24 * HOUR }, dprCap: null,
      settled: { level: 1, dpr: 1, p95: 133.4, at: WALL0 - 24 * HOUR } }),
    [v1('low')]: JSON.stringify({ v: 1, level: 0, blocked: { level: 1, until: WALL0 + 5 * 24 * HOUR }, dprCap: null,
      settled: { level: 0, dpr: 2, p95: 16.8, at: WALL0 - 2 * 24 * HOUR } })
  });
}

const tablet = variant => ({ mobile: true, maxRatio: 2, frameMs: profileMs(TABLET, variant) });

// ---- 1. the wall tablet from its stale v1 record ------------------------------
{ // the HA popup (?embed=1, shadows=low): ultra-lite and ultra build the same thing there
  const s = staleTabletStorage();
  const before = JSON.stringify([...s.m]);
  const p = simulate(s, tablet('pessimistic'), 'low', 8);
  console.log('tablet, popup (shadows=low), pessimistic: ' + path2str(p));
  check('popup: the stale v1 record is not read -- load 1 starts at the default (mid-lite)',
    p[0].levelName === 'mid-lite' && p[0].from === 'default', p[0]);
  check('popup: settles at ultra-lite @ DPR 1 by load 3', p[2].levelName === 'ultra-lite' && p[2].dpr === 1, path2str(p));
  check('popup: stays at ultra-lite @ DPR 1 on every later load', p.slice(2).every(l => l.levelName === 'ultra-lite' && l.dpr === 1), path2str(p));
  check('popup: never builds low', p.every(l => l.level >= 1), path2str(p));
  check('popup: once settled, a load does not even try 1.5 (the cap learnt at DPR 1 holds)',
    p.slice(3).every(l => l.decisions.every(d => d.to == null || d.to <= 1)), p.slice(3).map(l => l.decisions));
  check('popup: the v1 records are left untouched (nothing reads them)',
    before.indexOf('"home3d.quality.v1|') !== -1 && [...s.m].filter(([k]) => k.indexOf('.v1|') !== -1).every(([k, v]) => before.indexOf(JSON.stringify(v)) !== -1));
}
{ // the standalone page (shadows=auto): ultra is distinct (room shadows) and is tried
  const s = staleTabletStorage();
  const p = simulate(s, tablet('pessimistic'), 'auto', 10);
  console.log('tablet, page (shadows=auto), pessimistic: ' + path2str(p));
  const names = p.map(l => l.levelName);
  check('page: load 1 starts at mid-lite (default), not the stale low', names[0] === 'mid-lite' && p[0].from === 'default', names);
  check('page: climbs mid-lite -> mid -> ultra-lite -> ultra, one level per load', names.slice(0, 4).join() === 'mid-lite,mid,ultra-lite,ultra', names);
  const u = p.findIndex(l => l.levelName === 'ultra');
  const strike = p[u].decisions.find(d => d.strike);
  check('page: ultra at ~10 fps at DPR 1 is struck on its first load', strike && strike.from === 1 && strike.strike.level === 4 &&
    p[u].record.level === 4 && p[u].record.strike && p[u].record.strike.level === 4, p[u].decisions);
  const refuse = p[u + 1].decisions.find(d => d.proposeLevel != null);
  check('page: ...and refused on its second: ultra-lite next, ultra blocked for a week',
    p[u + 1].levelName === 'ultra' && refuse && refuse.proposeLevel === 3 && refuse.block.level === 4 &&
    refuse.block.until - (WALL0 + (u + 1) * HOUR) > A.BLOCK_MS - 60000, p[u + 1].decisions);
  check('page: settles at ultra-lite @ DPR 1 by load 6 and stays', p.slice(5).every(l => l.levelName === 'ultra-lite' && l.dpr === 1), path2str(p));
  check('page: ultra is built on exactly two loads, never again while blocked', names.filter(n => n === 'ultra').length === 2, names);
  check('page: never builds low', p.every(l => l.level >= 1), names);
}
{ // optimistic: 1.25 holds wherever 1.0 does
  const s = staleTabletStorage();
  const p = simulate(s, tablet('optimistic'), 'low', 6);
  console.log('tablet, popup, optimistic (1.25 holds): ' + path2str(p));
  check('optimistic popup: settles at ultra-lite, sharper (1.25), and stays', p.slice(2).every(l => l.levelName === 'ultra-lite' && l.dpr === 1.25), path2str(p));
}

// ---- 2. a fresh mobile GPU where only mid-lite holds, and only at DPR 1 ----------
{
  const ONLY_MIDLITE = {
    low: { 1: 16.7, 1.5: 16.7, 2: 16.7 },
    'mid-lite': { 1: 16.7, 1.5: 50, 2: 60 },
    mid: { 1: 50, 1.5: 60, 2: 80 },
    'ultra-lite': { 1: 60, 1.5: 80, 2: 100 },
    ultra: { 1: 100, 1.5: 150, 2: 200 }
  };
  for (const shadows of ['auto', 'low']) {
    const s = mem();
    const p = simulate(s, { mobile: true, maxRatio: 2, frameMs: profileMs(ONLY_MIDLITE, 'pessimistic') }, shadows, 8);
    console.log(`fresh mobile, only mid-lite holds (${shadows}): ` + path2str(p));
    check(`fresh mobile (${shadows}): never below mid-lite`, p.every(l => l.level >= 1), path2str(p));
    check(`fresh mobile (${shadows}): settles on mid-lite @ DPR 1 and stays`, p.slice(3).every(l => l.levelName === 'mid-lite' && l.dpr === 1), path2str(p));
  }
}

// ---- 3. a desktop: exactly the old order -----------------------------------------
{
  // A 1024-uniform desktop at DPR 2 that fails at 2 and at 1.75 and holds
  // at 1.5. The OLD rule, unchanged for a desktop: the level is proposed down
  // on the FIRST step below the start ratio (2 -> 1.75), with no strike.
  const DESK = { low: { 1: 6, 1.5: 6, 2: 6 }, 'mid-lite': { 1: 8, 1.5: 8, 2: 8 }, mid: { 1: 8, 1.5: 10, 2: 12 },
    'ultra-lite': { 1: 10, 1.5: 12, 2: 16 }, ultra: { 1: 12, 1.5: 16, 2: 45 } };
  const s = mem();
  const dev = { mobile: false, maxRatio: 2, frameMs: profileMs(DESK, 'pessimistic') };
  const p = simulate(s, dev, 'auto', 4);
  console.log('desktop, fails at 2 at ultra: ' + path2str(p));
  const first = p[0].decisions.find(d => d.kind === 'down');
  check('desktop: the first step down (2 -> 1.75) proposes ultra-lite and blocks ultra at once, no strike',
    p[0].levelName === 'ultra' && first && first.from === 2 && first.to === 1.75 && first.proposeLevel === 3 &&
    first.block && first.block.level === 4 && !first.strike, p[0].decisions);
  check('desktop: the next load is ultra-lite, back at DPR 2, and stays', p.slice(1).every(l => l.levelName === 'ultra-lite' && l.dpr === 2), path2str(p));
  check('desktop: never a strike anywhere', p.every(l => l.decisions.every(d => !d.strike) && !(l.record && l.record.strike)));
  const fast = simulate(mem(), { mobile: false, maxRatio: 2, frameMs: () => 7 }, 'auto', 3);
  check('desktop, fast: ultra @ 2 on every load, one decision (1 -> 2) per load',
    fast.every(l => l.levelName === 'ultra' && l.dpr === 2 && l.decisions.length === 1 && l.decisions[0].to === 2), fast.map(l => l.decisions));
}

// ---- 4. the cold frame -------------------------------------------------------------
{
  // Evidence (the 5 tablet runs): the first frames after the furniture
  // attaches took 16.6-41.6 ms at every level, ultra included (20.9 ms), in
  // both the HA WebView and Samsung Internet. The worst of them, on every
  // load, changes nothing.
  const s = staleTabletStorage();
  const dev = Object.assign(tablet('pessimistic'), { coldMs: () => 41.6 });
  const p = simulate(s, dev, 'low', 6);
  check('cold: measured cold frames (<= 41.6 ms) never fire: same path as without them',
    path2str(p) === path2str(simulate(staleTabletStorage(), tablet('pessimistic'), 'low', 6)), path2str(p));
  check('cold: ...no decision carries a cold-frame verdict', p.every(l => l.decisions.every(d => d.cold == null)));

  // A one-off 1.5 s compile stall on the first ultra-lite load (a cold
  // shader cache): a strike, not a step down -- the climb is not undone.
  const once = Object.assign(tablet('pessimistic'), {
    coldMs: (lv, i, n) => (lv === 'ultra-lite' && i === 2 && n === 1 ? 1500 : 16.7) });
  const p1 = simulate(staleTabletStorage(), once, 'low', 6);
  console.log('cold, one-off 1.5 s stall on the first ultra-lite load: ' + path2str(p1));
  check('cold one-off: recorded as a strike at ultra-lite, no proposal',
    p1[2].levelName === 'ultra-lite' && p1[2].decisions.some(d => d.cold === 1500 && d.strike && d.strike.level === 3 && d.proposeLevel == null), p1[2].decisions);
  check('cold one-off: the climb stands -- ultra-lite @ DPR 1 from load 3 on', p1.slice(2).every(l => l.levelName === 'ultra-lite' && l.dpr === 1), path2str(p1));
  check('cold one-off: the next clean load clears the strike', p1[3].decisions.some(d => d.strikeCleared) && p1[3].record.strike === null, p1[3].decisions);

  // The same stall on EVERY ultra-lite load is the level's real cost: refused on the second.
  const always = Object.assign(tablet('pessimistic'), { coldMs: (lv, i, n) => (lv === 'ultra-lite' && n === 1 ? 1500 : 16.7) });
  const p2 = simulate(staleTabletStorage(), always, 'low', 6);
  console.log('cold, 1.5 s stall on every ultra-lite load: ' + path2str(p2));
  check('cold every load: refused on the second ultra-lite load, back to mid with ultra-lite blocked',
    p2[2].levelName === 'ultra-lite' && p2[3].levelName === 'ultra-lite' && p2[4].levelName === 'mid' &&
    p2[3].decisions.some(d => d.cold === 1500 && d.proposeLevel === 2 && d.block && d.block.level === 3), path2str(p2));
  check('cold every load: then holds mid, never re-proposing the blocked level', p2.slice(4).every(l => l.levelName === 'mid'), path2str(p2));

  // Room-shadow levels pay their cold shadow pass on every load: still refused at once.
  const ctl = A.createController({ floor: 1, startRatio: 1.5, maxRatio: 2, level: 4,
    ctx: { maxLevel: 4, mobile: true, shadows: 'auto' }, defaultLevel: 1 });
  const d = ctl.coldFrame(30000, WALL0);
  check('cold at ultra with room shadows (mobile): refused on the first load, no strike', d && d.proposeLevel === 3 && d.block.level === 4 && !d.strike, d);
}

// ---- 5. a manual level ---------------------------------------------------------------
{
  // Pinned to High (ultra-lite) in the popup: the ladder does not move, the
  // record is not written, and DPR still falls to the floor so it stays smooth.
  const s = staleTabletStorage();
  simulate(s, tablet('pessimistic'), 'low', 1);                 // one Auto load: record written
  const recBefore = s.getItem(A.storageKey(GPU, FRAG_U, 'low'));
  A.savePin(s, A.pinKey(GPU, FRAG_U, 'low'), 3);
  const p = simulate(s, tablet('pessimistic'), 'low', 3, 1);
  check('manual: builds the pinned level on every load', p.every(l => l.levelName === 'ultra-lite' && l.from === 'manual'), path2str(p));
  check('manual: no level proposal, no strike, no block', p.every(l => l.decisions.every(d => d.proposeLevel == null && !d.strike && !d.block)), p.map(l => l.decisions));
  check('manual: DPR still adapts, down to the floor', p.every(l => l.dpr === 1) && p[0].decisions.some(d => d.kind === 'down' && d.to === 1), p[0].decisions);
  check('manual: the adaptive record is not touched', s.getItem(A.storageKey(GPU, FRAG_U, 'low')) === recBefore);
  check('manual: the page (auto) keeps its own record and is not pinned', simulate(s, tablet('pessimistic'), 'auto', 1, 9)[0].from !== 'manual');
  // Pinned to Max (ultra) on the page, where it runs at ~10 fps: it stays
  // pinned -- the user chose it -- and nothing is learnt from it.
  A.savePin(s, A.pinKey(GPU, FRAG_U, 'auto'), 4);
  const pm = simulate(s, tablet('pessimistic'), 'auto', 2, 20);
  check('manual Max: stays ultra, never proposes down', pm.every(l => l.levelName === 'ultra' && l.decisions.every(d => d.proposeLevel == null)), path2str(pm));
  // Back to Auto: the ladder resumes from the record as it was.
  A.savePin(s, A.pinKey(GPU, FRAG_U, 'low'), null);
  const back = simulate(s, tablet('pessimistic'), 'low', 1, 30)[0];
  check('Auto again: resumes from the stored record (stored, not manual)', back.from === 'stored' && back.levelName === 'mid', back);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
