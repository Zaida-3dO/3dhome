/**
 * matrix.js - WHICH stages the benchmark runs, as a pure function (item
 * 112ec00c). The runner (runner.js) executes whatever plan this returns.
 *
 * NOT A CARTESIAN PRODUCT. Every structural knob (level, shadows) is a full
 * shader recompile and needs its own scene build, so the plan is one rich
 * BASE build at the level this device is ACTUALLY running (the app's stored
 * adaptive level if it has one, else its default), plus thin builds that vary
 * one structural knob each:
 *
 *   base build (current level, the benchmark's shadows mode, furniture on)
 *     baseline     static camera, the current pixel ratio
 *     dpr          static, at each pixel ratio in {1, 1.5, device max}
 *     motion       idle, slow/fast orbit, pan, zoom, swipe burst -- at the
 *                  app's INTERACTION ratio (min(1, current)): the app drops to
 *                  that while a finger is down, so that is what a swipe costs
 *     lights       static, current ratio, +10 / +25 / +50 synthetic PointLights
 *     furniture    static, current ratio, furniture hidden
 *     sustained    slow orbit at the current ratio for 60 s: thermal drift
 *   one build per OTHER rung of the app's LEVELS ladder that the GPU compiles
 *     (low, mid-lite, mid, ultra-lite, ultra), static, at every ratio -- each
 *     with furniture at the detail THAT rung builds (low detail at `low`,
 *     minor items dropped at `mid-lite`), because the build is the app's own
 *   the other shadow modes of the current level, static, current ratio
 *   STRIP-LIGHT COST (binding addition #2): a build at the level the grid
 *     recommends -- chosen at RUN time, after the grid -- with synthetic strip
 *     lights: A +13 PointLights (today's reference), B +13x3 / +13x6 dim
 *     PointLights, C +13 / +25 RectAreaLights; plus a +0 reference.
 *
 * "Distinct" uses adaptive-quality's own levelConfig(), so a rung that builds
 * the same scene as another (ultra-lite vs ultra under shadows=low) is not
 * run twice.
 *
 * Quick mode (~1-1.5 min) keeps the base baseline, two ratios, slow orbit,
 * swipe burst, +10/+25 lights, furniture off, a 10 s sustained run, EVERY
 * rung at the current ratio, and the strip group's +0 / A / B x3 / C 13.
 *
 * Pure ESM: scripts/test-diagnostics-verdict.mjs drives it.
 */

import { levelConfig, LEVELS } from '../adaptive-quality.js';

export const TIMING = Object.freeze({
  full: Object.freeze({ warmupMs: 1500, measureMs: 4000, sustainedMs: 60000 }),
  quick: Object.freeze({ warmupMs: 1000, measureMs: 2500, sustainedMs: 10000 })
});

export const LIGHT_STEPS = Object.freeze([10, 25, 50]);
export const QUICK_LIGHT_STEPS = Object.freeze([10]);

/** The strip-light cost options (binding addition #2). 13 strips = the house's planned count. */
export const STRIP_COUNT = 13;
export const STRIP_OPTIONS = Object.freeze([
  Object.freeze({ id: 'strip-0', option: 'ref', kind: null, strips: 0, perStrip: 0, label: 'no strips (reference)' }),
  Object.freeze({ id: 'strip-A13', option: 'A', kind: 'point', strips: 13, perStrip: 1, label: 'A: 13 PointLights (today)' }),
  Object.freeze({ id: 'strip-B13x3', option: 'B', kind: 'point', strips: 13, perStrip: 3, label: 'B: 13 strips x 3 dim PointLights' }),
  Object.freeze({ id: 'strip-B13x6', option: 'B', kind: 'point', strips: 13, perStrip: 6, label: 'B: 13 strips x 6 dim PointLights' }),
  Object.freeze({ id: 'strip-C13', option: 'C', kind: 'rect', strips: 13, perStrip: 1, label: 'C: 13 RectAreaLights' }),
  Object.freeze({ id: 'strip-C25', option: 'C', kind: 'rect', strips: 25, perStrip: 1, label: 'C: 25 RectAreaLights' })
]);
const QUICK_STRIPS = ['strip-0', 'strip-A13', 'strip-B13x3', 'strip-C13'];

const round2 = x => Math.round(x * 100) / 100;
const SHADOW_MODES = ['auto', 'low', 'off'];

