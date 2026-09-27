/**
 * verdict.js - the on-device first answer (item 112ec00c). Pure.
 *
 * The result is written for an agent to re-analyse; this is the first pass,
 * in plain terms, so the person holding the tablet learns something too.
 *
 * TWO LINES, both reported:
 *
 *   APP LINE (decides the RECOMMENDED level): p95 at most the app's own
 *     adaptive-quality STEP-DOWN threshold for this display
 *     (adaptive-quality.js thresholds(): ~41.7 ms at 60 Hz with the app's
 *     60 fps cap), and at most 2% of frames over 50 ms. A level recommended
 *     on this line is one the app's own ladder will not immediately step back
 *     down from once applied. (The 2% hitch guard is stricter than the app,
 *     which looks at p95 alone: never looser.)
 *   SMOOTH LINE (reported alongside): p95 at most 33.4 ms -- a steady 30 fps
 *     with vsync slack -- and at most 2% over 50 ms. What a wall display
 *     that should feel smooth would want; `bestSmooth` / `smoothAtDpr`.
 *
 * Both need the 2% guard because a steady 25 ms with a 10% rate of 80 ms
 * hitches has a fine p95 and still feels broken.
 *
 * HEADROOM is measured against the smooth 33.4 ms budget, from the best cost
 * signal available:
 *   gpu    the GPU timer query's p95 (EXT_disjoint_timer_query_webgl2),
 *          maxed with the CPU submit p95 -- the frame's real work;
 *   frame  the frame interval p95 when there is no timer query. On a
 *          vsync-locked display this cannot read below the refresh interval,
 *          so it UNDER-states headroom; the verdict says which basis it used.
 *
 * Settings rank by structural level first, then pixel ratio: a level up buys
 * lighting and furniture detail, a ratio step buys sharpness, and the app's
 * own ladder treats the level as the bigger decision.
 *
 * "CURRENT" is the level this device actually runs today -- the app's stored
 * adaptive level where it has one, else its default -- at the ratio it runs
 * at. That is what the owner sees, so that is what the verdict compares with.
 */

import { linearFit } from './stats.js';
import { estimateVsync, capCadence, thresholds } from '../adaptive-quality.js';

/** The smooth-30-fps line. */
export const TARGET = Object.freeze({ p95Ms: 33.4, maxPctOver50: 2 });
export const SMOOTH_TARGET = TARGET;

/** The frame-rate cap the app runs the 3D view at (index.html maxFps). */
export const APP_MAX_FPS = 60;

/**
 * The app's own adaptive step-down threshold on a display whose idle rAF tick
 * is `refreshMs`, computed with adaptive-quality.js's own functions exactly as
 * the scene does (vsync snapped to a standard rate, the 60 fps cap's cadence,
 * thresholds()). {vsyncMs, cadenceMs, upMs, downMs}.
 */
export function appStepDown(refreshMs, maxFps = APP_MAX_FPS) {
  const tick = refreshMs > 0 ? refreshMs : 1000 / 60;
  const vsync = estimateVsync([tick, tick, tick], 0);
  const minFrameMs = maxFps > 0 ? (1000 / maxFps) - 1 : 0;
  const cadence = capCadence(minFrameMs, vsync);
  const t = thresholds(cadence, vsync);
  return { vsyncMs: r2(vsync), cadenceMs: r2(cadence), upMs: r2(t.up), downMs: r2(t.down) };
}

/** The app line as a target: {p95Ms, maxPctOver50, line: 'app'}. */
export function appTarget(plan) {
  const down = plan && plan.appStepDownMs > 0 ? plan.appStepDownMs : appStepDown(1000 / 60).downMs;
  return { p95Ms: down, maxPctOver50: 2, line: 'app' };
}

const r1 = x => Math.round(x * 10) / 10;
const r2 = x => Math.round(x * 100) / 100;

/** Does a measured stage hold the target? */
export function holds(stage, target = TARGET) {
  if (!stage || !stage.valid || !stage.frames) return false;
  return stage.frames.p95Ms <= target.p95Ms && stage.frames.pctOver50 <= target.maxPctOver50;
}

/** The cost basis of a stage: {ms, basis}. */
export function costOf(stage) {
  if (!stage || !stage.frames) return { ms: null, basis: null };
  const g = stage.gpu && stage.gpu.p95Ms;
  const c = stage.cpu && stage.cpu.p95Ms;
  if (Number.isFinite(g)) return { ms: Math.max(g, Number.isFinite(c) ? c : 0), basis: 'gpu' };
  return { ms: stage.frames.p95Ms, basis: 'frame' };
}

