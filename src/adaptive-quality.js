/**
 * adaptive-quality.js - quality driven by MEASURED frame times (task 230713da).
 *
 * quality-tier.js answers "what can this GPU compile, and is it a mobile
 * part?" from strings. That was a guess about throughput: PR #54 capped every
 * mobile GPU at mid, DPR 1.5, no room shadows and no minor furniture, whether
 * or not it could do better. This module measures instead.
 *
 * TWO SPEEDS, because of what a change costs here (see the tombstones in
 * home3d-scene.js): every structural knob -- tier, shadow-casting lights,
 * minor furniture -- is a full material recompile, so changing one mid-session
 * is a multi-second hitch. Pixel ratio is the only knob that changes live.
 *
 *   - LIVE: the pixel-ratio ceiling steps up or down in DPR_STEP notches.
 *   - NEXT LOAD: the structural LEVEL is decided in-session, persisted per
 *     device, and built directly by the next create(). Nothing structural
 *     changes under a running scene.
 *
 * Pure ESM: no DOM, no THREE, no clock of its own (every call takes `now`) and
 * storage is injected, so scripts/test-adaptive-quality.mjs drives it with
 * simulated frame-time series. home3d-scene.js gathers the samples and applies
 * the decisions.
 */

/** p95 below this (ms) is headroom -- or the capped cadence, if that is slower. */
export const UP_MS = 20;
/**
 * p95 above this (ms) is too slow. 34 rather than the spec's "about 33": a
 * vsync-locked steady 30 fps reads 33.3 ms and should HOLD, not oscillate on
 * refresh quantisation. Anything worse than 30 fps steps down.
 */
export const DOWN_MS = 34;
/** Samples per window; p95 is taken once per full window, never per frame. */
export const WINDOW = 60;
/**
 * ...or a window closes early once it spans this long with WINDOW_MIN
 * samples, so a device at 20 fps still reaches a verdict inside one probe.
 */
export const WINDOW_SPAN_MS = 1500;
export const WINDOW_MIN = 10;
/** Consecutive windows on the same side before anything moves ("sustained"). */
export const STREAK = 2;
/** The live pixel-ratio notch. */
export const DPR_STEP = 0.25;
/** Where a mobile GPU's pixel ratio starts (PR #54's cap, now a start). */
export const MOBILE_START_RATIO = 1.5;
/** A level stepped down from, and a DPR notch that failed, stay out of reach this long. */
export const BLOCK_MS = 7 * 24 * 60 * 60 * 1000;
/** Quiet time after any step before samples count again (buffer realloc, first frames). */
export const SETTLE_MS = 300;
/** A gap longer than this is a stall or a background tab, not a frame. */
export const MAX_SAMPLE_MS = 1000;
/** Below this frame-rate cap there is no adaptation (the ramp runs as before). */
export const MIN_FPS_CAP = 50;
/**
 * A single rendered frame blocking this long (the first room-shadow pass, a
 * cold compile) is a verdict on its own for a level ABOVE the device's
 * default: the rolling p95 never sees it, because warm-up excludes it.
 */
export const COLD_FRAME_MS = 1000;
const EPS = 0.001;

/**
 * The structural ladder, cheapest first. Each level is one compile; the scene
 * builds exactly one of them per load.
 */
export const LEVELS = Object.freeze([
  Object.freeze({ name: 'low', tier: 'low' }),
  Object.freeze({ name: 'mid-lite', tier: 'mid' }),     // PR #54's mobile cap
  Object.freeze({ name: 'mid', tier: 'mid' }),
  Object.freeze({ name: 'ultra-lite', tier: 'ultra' }),
  Object.freeze({ name: 'ultra', tier: 'ultra' })
]);

/** The highest level the uniform budget compiles. */
export function maxLevelFor(compileTier) {
  if (compileTier === 'ultra') return 4;
  if (compileTier === 'mid') return 2;
  return 0;
}

/** The level for a tier named by ?tier= (the top level of that tier). */
export function levelForTier(tier) {
  return tier === 'ultra' ? 4 : tier === 'mid' ? 2 : 0;
}

/**
 * Where a device starts with nothing stored: a desktop at the top of what it
 * compiles (today's behaviour exactly), a mobile GPU at mid-lite (PR #54).
 */
export function defaultLevel(mobile, maxLevel) {
  return mobile === true ? Math.min(1, maxLevel) : maxLevel;
}