/** The pixel ratios to test: 1, 1.5 and the device max, deduped, never above the max. */
export function dprSteps(deviceDpr) {
  const max = deviceDpr > 0 ? round2(deviceDpr) : 1;
  const out = [1];
  if (max >= 1.5) out.push(1.5);
  if (out.indexOf(max) === -1 && max > 1) out.push(max);
  return out.sort((a, b) => a - b);
}

/**
 * The app's start pixel ratio on this device, as index.html and
 * home3d-scene.js compute it: min(devicePixelRatio, 2), and on a mobile GPU
 * the adaptive controller's start ratio of 1.5.
 */
export function appDefaultDpr(deviceDpr, mobile) {
  const base = Math.min(deviceDpr > 0 ? deviceDpr : 1, 2);
  return round2(mobile ? Math.min(base, 1.5) : base);
}

function key(c) {
  return [c.tier, c.sunShadow, c.roomShadowLights, c.shadowMapScale, c.dropMinorFurniture].join('|');
}

/** A level's build config plus the furniture detail it builds (furniture.js: 'low' only at tier low). */
export function describeLevel(level, ctx) {
  const c = levelConfig(level, ctx);
  return Object.assign({}, c, { furnitureDetail: c.tier === 'low' ? 'low' : 'full' });
}

/**
 * Build the plan.
 *
 * @param {Object} o
 * @param {'full'|'quick'} o.mode
 * @param {number} o.maxLevel       highest level the GPU compiles (adaptive maxLevelFor)
 * @param {number} o.currentLevel   the level the app runs here now (stored, else default)
 * @param {number} [o.currentDpr]   the ratio the app runs at now (default: its start ratio)
 * @param {boolean} o.mobile        mobile GPU (the app's mobileCaps)
 * @param {number} o.deviceDpr      window.devicePixelRatio
 * @param {string} [o.shadows]      the shadows= mode to benchmark ('auto': the standalone
 *                                  page; 'low': the Home Assistant embed)
 */
