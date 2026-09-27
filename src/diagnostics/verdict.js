/**
 * verdict.js - the on-device first answer (item 112ec00c). Pure.
 *
 * The result is written for an agent to re-analyse; this is the first pass,
 * in plain terms, so the person holding the tablet learns something too.
 *
 * TARGET: a setting HOLDS when its stage is valid, its frame-time p95 is at
 * most 33.4 ms (30 fps with vsync slack) and at most 2% of its frames exceed
 * 50 ms. Both, because a steady 25 ms with a 10% rate of 80 ms hitches has a
 * fine p95 and still feels broken.
 *
 * HEADROOM is measured against that 33.4 ms budget, from the best cost
 * signal available:
 *   gpu    the GPU timer query's p95 (EXT_disjoint_timer_query_webgl2),
 *          maxed with the CPU submit p95 -- the frame's real work;
 *   frame  the frame interval p95 when there is no timer query. On a
 *          vsync-locked display this cannot read below the refresh interval,
 *          so it UNDER-states headroom; the verdict says which basis it used.
 *
 * Settings rank by structural level first, then pixel ratio: a level up buys
 * lighting, a ratio step buys sharpness, and the app's own ladder treats the
 * level as the bigger decision.
 */

import { linearFit } from './stats.js';

export const TARGET = Object.freeze({ p95Ms: 33.4, maxPctOver50: 2 });

const r1 = x => Math.round(x * 10) / 10;

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

function label(s) { return s.levelName + ' @' + s.dpr; }

/**
 * @param {Object[]} stages   measured stages (see result.js for the shape)
 * @param {Object} plan       { defaultLevel, defaultDpr }
 * @returns {Object} the verdict block
 */
export function computeVerdict(stages, plan, target = TARGET) {
  const grid = stages.filter(s => s.grid && s.shadows === 'auto' && s.lightsAdded === 0 && s.furniture);
  const valid = grid.filter(s => s.valid);
  const rank = s => s.level * 100 + s.dpr;
  const byRank = valid.slice().sort((a, b) => rank(b) - rank(a));
  const best = byRank.find(s => holds(s, target)) || null;
  const current = grid.find(s => s.level === plan.defaultLevel && s.dpr === plan.defaultDpr) || null;
  const cur = costOf(current);
  const out = {
    target,
    basis: cur.basis,
    current: current ? {
      stage: current.id, level: current.level, levelName: current.levelName, dpr: current.dpr,
      holds: holds(current, target), p95Ms: current.frames ? current.frames.p95Ms : null,
      costMs: cur.ms != null ? r1(cur.ms) : null, headroomPct: headroomPct(cur.ms, target.p95Ms)
    } : null,
    best: best ? { stage: best.id, level: best.level, levelName: best.levelName, dpr: best.dpr,
      p95Ms: best.frames.p95Ms, headroomPct: headroomPct(costOf(best).ms, target.p95Ms) } : null,
    recommendation: null,
    perLightMs: null,
    thermal: null,
    notes: []
  };

  // Recommendation.
  if (!current) {
    out.recommendation = 'unknown';
    out.notes.push('The default setting was not measured (aborted or invalid); no recommendation.');
  } else if (!current.valid) {
    out.recommendation = 'unknown';
    out.notes.push('The default setting\'s stage was invalid (' + (current.invalidReason || 'unknown') + ').');
  } else if (!holds(current, target)) {
    out.recommendation = best ? 'reduce' : 'reduce-below-lowest';
    out.summary = 'current default: ' + label(current) + ' -- p95 ' + current.frames.p95Ms + ' ms, misses the target; ' +
      (best ? 'reduce to ' + label(best) + ' (p95 ' + best.frames.p95Ms + ' ms)' : 'nothing measured holds the target');
  } else if (best && rank(best) > rank(current)) {
    out.recommendation = 'raise';
    out.summary = 'current default: ' + label(current) + ' -- p95 ' + current.frames.p95Ms + ' ms, headroom ~' +
      out.current.headroomPct + '% (' + cur.basis + ' basis); could raise to ' + label(best) +
      ' (p95 ' + best.frames.p95Ms + ' ms)';
  } else {
    out.recommendation = 'keep';
    out.summary = 'current default: ' + label(current) + ' -- p95 ' + current.frames.p95Ms + ' ms, headroom ~' +
      out.current.headroomPct + '% (' + cur.basis + ' basis); nothing higher measured holds the target, keep it';
  }

  // Per-light cost: the base build's baseline plus its lights stages.
  const lightStages = stages.filter(s => s.valid && s.build === 'base' &&
    (s.group === 'lights' || s.group === 'baseline'));
  if (lightStages.length >= 2) {
    const xs = lightStages.map(s => s.lightsAdded);
    const fit = (ys) => { const f = linearFit(xs, ys); return f ? f.slope : null; };
    const gpuFit = fit(lightStages.map(s => s.gpu ? s.gpu.meanMs : NaN));
    const frameFit = fit(lightStages.map(s => s.frames.meanMs));
    out.perLightMs = {
      gpu: gpuFit ? Math.round(gpuFit * 1000) / 1000 : null,
      frame: frameFit ? Math.round(frameFit * 1000) / 1000 : null,
      points: lightStages.map(s => ({ lights: s.lightsAdded, frameMeanMs: s.frames.meanMs,
        gpuMeanMs: s.gpu ? s.gpu.meanMs : null, holds: holds(s, target), compileFailed: !!s.compileFailed })),
      note: 'Least-squares slope of mean ms against synthetic PointLights added (shadowless). ' +
        'Frame-time slope is ~0 while vsync hides the cost; prefer the gpu slope where present.'
    };
    const firstFail = lightStages.filter(s => s.group === 'lights').sort((a, b) => a.lightsAdded - b.lightsAdded)
      .find(s => !holds(s, target));
    out.perLightMs.firstFailingLights = firstFail ? firstFail.lightsAdded : null;
  }

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