/**
 * What a level builds. Reproduces the pre-adaptive formulas exactly at a
 * desktop's default level (maxLevel) and at a mobile GPU's (mid-lite), with
 * one documented exception (a mid-compiling mobile under ?shadows=high; see
 * the test):
 *
 *   shadows 'off'  -> no sun shadow, no room shadows
 *   shadows 'low'  -> sun shadow unless low tier, no room shadows, 1/4 maps
 *   shadows 'high' -> room shadows unless low tier, but only at the top level
 *                     (the old `!capped`: the ladder holding back IS a cap)
 *   otherwise      -> room shadows at level 4 only (the old `tier === 'ultra'`)
 *
 * @param {number} level
 * @param {{maxLevel: number, mobile: boolean, shadows: string}} ctx
 */
export function levelConfig(level, ctx) {
  const L = LEVELS[level];
  const tier = L.tier;
  let sunShadow = tier !== 'low';
  let roomShadowLights = level === 4;
  let shadowMapScale = 1;
  if (ctx.shadows === 'off') {
    sunShadow = false;
    roomShadowLights = false;
  } else if (ctx.shadows === 'low') {
    roomShadowLights = false;
    shadowMapScale = 0.25;
  } else if (ctx.shadows === 'high') {
    roomShadowLights = tier !== 'low' && level === ctx.maxLevel;
  }
  // mid-lite drops minor furniture. At low, furniture.js already skips it on
  // its own; the scene-level flag stays what it was (mobile only).
  const dropMinorFurniture = level === 1 || (level === 0 && ctx.mobile === true);
  return { level, name: L.name, tier, sunShadow, roomShadowLights, shadowMapScale, dropMinorFurniture };
}

function configKey(c) {
  return [c.tier, c.sunShadow, c.roomShadowLights, c.shadowMapScale, c.dropMinorFurniture].join('|');
}

/**
 * The next level in `dir` (+1 / -1) whose BUILT config differs from `level`'s,
 * or null. Under shadows=low (the embed default) ultra-lite and ultra build the
 * same thing, so a step must never propose the no-op one.
 */
export function nextDistinctLevel(level, dir, ctx) {
  const here = configKey(levelConfig(level, ctx));
  for (let l = level + dir; l >= 0 && l <= ctx.maxLevel; l += dir) {
    if (configKey(levelConfig(l, ctx)) !== here) return l;
  }
  return null;
}