/** Headroom in % of the target budget (negative: over budget). */
export function headroomPct(costMs, budgetMs = TARGET.p95Ms) {
  if (!Number.isFinite(costMs)) return null;
  return Math.round(100 * (1 - costMs / budgetMs));
}

const signed = x => (x >= 0 ? '+' : '') + x;

function label(s) { return s.levelName + ' @' + s.dpr; }

/** The strip-light cost block: each option against the strip group's +0 reference. */
export function stripVerdict(stages, target = TARGET) {
  const group = stages.filter(s => s.group === 'strip');
  if (!group.length) return null;
  const ref = group.find(s => s.strip && s.strip.strips === 0) || null;
  const refCost = costOf(ref);
  const at = ref ? { level: ref.level, levelName: ref.levelName, dpr: ref.dpr } :
    (group[0] ? { level: group[0].level, levelName: group[0].levelName, dpr: group[0].dpr } : null);
  const options = group.filter(s => s.strip && s.strip.strips > 0).map(s => {
    const c = costOf(s);
    const tenable = !!(s.valid && !s.compileFailed && holds(s, target));
    return {
      stage: s.id, option: s.strip.option, label: s.strip.label, kind: s.strip.kind, strips: s.strip.strips,
      perStrip: s.strip.perStrip, lightsAdded: s.lightsAdded, valid: !!s.valid, invalidReason: s.invalidReason || null,
      compiled: !s.compileFailed, p95Ms: s.frames ? s.frames.p95Ms : null,
      deltaP95Ms: s.frames && ref && ref.frames ? r2(s.frames.p95Ms - ref.frames.p95Ms) : null,
      deltaCostMs: Number.isFinite(c.ms) && Number.isFinite(refCost.ms) ? r2(c.ms - refCost.ms) : null,
      costBasis: c.basis,
      uniformVectorsEstimate: s.uniforms ? s.uniforms.lightVectorsEstimate : null,
      uniformVectorsMeasured: s.uniforms ? s.uniforms.measuredMaxVectors : null,
      maxFragmentUniformVectors: s.uniforms ? s.uniforms.maxFragmentUniformVectors : null,
      holds: holds(s, target), tenable
    };
  });
  const lines = options.map(o => 'strip lights ' + o.label + ': ' +
    (o.compiled ? '' : 'SHADER DID NOT COMPILE; ') +
    (o.deltaP95Ms != null ? signed(o.deltaP95Ms) + ' ms p95' : 'p95 n/a') +
    (o.deltaCostMs != null ? ' (' + signed(o.deltaCostMs) + ' ms ' + o.costBasis + ')' : '') +
    (at ? ' at ' + at.levelName + ' @' + at.dpr : '') + ' -- ' +
    (!o.valid ? 'not measured (' + o.invalidReason + ')' : o.tenable ? 'tenable' : 'NOT tenable'));
  const tenableBy = opt => { const xs = options.filter(o => o.option === opt && o.valid); return xs.length ? xs.every(o => o.tenable) : null; };
  return { at, reference: ref ? { stage: ref.id, p95Ms: ref.frames ? ref.frames.p95Ms : null, valid: !!ref.valid } : null,
    options, tenable: { A: tenableBy('A'), B: tenableBy('B'), C: tenableBy('C') }, lines };
}

/**
 * @param {Object[]} stages   measured stages (see result.js for the shape)
 * @param {Object} plan       { currentLevel, currentDpr, shadows, currentLevelFrom? }
 * @returns {Object} the verdict block
 */
