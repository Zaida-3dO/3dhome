/**
 * matrix.js - WHICH stages the benchmark runs, as a pure function (item
 * 112ec00c). The runner (runner.js) executes whatever plan this returns.
 *
 * NOT A CARTESIAN PRODUCT. Every structural knob (tier/level, shadows) is a
 * full shader recompile and needs its own scene build, so the plan is one
 * rich BASE build at the app's own default for this device, plus a few thin
 * builds that vary exactly one structural knob each:
 *
 *   base build (the app's default level, shadows=auto, furniture on)
 *     baseline     static camera, default pixel ratio
 *     dpr          static, at each pixel ratio in {1, 1.5, device max}
 *     motion       idle, slow/fast orbit, pan, zoom, swipe burst -- at the
 *                  app's INTERACTION ratio (min(1, default)): the app drops to
 *                  that while a finger is down, so that is what a swipe costs
 *     lights       static, default ratio, +10 / +25 / +50 synthetic PointLights
 *     furniture    static, default ratio, furniture hidden
 *     sustained    slow orbit at the default ratio for 60 s: thermal drift
 *   one build per OTHER distinct level of the ladder (low, mid-lite, mid,
 *   ultra-lite, ultra -- up to what the GPU compiles), static, at each ratio
 *   shadows=off and shadows=low builds of the default level, static, default
 *   ratio (skipped when they build the same thing as the base)
 *
 * "Distinct" uses adaptive-quality's own levelConfig(), so a rung that builds
 * the same scene as another (ultra-lite vs ultra under shadows=low) is not
 * run twice.
 *
 * Quick mode (~1 min) keeps the base build's baseline, two ratios, slow orbit,
 * swipe burst, +10/+25 lights, furniture off and a 10 s sustained run, plus
 * the top level if it differs from the default. No other builds.
 *
 * Pure ESM: scripts/test-diagnostics-matrix.mjs drives it.
 */

import { levelConfig, LEVELS } from '../adaptive-quality.js';

export const TIMING = Object.freeze({
  full: Object.freeze({ warmupMs: 1500, measureMs: 4000, sustainedMs: 60000 }),
  quick: Object.freeze({ warmupMs: 1000, measureMs: 2500, sustainedMs: 10000 })
});

export const LIGHT_STEPS = Object.freeze([10, 25, 50]);
export const QUICK_LIGHT_STEPS = Object.freeze([10, 25]);

const round2 = x => Math.round(x * 100) / 100;

/** The pixel ratios to test: 1, 1.5 and the device max, deduped, never above the max. */
export function dprSteps(deviceDpr) {
  const max = deviceDpr > 0 ? round2(deviceDpr) : 1;
  const out = [1];
  if (max >= 1.5) out.push(1.5);
  if (out.indexOf(max) === -1 && max > 1) out.push(max);
  return out.sort((a, b) => a - b);
}

/**
 * The app's default pixel ratio on this device, as index.html and
 * home3d-scene.js compute it: min(devicePixelRatio, 2), and on a mobile GPU
 * the adaptive controller's start ratio of 1.5 (it may climb later, on
 * measured headroom; this benchmark is what tells us whether it should).
 */
export function appDefaultDpr(deviceDpr, mobile) {
  const base = Math.min(deviceDpr > 0 ? deviceDpr : 1, 2);
  return round2(mobile ? Math.min(base, 1.5) : base);
}

function key(c) {
  return [c.tier, c.sunShadow, c.roomShadowLights, c.shadowMapScale, c.dropMinorFurniture].join('|');
}

/**
 * Build the plan.
 *
 * @param {Object} o
 * @param {'full'|'quick'} o.mode
 * @param {number} o.maxLevel      highest level the GPU compiles (adaptive maxLevelFor)
 * @param {number} o.defaultLevel  the app's start level on this device
 * @param {boolean} o.mobile       mobile GPU (the app's mobileCaps)
 * @param {number} o.deviceDpr     window.devicePixelRatio
 * @returns {{mode, timing, defaultLevel, defaultDpr, interactionDpr, dprs, builds: Object[], stageCount, estimatedMs}}
 */