/** 95th percentile of an array of numbers (nearest-rank). */
export function p95(values) {
  if (!values.length) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

const round2 = x => Math.round(x * 100) / 100;

/**
 * Standard refresh periods (ms) a vsync estimate snaps to. Nothing slower than
 * 60 Hz: a tick gap longer than 16.7 ms is a busy GPU, not a display, and
 * reading it as a slow display would loosen every threshold.
 */
const REFRESH_MS = [240, 165, 144, 120, 100, 90, 75, 60].map(hz => 1000 / hz);

/**
 * The display's refresh period from rAF tick-to-tick deltas: the third
 * smallest delta (the ticks of an IDLE scene arrive at the true refresh, and a
 * busy GPU only ever stretches them), snapped to the nearest standard rate.
 *
 * STICKY: pass the previous estimate as `prev` and the result never rises
 * above it. A long saturated run (thermal throttling, a long drag, probes
 * back to back) can push every idle tick out of the history; without this
 * the estimate would climb with the slowness, the cadence with it, and a slow
 * device would read its own slow frames as headroom (plan review r2, N1).
 * 0 with nothing to go on.
 */
export function estimateVsync(tickDeltas, prev) {
  // The THIRD smallest, not the smallest: one freak short gap (a 4 ms tick on
  // a 144 Hz display) would otherwise lock in 240 Hz for the session, since
  // the estimate never rises (plan review r3).
  const ds = [];
  for (let i = 0; i < tickDeltas.length; i++) if (tickDeltas[i] >= 3) ds.push(tickDeltas[i]);
  ds.sort((a, b) => a - b);
  const min = ds.length >= 3 ? ds[2] : Infinity;
  let est = 0;
  if (Number.isFinite(min)) {
    est = REFRESH_MS[0];
    for (const r of REFRESH_MS) if (Math.abs(r - min) < Math.abs(est - min)) est = r;
  }
  if (prev > 0) return est > 0 ? Math.min(prev, est) : prev;
  return est;
}

/** Idle rAF ticks slower than this (median) mean the BROWSER is throttling. */
export const THROTTLED_IDLE_MS = 25;

/**
 * Is the browser throttling animation frames on its own? Judged from IDLE
 * ticks only -- ticks with no frame drawn on either of the two before -- so
 * our own GPU work cannot be what slowed them. A background-ish window, a
 * power-saving mode or an embedding page can hold rAF at 10-30 fps; measured
 * as frame time that reads as a slow GPU and would step a capable device
 * DOWN and block its levels for a week. While throttled, nothing is
 * measured. Needs 5 idle ticks; with fewer it says not throttled.
 *
 * @returns {{throttled: boolean, fps: number}}  fps: the idle tick rate
 */
export function rafThrottle(idleDeltas) {
  if (idleDeltas.length < 5) return { throttled: false, fps: 0 };
  const s = idleDeltas.slice().sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  return { throttled: med > THROTTLED_IDLE_MS, fps: med > 0 ? Math.round(1000 / med) : 0 };
}

/**
 * The interval a frame arrives at when it misses nothing: the frame-rate
 * cap's minimum interval rounded UP to a whole number of refreshes (the loop
 * can only draw on a tick). A 60 fps cap is 16.7 ms at 60/120 Hz, 20 ms at
 * 100 Hz, 20.8 ms at 144 Hz and 26.7 ms at 75 Hz. 0 when vsync is unknown.
 */
export function capCadence(minFrameMs, vsyncMs) {
  if (!(vsyncMs > 0)) return 0;
  return Math.max(1, Math.ceil((minFrameMs || 0) / vsyncMs - 1e-6)) * vsyncMs;
}

/**
 * The thresholds for this display and cap. Headroom = frames arrive on the
 * capped cadence (one missed refresh fails it) and never stricter than
 * UP_MS; too slow = beyond DOWN_MS and at least one refresh past the headroom
 * line, so the dead band never collapses. With no cadence: UP_MS / DOWN_MS.
 */
export function thresholds(cadenceMs, vsyncMs) {
  const c = cadenceMs > 0 ? cadenceMs : 0;
  const v = vsyncMs > 0 ? vsyncMs : 0;
  const up = Math.max(UP_MS, c + v / 2);
  const down = Math.max(DOWN_MS, up + v);
  return { up, down };
}

/**
 * The controller. Fed accepted frame intervals; decides live pixel-ratio steps
 * and a next-load level proposal.
 *
 * @param {Object} o
 * @param {number} o.floor       lowest ratio (the cheap first paint, <= 1)
 * @param {number} o.startRatio  what the first up-decision jumps to
 * @param {number} o.maxRatio    hard ceiling (the pixelRatio opt)
 * @param {number} o.level       the level this load was built at
 * @param {Object} o.ctx         {maxLevel, mobile, shadows} for levelConfig
 * @param {?{level:number, until:number}} [o.blocked]
 *        levels >= blocked.level are not proposed before `until`
 * @param {?number} [o.dprCap]  a ratio this level failed above on an earlier
 *        load: this session never climbs past it
 * @param {number} [o.defaultLevel] the device's default level (coldFrame only
 *        steps down from ABOVE it, so a desktop's own build is never touched)
 */
export function createController(o) {
  const floor = o.floor;
  const startRatio = Math.max(floor, Math.min(o.startRatio, o.maxRatio));
  const st = {
    ceiling: floor,
    sessionMax: o.dprCap > 0 ? Math.max(floor, Math.min(o.maxRatio, o.dprCap)) : o.maxRatio,
    level: o.level,
    pending: null,            // the level proposed for the next load, or null
    pendingAt: 0,             // the ceiling an up-proposal was earned at
    blocked: o.blocked || null,
    upStreak: 0,
    downStreak: 0,
    quietUntil: 0,
    lastP95: NaN,
    lastSamples: 0,
    lastThresholds: null
  };
  const win = [];
  let winStart = 0;

  function isBlocked(level, now) {
    return !!(st.blocked && now < st.blocked.until && level >= st.blocked.level);
  }

  function reset(now, quietMs) {
    win.length = 0;
    winStart = 0;
    st.upStreak = 0;
    st.downStreak = 0;
    st.quietUntil = Math.max(st.quietUntil, now + (quietMs == null ? SETTLE_MS : quietMs));
  }

  function canGoUp(now) {
    if (st.ceiling < st.sessionMax - EPS) return true;
    if (st.pending != null) return false;
    const n = nextDistinctLevel(st.level, +1, o.ctx);
    return n != null && !isBlocked(n, now);
  }

  function stepUp(now) {
    const d = { kind: 'up', from: st.ceiling, to: null, proposeLevel: null, revoke: false, block: null, cap: null };
    const start = Math.min(startRatio, st.sessionMax);
    if (st.ceiling < start - EPS) {
      d.to = start;
    } else {
      // Structure first, then pixels above the start ratio.
      if (st.pending == null) {
        const n = nextDistinctLevel(st.level, +1, o.ctx);
        if (n != null && !isBlocked(n, now)) { st.pending = n; st.pendingAt = st.ceiling; d.proposeLevel = n; }
      }
      if (st.ceiling < st.sessionMax - EPS) d.to = round2(Math.min(st.ceiling + DPR_STEP, st.sessionMax));
    }
    if (d.to == null && d.proposeLevel == null) return null;
    if (d.to != null) st.ceiling = d.to;
    return d;
  }

  // Propose the next distinct level down and block everything above it -- a
  // CEILING, not one level: under shadows=low ultra-lite and ultra build the
  // same thing, so blocking only the level stepped down from would let the
  // next load re-propose its twin.
  function proposeDown(d, now) {
    if (st.pending != null && st.pending < st.level) return;
    const n = nextDistinctLevel(st.level, -1, o.ctx);
    if (n == null) return;
    st.pending = n;
    d.proposeLevel = n;
    st.blocked = { level: n + 1, until: now + BLOCK_MS };
    d.block = st.blocked;
  }

  function stepDown(now) {
    const d = { kind: 'down', from: st.ceiling, to: null, proposeLevel: null, revoke: false, block: null, cap: null };
    if (st.ceiling > floor + EPS) {
      d.to = round2(Math.max(floor, st.ceiling - DPR_STEP));
      st.ceiling = d.to;
      // Never re-climb a notch that failed: not this session, and (d.cap,
      // persisted by the scene) not on this level's next loads either.
      st.sessionMax = d.to;
      d.cap = d.to;
    }
    // A level-up earned at a ratio we are still at or above stands: failing a
    // try at 1.75 says nothing about the 1.5 the proposal was earned at.
    if (st.pending != null && st.pending > st.level && st.ceiling < st.pendingAt - EPS) {
      st.pending = null;
      d.revoke = true;
    }
    if (st.ceiling < startRatio - EPS || d.to == null) proposeDown(d, now);
    if (d.to == null && d.proposeLevel == null && !d.revoke) return null;
    return d;
  }

  /**
   * One rendered frame's blocking time, for the first frames of a load (the
   * cold shadow pass). Above COLD_FRAME_MS on a level above the device's
   * default: propose the level below and block this one. `wall` is
   * wall-clock ms (the block outlives the page). Returns the decision, or null.
   */
  function coldFrame(ms, wall) {
    if (!(ms > COLD_FRAME_MS)) return null;
    if (o.defaultLevel == null || st.level <= o.defaultLevel) return null;
    if (st.pending != null && st.pending < st.level) return null;
    const d = { kind: 'down', from: st.ceiling, to: null, proposeLevel: null, revoke: false, block: null, cap: null, cold: ms };
    if (st.pending != null) { st.pending = null; d.revoke = true; }
    proposeDown(d, wall);
    return d.proposeLevel != null ? d : null;
  }

  /**
   * Offer one frame interval. Returns null until a window completes, then
   * { verdict, p95, samples, decision, thresholds }:
   *   verdict 'pending' - one window of a streak; keep measuring
   *           'hold'    - dead band, or a streak with nothing left to do
   *           'up'|'down' - decision carries the step
   *
   * @param {Object} s
   * @param {number} s.ms          interval since the previous rendered frame
   * @param {number} s.now
   * @param {boolean} s.continuous the previous tick rendered (or only the fps cap skipped it)
   * @param {boolean} [s.lowered]  the applied ratio is below the ceiling (drag cap)
   * @param {number} [s.cadence]   capCadence() for this display (0: unknown)
   * @param {number} [s.vsync]     estimateVsync() for this display (0: unknown)
   * @param {number} [s.wall]      wall-clock ms (Date.now()) for blocks, which
   *        outlive the page; defaults to s.now
   */
  function feed(s) {
    if (!s.continuous || s.lowered) return null;
    if (!(s.ms > 0) || s.ms > MAX_SAMPLE_MS) return null;
    if (s.now < st.quietUntil) return null;
    if (!win.length) winStart = s.now - s.ms;
    win.push(s.ms);
    if (win.length < WINDOW && !(win.length >= WINDOW_MIN && s.now - winStart >= WINDOW_SPAN_MS)) return null;
    const v = p95(win);
    const n = win.length;
    win.length = 0;
    winStart = 0;
    const t = thresholds(s.cadence, s.vsync);
    st.lastP95 = v;
    st.lastSamples = n;
    st.lastThresholds = t;
    if (v < t.up) { st.upStreak++; st.downStreak = 0; }
    else if (v > t.down) { st.downStreak++; st.upStreak = 0; }
    else { st.upStreak = 0; st.downStreak = 0; return { verdict: 'hold', p95: v, samples: n, decision: null, thresholds: t }; }
    const wall = s.wall != null ? s.wall : s.now;
    if (st.upStreak >= STREAK) {
      const d = stepUp(wall);
      st.upStreak = 0;
      if (!d) return { verdict: 'hold', p95: v, samples: n, decision: null, thresholds: t };
      if (d.to != null) reset(s.now);
      return { verdict: 'up', p95: v, samples: n, decision: d, thresholds: t };
    }
    if (st.downStreak >= STREAK) {
      const d = stepDown(wall);
      st.downStreak = 0;
      if (!d) return { verdict: 'hold', p95: v, samples: n, decision: null, thresholds: t };
      if (d.to != null) reset(s.now);
      return { verdict: 'down', p95: v, samples: n, decision: d, thresholds: t };
    }
    return { verdict: 'pending', p95: v, samples: n, decision: null, thresholds: t };
  }

  /**
   * Go straight to the start ratio without a measurement -- what the scene
   * did before adaptive quality. For when frame times cannot be trusted (the
   * browser throttles rAF): a high-DPI desktop must not sit at the cheap
   * first-paint ratio forever. Never above a stored cap. Returns the
   * decision, or null when already there.
   */
  function jumpToStart() {
    const start = Math.min(startRatio, st.sessionMax);
    if (st.ceiling >= start - EPS) return null;
    const d = { kind: 'up', from: st.ceiling, to: start, proposeLevel: null, revoke: false, block: null, cap: null, unmeasured: true };
    st.ceiling = start;
    return d;
  }

  return {
    feed,
    coldFrame,
    jumpToStart,
    /**
     * Forget the pending next-load proposal and any block (Settings
     * "Re-measure"). The live pixel ratio is left where it is.
     */
    forget() { st.pending = null; st.pendingAt = 0; st.blocked = null; },
    /** Drop the window and go quiet (resume from hidden, furniture attach). */
    quiet(now, ms) { reset(now, ms); },
    /** Is there anything a probe could still gain? (`wall`: wall-clock ms) */
    canGoUp(wall) { return canGoUp(wall); },
    get ceiling() { return st.ceiling; },
    get sessionMax() { return st.sessionMax; },
    get pending() { return st.pending; },
    get blocked() { return st.blocked; },
    get lastP95() { return st.lastP95; },
    get lastSamples() { return st.lastSamples; },
    get lastThresholds() { return st.lastThresholds; },
    get startRatio() { return startRatio; },
    get floor() { return floor; }
  };
}

// ---- persistence ------------------------------------------------------------

/**
 * One key per GPU, uniform budget and shadows= mode: the embed (shadows=low)
 * and the standalone page (auto) cost different amounts at the same level,
 * so each learns its own. A masked or missing name is 'unknown'.
 */
export function storageKey(gpuName, maxFragU, shadows) {
  const name = String(gpuName || '').trim() || 'unknown';
  return 'home3d.quality.v1|' + name + '|' + (maxFragU | 0) + '|' + (shadows || 'auto');
}

/**
 * Read the stored state. Never throws: storage may be absent, disabled
 * (Safari private mode), or hold garbage. Returns null when there is nothing
 * usable; a stored level is clamped to [0, maxLevel].
 */
export function loadState(storage, key, maxLevel) {
  let raw = null;
  try { raw = storage ? storage.getItem(key) : null; } catch (e) { return null; }
  if (typeof raw !== 'string') return null;
  let v;
  try { v = JSON.parse(raw); } catch (e) { return null; }
  if (!v || typeof v !== 'object' || v.v !== 1) return null;
  const out = { level: null, blocked: null, dprCap: null, settled: null };
  if (Number.isInteger(v.level)) out.level = Math.max(0, Math.min(maxLevel, v.level));
  const b = v.blocked;
  if (b && Number.isInteger(b.level) && Number.isFinite(b.until)) out.blocked = { level: b.level, until: b.until };
  const c = v.dprCap;
  if (c && Number.isInteger(c.level) && c.ratio > 0 && Number.isFinite(c.until)) {
    out.dprCap = { level: c.level, ratio: c.ratio, until: c.until };
  }
  if (v.settled && typeof v.settled === 'object') out.settled = v.settled;
  return out;
}

/** Write the state. Returns false (never throws) when storage refuses. */
export function saveState(storage, key, state) {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify({
      v: 1,
      level: state.level,
      blocked: state.blocked || null,
      dprCap: state.dprCap || null,
      settled: state.settled || null
    }));
    return true;
  } catch (e) { return false; }
}

/** Forget this device's measurements. Never throws. */
export function clearState(storage, key) {
  try { if (storage) storage.removeItem(key); return true; } catch (e) { return false; }
}