export function computeVerdict(stages, plan, targetOverride) {
  const target = targetOverride || appTarget(plan);
  const curLevel = plan.currentLevel != null ? plan.currentLevel : plan.defaultLevel;
  const curDpr = plan.currentDpr != null ? plan.currentDpr : plan.defaultDpr;
  const shadows = plan.shadows || 'auto';
  const grid = stages.filter(s => s.grid && s.shadows === shadows && s.lightsAdded === 0 && s.furniture);
  const valid = grid.filter(s => s.valid);
  const rank = s => s.level * 100 + s.dpr;
  const byRank = valid.slice().sort((a, b) => rank(b) - rank(a));
  const best = byRank.find(s => holds(s, target)) || null;
  const bestSmooth = byRank.find(s => holds(s, SMOOTH_TARGET)) || null;
  const current = grid.find(s => s.level === curLevel && s.dpr === curDpr) || null;
  const cur = costOf(current);
  const from = plan.currentLevelFrom ? ' (' + plan.currentLevelFrom + ')' : '';
  const out = {
    target,
    smoothTarget: SMOOTH_TARGET,
    appStepDown: plan.appStepDown || null,
    basis: cur.basis,
    current: current ? {
      stage: current.id, level: current.level, levelName: current.levelName, levelFrom: plan.currentLevelFrom || null,
      dpr: current.dpr, holds: holds(current, target), holdsSmooth: holds(current, SMOOTH_TARGET),
      p95Ms: current.frames ? current.frames.p95Ms : null,
      costMs: cur.ms != null ? r1(cur.ms) : null, headroomPct: headroomPct(cur.ms, SMOOTH_TARGET.p95Ms),
      furnitureDetail: current.config ? current.config.furnitureDetail : null
    } : null,
    best: best ? { stage: best.id, level: best.level, levelName: best.levelName, dpr: best.dpr,
      p95Ms: best.frames.p95Ms, headroomPct: headroomPct(costOf(best).ms, SMOOTH_TARGET.p95Ms),
      furnitureDetail: best.config ? best.config.furnitureDetail : null } : null,
    bestSmooth: bestSmooth ? { stage: bestSmooth.id, level: bestSmooth.level, levelName: bestSmooth.levelName,
      dpr: bestSmooth.dpr, p95Ms: bestSmooth.frames.p95Ms } : null,
    recommendedLevel: best ? best.level : null,
    recommendedLevelName: best ? best.levelName : null,
    recommendation: null,
    levels: null,
    furniture: null,
    perLightMs: null,
    stripLights: null,
    thermal: null,
    notes: []
  };

  // Recommendation.
  if (!current) {
    out.recommendation = 'unknown';
    out.notes.push('The current setting was not measured (aborted or invalid); no recommendation.');
  } else if (!current.valid) {
    out.recommendation = 'unknown';
    out.notes.push('The current setting\'s stage was invalid (' + (current.invalidReason || 'unknown') + ').');
  } else if (!holds(current, target)) {
    out.recommendation = best ? 'reduce' : 'reduce-below-lowest';
    out.summary = 'current: ' + label(current) + from + ' -- p95 ' + current.frames.p95Ms + ' ms, misses the target; ' +
      (best ? 'reduce to ' + label(best) + ' (p95 ' + best.frames.p95Ms + ' ms)' : 'nothing measured holds the target');
  } else if (best && rank(best) > rank(current)) {
    out.recommendation = 'raise';
    out.summary = 'current: ' + label(current) + from + ' -- p95 ' + current.frames.p95Ms + ' ms, headroom ~' +
      out.current.headroomPct + '% (' + cur.basis + ' basis); highest sustainable: ' + label(best) +
      ' (p95 ' + best.frames.p95Ms + ' ms) -- could raise';
  } else {
    out.recommendation = 'keep';
    out.summary = 'current: ' + label(current) + from + ' -- p95 ' + current.frames.p95Ms + ' ms, headroom ~' +
      out.current.headroomPct + '% (' + cur.basis + ' basis); it is the highest sustainable setting measured, keep it';
  }

  // Every rung: the highest ratio it holds at.
  const levelIds = Array.from(new Set(grid.map(s => s.level))).sort((a, b) => a - b);
  out.levels = levelIds.map(l => {
    const ss = grid.filter(s => s.level === l).sort((a, b) => a.dpr - b.dpr);
    const ok = ss.filter(s => holds(s, target));
    const okSmooth = ss.filter(s => holds(s, SMOOTH_TARGET));
    const c = ss[0] && ss[0].config ? ss[0].config : null;
    return { level: l, levelName: ss[0].levelName, tier: c ? c.tier : null,
      furnitureDetail: c ? c.furnitureDetail : null, dropMinorFurniture: c ? c.dropMinorFurniture : null,
      roomShadowLights: c ? c.roomShadowLights : null,
      holdsAtDpr: ok.length ? ok[ok.length - 1].dpr : null,
      smoothAtDpr: okSmooth.length ? okSmooth[okSmooth.length - 1].dpr : null,
      measured: ss.map(s => ({ dpr: s.dpr, valid: !!s.valid, holds: holds(s, target), holdsSmooth: holds(s, SMOOTH_TARGET),
        p95Ms: s.frames ? s.frames.p95Ms : null })) };
  });
  out.levelLines = out.levels.map(L => 'level ' + L.levelName + ' (furniture ' + (L.furnitureDetail || '?') +
    (L.dropMinorFurniture ? ', minor items dropped' : '') + '): ' +
    (L.holdsAtDpr != null ? 'holds up to DPR ' + L.holdsAtDpr : L.measured.some(m => m.valid) ? 'misses the target at every ratio' : 'not measured') +
    (L.holdsAtDpr != null ? (L.smoothAtDpr != null ? ', smooth 30 fps up to DPR ' + L.smoothAtDpr : ', not smooth 30 fps at any ratio') : ''));

  // Furniture detail: full detail is built at every tier but low; every item
  // (minor ones included) at every level but mid-lite (and low on a mobile GPU).
  const holding = valid.filter(s => holds(s, target) && s.config);
  out.furniture = {
    currentDetail: current && current.config ? current.config.furnitureDetail : null,
    currentDropsMinorItems: current && current.config ? !!current.config.dropMinorFurniture : null,
    fullDetailAffordable: holding.length ? holding.some(s => s.config.furnitureDetail === 'full') : false,
    allItemsFullDetailAffordable: holding.length ? holding.some(s => s.config.furnitureDetail === 'full' && !s.config.dropMinorFurniture) : false
  };
  out.furniture.line = 'furniture: runs at ' + (out.furniture.currentDetail || '?') + ' detail' +
    (out.furniture.currentDropsMinorItems ? ' without minor items' : '') + '; full detail ' +
    (out.furniture.fullDetailAffordable ? 'IS affordable' : 'is NOT affordable (or not measured)') +
    (out.furniture.allItemsFullDetailAffordable ? ', with every item' : '');

  // Per-light cost: the base build's baseline plus its lights stages.
  const lightStages = stages.filter(s => s.valid && s.build === 'base' &&
    (s.group === 'lights' || s.group === 'baseline'));
  if (lightStages.length >= 2) {
    const xs = lightStages.map(s => s.lightsAdded);
    const fit = (ys) => { const f = linearFit(xs, ys); return f ? f.slope : null; };
    const gpuFit = fit(lightStages.map(s => s.gpu ? s.gpu.meanMs : NaN));
    const frameFit = fit(lightStages.map(s => s.frames.meanMs));
    out.perLightMs = {
      gpu: gpuFit != null ? Math.round(gpuFit * 1000) / 1000 : null,
      frame: frameFit != null ? Math.round(frameFit * 1000) / 1000 : null,
      points: lightStages.map(s => ({ lights: s.lightsAdded, frameMeanMs: s.frames.meanMs,
        gpuMeanMs: s.gpu ? s.gpu.meanMs : null, holds: holds(s, target), compileFailed: !!s.compileFailed })),
      note: 'Least-squares slope of mean ms against synthetic PointLights added (shadowless). ' +
        'Frame-time slope is ~0 while vsync hides the cost; prefer the gpu slope where present.'
    };
    const firstFail = lightStages.filter(s => s.group === 'lights').sort((a, b) => a.lightsAdded - b.lightsAdded)
      .find(s => !holds(s, target));
    out.perLightMs.firstFailingLights = firstFail ? firstFail.lightsAdded : null;
  }

  out.stripLights = stripVerdict(stages, target);

  const sus = stages.find(s => s.group === 'sustained' && s.valid && s.drift);
  if (sus) {
    out.thermal = { stage: sus.id, driftPct: sus.drift.driftPct,
      gpuDriftPct: sus.gpuDrift ? sus.gpuDrift.driftPct : null,
      throttlingSuspected: (sus.drift.driftPct != null && sus.drift.driftPct > 15) ||
        (sus.gpuDrift && sus.gpuDrift.driftPct != null && sus.gpuDrift.driftPct > 15) };
  }
  if (cur.basis === 'frame') {
    out.notes.push('No GPU timer query on this device: headroom is from frame intervals, which vsync floors at ' +
      'the refresh interval, so real headroom is likely larger than stated.');
  }
  return out;
}