export function buildPlan(o) {
  const mode = o.mode === 'quick' ? 'quick' : 'full';
  const T = TIMING[mode];
  const maxLevel = Math.max(0, Math.min(LEVELS.length - 1, o.maxLevel | 0));
  const defLevel = Math.max(0, Math.min(maxLevel, o.defaultLevel | 0));
  const mobile = o.mobile === true;
  const dprs = dprSteps(o.deviceDpr);
  const defaultDpr = appDefaultDpr(o.deviceDpr, mobile);
  const interactionDpr = Math.min(1, defaultDpr);
  const ctx = shadows => ({ maxLevel, mobile, shadows });
  const cfg = (level, shadows) => levelConfig(level, ctx(shadows));
  const baseCfg = cfg(defLevel, 'auto');
  const stage = (s) => Object.assign({ camera: 'idle', lights: 0, furniture: true,
    warmupMs: T.warmupMs, measureMs: T.measureMs }, s);

  const builds = [];
  const base = { id: 'base', level: defLevel, levelName: LEVELS[defLevel].name, shadows: 'auto',
    config: baseCfg, stages: [] };
  builds.push(base);
  const bs = base.stages;
  bs.push(stage({ id: 'baseline', group: 'baseline', dpr: defaultDpr }));
  const dprList = mode === 'quick'
    ? dprs.filter(d => d === 1 || d === dprs[dprs.length - 1])
    : dprs;
  dprList.forEach(d => { if (d !== defaultDpr) bs.push(stage({ id: 'dpr-' + d, group: 'dpr', dpr: d })); });
  const motions = mode === 'quick'
    ? ['orbit-slow', 'swipe-burst']
    : ['idle', 'orbit-slow', 'orbit-fast', 'pan', 'zoom', 'swipe-burst'];
  motions.forEach(m => bs.push(stage({ id: 'motion-' + m, group: 'motion', camera: m, dpr: interactionDpr })));
  (mode === 'quick' ? QUICK_LIGHT_STEPS : LIGHT_STEPS).forEach(n =>
    bs.push(stage({ id: 'lights+' + n, group: 'lights', lights: n, dpr: defaultDpr })));
  bs.push(stage({ id: 'furniture-none', group: 'furniture', furniture: false, dpr: defaultDpr }));
  bs.push(stage({ id: 'sustained', group: 'sustained', camera: 'orbit-slow', dpr: defaultDpr,
    measureMs: T.sustainedMs }));

  // Other levels.
  const seen = new Set([key(baseCfg)]);
  const levels = [];
  if (mode === 'quick') {
    if (maxLevel !== defLevel) levels.push(maxLevel);
  } else {
    for (let l = 0; l <= maxLevel; l++) if (l !== defLevel) levels.push(l);
  }
  levels.forEach(l => {
    const c = cfg(l, 'auto');
    if (seen.has(key(c))) return;
    seen.add(key(c));
    const ratios = mode === 'quick' ? [defaultDpr] : dprs;
    builds.push({ id: 'level-' + LEVELS[l].name, level: l, levelName: LEVELS[l].name, shadows: 'auto', config: c,
      stages: ratios.map(d => stage({ id: 'level-' + LEVELS[l].name + '@' + d, group: 'grid', dpr: d })) });
  });

  // Shadow variants of the default level (full only).
  if (mode === 'full') {
    ['off', 'low'].forEach(sh => {
      const c = cfg(defLevel, sh);
      if (key(c) === key(baseCfg)) return;
      builds.push({ id: 'shadows-' + sh, level: defLevel, levelName: LEVELS[defLevel].name, shadows: sh, config: c,
        stages: [stage({ id: 'shadows-' + sh, group: 'shadows', dpr: defaultDpr })] });
    });
  }

  // The base build's static stages at each ratio are grid points too.
  bs.forEach(s => { if (s.group === 'baseline' || s.group === 'dpr') s.grid = true; });
  builds.forEach(b => b.stages.forEach(s => { if (s.group === 'grid') s.grid = true; }));

  let stageCount = 0, estimatedMs = 0;
  builds.forEach(b => {
    estimatedMs += 4000; // a build: compile + furniture attach, rough
    b.stages.forEach(s => { stageCount++; estimatedMs += s.warmupMs + s.measureMs + 300; });
  });
  return { mode, timing: T, defaultLevel: defLevel, defaultDpr, interactionDpr, dprs, maxLevel, builds,
    stageCount, estimatedMs };
}

/** A compact, self-describing description of a plan for the result document. */
export function describePlan(plan) {
  return {
    mode: plan.mode,
    timing: plan.timing,
    maxLevel: plan.maxLevel,
    defaultLevel: plan.defaultLevel,
    defaultLevelName: LEVELS[plan.defaultLevel].name,
    defaultDpr: plan.defaultDpr,
    interactionDpr: plan.interactionDpr,
    dprs: plan.dprs,
    levels: LEVELS.map((L, i) => ({ level: i, name: L.name, tier: L.tier })),
    builds: plan.builds.map(b => ({
      id: b.id, level: b.level, levelName: b.levelName, shadows: b.shadows, config: b.config,
      stages: b.stages.map(s => s.id)
    })),
    stageCount: plan.stageCount,
    notes: [
      'Not a cartesian product: one base build at the app default, plus builds varying one structural knob each.',
      'Each stage: settings applied, one change frame recorded (compile hitch), warm-up discarded, then measured.',
      'Motion stages run at the interaction ratio because the app drops to it while a finger is down.',
      'Rendering is continuous (every rAF tick) and uncapped during stages; the app itself renders on demand at <= 60 fps.'
    ]
  };
}