export function buildPlan(o) {
  const mode = o.mode === 'quick' ? 'quick' : 'full';
  const T = TIMING[mode];
  const shadows = SHADOW_MODES.indexOf(o.shadows) !== -1 ? o.shadows : 'auto';
  const maxLevel = Math.max(0, Math.min(LEVELS.length - 1, o.maxLevel | 0));
  const lv = o.currentLevel != null ? o.currentLevel : o.defaultLevel;
  const curLevel = Math.max(0, Math.min(maxLevel, lv | 0));
  const mobile = o.mobile === true;
  const currentDpr = o.currentDpr > 0 ? round2(o.currentDpr) : appDefaultDpr(o.deviceDpr, mobile);
  const dprs = dprSteps(o.deviceDpr);
  if (dprs.indexOf(currentDpr) === -1) { dprs.push(currentDpr); dprs.sort((a, b) => a - b); }
  const interactionDpr = Math.min(1, currentDpr);
  const ctx = sh => ({ maxLevel, mobile, shadows: sh });
  const cfg = (level, sh) => describeLevel(level, ctx(sh));
  const baseCfg = cfg(curLevel, shadows);
  const stage = (s) => Object.assign({ camera: 'idle', lights: 0, furniture: true,
    warmupMs: T.warmupMs, measureMs: T.measureMs }, s);

  const builds = [];
  const base = { id: 'base', level: curLevel, levelName: LEVELS[curLevel].name, shadows, config: baseCfg, stages: [] };
  builds.push(base);
  const bs = base.stages;
  bs.push(stage({ id: 'baseline', group: 'baseline', dpr: currentDpr }));
  const dprList = mode === 'quick' ? dprs.filter(d => d === 1 || d === dprs[dprs.length - 1]) : dprs;
  dprList.forEach(d => { if (d !== currentDpr) bs.push(stage({ id: 'dpr-' + d, group: 'dpr', dpr: d })); });
  const motions = mode === 'quick'
    ? ['orbit-slow', 'swipe-burst']
    : ['idle', 'orbit-slow', 'orbit-fast', 'pan', 'zoom', 'swipe-burst'];
  motions.forEach(m => bs.push(stage({ id: 'motion-' + m, group: 'motion', camera: m, dpr: interactionDpr })));
  (mode === 'quick' ? QUICK_LIGHT_STEPS : LIGHT_STEPS).forEach(n =>
    bs.push(stage({ id: 'lights+' + n, group: 'lights', lights: n, dpr: currentDpr })));
  bs.push(stage({ id: 'furniture-none', group: 'furniture', furniture: false, dpr: currentDpr }));
  bs.push(stage({ id: 'sustained', group: 'sustained', camera: 'orbit-slow', dpr: currentDpr, measureMs: T.sustainedMs }));

  // Every other rung of the ladder that compiles here.
  const seen = new Set([key(baseCfg)]);
  for (let l = 0; l <= maxLevel; l++) {
    if (l === curLevel) continue;
    const c = cfg(l, shadows);
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    const ratios = mode === 'quick' ? [currentDpr] : dprs;
    builds.push({ id: 'level-' + LEVELS[l].name, level: l, levelName: LEVELS[l].name, shadows, config: c,
      stages: ratios.map(d => stage({ id: 'level-' + LEVELS[l].name + '@' + d, group: 'grid', dpr: d })) });
  }

  // The other shadow modes of the current level (full only).
  if (mode === 'full') {
    SHADOW_MODES.filter(sh => sh !== shadows).forEach(sh => {
      const c = cfg(curLevel, sh);
      if (key(c) === key(baseCfg)) return;
      builds.push({ id: 'shadows-' + sh, level: curLevel, levelName: LEVELS[curLevel].name, shadows: sh, config: c,
        stages: [stage({ id: 'shadows-' + sh, group: 'shadows', dpr: currentDpr })] });
    });
  }

  // The strip-light cost group: level and ratio chosen by the runner at run
  // time (the grid's recommendation, else the current setting).
  const strips = STRIP_OPTIONS.filter(s => mode === 'full' || QUICK_STRIPS.indexOf(s.id) !== -1);
  builds.push({ id: 'strip', level: null, levelName: null, shadows, config: null, dynamic: 'recommended',
    stages: strips.map(s => stage({ id: s.id, group: 'strip', dpr: null,
      strip: { option: s.option, kind: s.kind, strips: s.strips, perStrip: s.perStrip, label: s.label } })) });

  // The base build's static stages at each ratio are grid points too.
  bs.forEach(s => { if (s.group === 'baseline' || s.group === 'dpr') s.grid = true; });
  builds.forEach(b => b.stages.forEach(s => { if (s.group === 'grid') s.grid = true; }));

  let stageCount = 0, estimatedMs = 0;
  builds.forEach(b => {
    estimatedMs += 4000; // a build: compile + furniture attach, rough
    // +800 ms per stage for the change frames and the idle-tick check; a stage
    // that changes the light count also pays a full synchronous recompile
    // (12-21 s measured on a desktop GPU), so it is budgeted 15 s more.
    b.stages.forEach(s => { stageCount++; estimatedMs += s.warmupMs + s.measureMs + 800 +
      ((s.lights > 0 || (s.strip && s.strip.strips > 0)) ? 15000 : 0); });
  });
  return { mode, timing: T, shadows, currentLevel: curLevel, currentDpr, defaultLevel: curLevel, defaultDpr: currentDpr,
    interactionDpr, dprs, maxLevel, builds, stageCount, estimatedMs };
}

/** A compact, self-describing description of a plan for the result document. */
export function describePlan(plan) {
  return {
    mode: plan.mode,
    timing: plan.timing,
    shadows: plan.shadows,
    maxLevel: plan.maxLevel,
    currentLevel: plan.currentLevel,
    currentLevelName: LEVELS[plan.currentLevel].name,
    currentDpr: plan.currentDpr,
    interactionDpr: plan.interactionDpr,
    dprs: plan.dprs,
    levels: LEVELS.map((L, i) => ({ level: i, name: L.name, tier: L.tier })),
    builds: plan.builds.map(b => ({
      id: b.id, level: b.level, levelName: b.levelName, shadows: b.shadows, config: b.config,
      dynamic: b.dynamic || null, stages: b.stages.map(s => s.id)
    })),
    stripOptions: STRIP_OPTIONS,
    stageCount: plan.stageCount,
    notes: [
      'Not a cartesian product: one base build at the level this device runs now, one build per other compiling rung, the other shadow modes, and a strip-light cost build.',
      'Each level build is the app\'s own: furniture at the detail that rung builds (low detail at level low, minor items dropped at mid-lite).',
      'Each stage: settings applied, change frames recorded (compile hitch), warm-up discarded, measured, then an idle-tick check for browser throttling.',
      'Motion stages run at the interaction ratio because the app drops to it while a finger is down.',
      'Rendering is continuous (every rAF tick) and uncapped during stages; the app itself renders on demand at <= 60 fps.',
      'The strip build runs at the level/ratio the grid recommends (else the current one), chosen after the grid.'
    ]
  };
}
