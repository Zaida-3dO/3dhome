/**
 * runner.js - executes a benchmark plan against the real scene (item 112ec00c).
 *
 * USES THE APP'S OWN SCENE. Every build is Home3DScene.create() on the
 * configured house, driven only through the scene's documented
 * `instance.diagnostics` surface (see home3d-scene.js) plus its public
 * setOrbit / setFurnitureVisible / setSunTime. Nothing reaches into the
 * scene's closure.
 *
 * PER BUILD: create with the level and shadows pinned (adaptive quality off,
 * nothing persisted), time create -> onReady (the shader precompile) and ->
 * furniture attached, then the first continuous frame.
 *
 * PER STAGE: apply the stage's settings, wait out the CHANGE FRAMES (a light
 * count change recompiles every lit material; that hitch is recorded as
 * changeFrameMs, never mixed into the stage's numbers), run the warm-up with
 * the camera already moving and discard it, then measure for measureMs.
 *
 * VALIDITY: a stage during which the page was hidden, or whose frames the
 * browser visibly throttled, is marked invalid with the reason and its
 * numbers are kept only for context. The verdict never uses an invalid stage.
 */

import { buildPlan, describePlan } from './matrix.js';
import { motionPose, MOTIONS } from './camera-motion.js';
import { summarizeIntervals, summarizeSamples, histogram, downsampleMax, drift, HIST_EDGES, percentile } from './stats.js';
import { createFrameRecorder, createGpuTimer, createCpuTimer, attachToScene, createLongTaskObserver, heapMB, rendererInfo } from './telemetry.js';
import { collectDevice } from './device-info.js';
import { computeVerdict, appStepDown } from './verdict.js';
import { describeLevel } from './matrix.js';
import { estimateLightVectors, measuredMaxUniformVectors } from './lights-budget.js';
import { LEVELS } from '../adaptive-quality.js';

/** The app's adaptive-quality records (read-only here; see snapshotAdaptive). */
const ADAPTIVE_PREFIX = 'home3d.quality.v1|';
import { assembleResult, fitToSize } from './result.js';
import { rafThrottle } from '../adaptive-quality.js';

const SERIES_POINTS = 240;
const READY_TIMEOUT_MS = 90000;
const FURNITURE_TIMEOUT_MS = 60000;
/**
 * A light-count change recompiles every lit material SYNCHRONOUSLY (no
 * precompile path for it): measured 12-21 s on a desktop GPU for +10..+39
 * PointLights on the demo house. A tablet may take far longer; give it room,
 * and record the time as changeFrameMs.
 */
const CHANGE_TIMEOUT_MS = 180000;
/** An interval this long mid-stage means the browser stopped delivering frames. */
const GAP_INVALID_MS = 1000;

export class AbortedError extends Error {
  constructor(reason) { super(reason || 'aborted'); this.name = 'AbortedError'; }
}

const nextFrame = () => new Promise(r => requestAnimationFrame(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Idle rAF calibration: the display's refresh rate, from the median tick. */
export async function measureRefresh(ms = 1000) {
  const d = [];
  let last = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const ts = await nextFrame();
    if (last) d.push(ts - last);
    last = ts;
  }
  const med = percentile(d, 50);
  return { medianTickMs: Math.round(med * 100) / 100, hz: med > 0 ? Math.round(1000 / med) : null, ticks: d.length };
}

/**
 * Run the whole benchmark.
 *
 * @param {Object} o
 * @param {HTMLElement} o.container       where the scene canvas goes
 * @param {Object} o.Home3DScene          the scene module export
 * @param {Object} o.house                compiled house profile
 * @param {string} o.houseId
 * @param {string} o.version              app version
 * @param {'full'|'quick'} o.mode
 * @param {function(Object):void} [o.onProgress]
 * @param {{aborted:boolean, reason?:string}} [o.signal]  set .aborted to stop
 * @returns {Promise<Object>} the result document (partial if aborted)
 */
export async function runDiagnostics(o) {
  // The app's own adaptive-quality records are guarded for the WHOLE run:
  // snapshotted before anything happens, and compared (and restored if
  // anything moved) on every way out -- a finished run, an abort (caught
  // inside, reported in run.adaptiveState) and a thrown error (this finally).
  let storage = null;
  try { storage = window.localStorage; } catch (e) { storage = null; }
  const guard = guardAdaptive(storage);
  try {
    return await runGuarded(o, guard);
  } finally {
    guard.finish();
  }
}

async function runGuarded(o, guard) {
  const signal = o.signal || { aborted: false };
  const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const startedAt = new Date();
  const t0 = performance.now();
  const hiddenEvents = [];
  let hiddenNow = document.hidden;
  let hiddenSince = hiddenNow ? performance.now() : 0;
  const onVis = () => {
    hiddenNow = document.hidden;
    if (hiddenNow) hiddenSince = performance.now();
    hiddenEvents.push({ atMs: Math.round(performance.now() - t0), hidden: hiddenNow });
  };
  document.addEventListener('visibilitychange', onVis);

  const check = () => { if (signal.aborted) throw new AbortedError(signal.reason || 'aborted by the user'); };

  progress({ phase: 'device', label: 'Reading device capabilities' });
  const shadowsMode = ['auto', 'low', 'off'].indexOf(o.shadows) !== -1 ? o.shadows : 'auto';
  const device = await collectDevice(window, { shadows: shadowsMode });
  const refresh = await measureRefresh(1000);
  device.refreshRateHz = refresh.hz;
  device.refreshCalibration = refresh;
  if (refresh.hz) delete device.nullReasons.refreshRateHz;
  else device.nullReasons.refreshRateHz = 'no idle rAF ticks to measure';
  check();

  if (!device.app) {
    document.removeEventListener('visibilitychange', onVis);
    throw new Error('WebGL is not available on this device, so there is nothing to benchmark.');
  }
  const plan = buildPlan({ mode: o.mode, maxLevel: device.app.maxLevel, currentLevel: device.app.currentLevel,
    currentDpr: device.app.currentDpr, mobile: device.app.mobileCaps === true, deviceDpr: window.devicePixelRatio || 1,
    shadows: shadowsMode });
  plan.currentLevelFrom = device.app.currentLevelFrom;
  // The app's own step-down threshold on THIS display decides the recommended
  // level (verdict.js); the smooth 30 fps line is reported beside it.
  plan.appStepDown = appStepDown(refresh.medianTickMs);
  plan.appStepDownMs = plan.appStepDown.downMs;
  const matrix = describePlan(plan);
  matrix.motions = MOTIONS;
  matrix.histogramEdgesMs = HIST_EDGES;
  matrix.appStepDown = plan.appStepDown;
  matrix.sun = 'pinned to 12:00 local time on the run date, so every device lights the same scene';
  matrix.maxFragmentUniformVectors = device.webgl && device.webgl.limits ? device.webgl.limits.MAX_FRAGMENT_UNIFORM_VECTORS : null;
  const ctxInfo = { maxFragU: matrix.maxFragmentUniformVectors };

  const builds = [];
  const stages = [];
  const total = plan.stageCount;
  let done = 0;
  let spentMs = 0;
  let aborted = false, abortReason = null, fatal = null;

  const eta = () => {
    const remaining = plan.builds.reduce((s, b) => s + b.stages.filter(st => !st._done)
      .reduce((a, st) => a + st.warmupMs + st.measureMs + 800 + ((st.lights > 0 || (st.strip && st.strip.strips > 0)) ? 15000 : 0), 0) +
      (b._done ? 0 : 4000), 0);
    return remaining;
  };

  try {
    for (const b of plan.builds) {
      check();
      if (b.dynamic === 'recommended') {
        // The strip-light group runs at the level/ratio the grid recommends,
        // else the current one: decided now, from what has been measured.
        const v = computeVerdict(stages, plan);
        const lvl = v.best ? v.best.level : plan.currentLevel;
        const dpr = v.best ? v.best.dpr : plan.currentDpr;
        b.level = lvl; b.levelName = LEVELS[lvl].name;
        b.config = describeLevel(lvl, { maxLevel: plan.maxLevel, mobile: device.app.mobileCaps === true, shadows: b.shadows });
        b.chosenFrom = v.best ? 'grid recommendation' : 'current setting (nothing measured held the target)';
        b.stages.forEach(st => { st.dpr = dpr; });
        const mb = matrix.builds.find(x => x.id === b.id);
        if (mb) { mb.level = lvl; mb.levelName = b.levelName; mb.config = b.config; mb.chosenFrom = b.chosenFrom; mb.dpr = dpr; }
      }
      progress({ phase: 'build', label: 'Building the scene: ' + b.id + ' (level ' + b.levelName + ', shadows ' + b.shadows + ')',
        stageIndex: done, stageCount: total, etaMs: eta() });
      const built = await createBuild(o, b, device, check);
      builds.push(built.info);
      try {
        for (const s of b.stages) {
          check();
          progress({ phase: 'stage', label: stageLabel(s, b), stageIndex: done + 1, stageCount: total, etaMs: eta(),
            measureMs: s.measureMs, warmupMs: s.warmupMs });
          const res = await runStage(built, b, s, { check, ctxInfo, isHidden: () => hiddenNow, hiddenSince: () => hiddenSince,
            onTick: (frac) => progress({ phase: 'stage-tick', fraction: frac, stageIndex: done + 1, stageCount: total, etaMs: eta() }) });
          stages.push(res);
          s._done = true;
          done++;
        }
      } finally {
        b._done = true;
        built.teardown();
        await nextFrame();
      }
    }
  } catch (e) {
    if (e instanceof AbortedError) { aborted = true; abortReason = e.message; }
    else { aborted = true; abortReason = 'error: ' + (e && e.message ? e.message : String(e)); fatal = e; }
  } finally {
    document.removeEventListener('visibilitychange', onVis);
  }
  spentMs = performance.now() - t0;
  // The benchmark pins every build's level (adaptive off, nothing persisted);
  // this proves it, and puts the records back if anything moved regardless.
  const adaptiveState = guard.finish();

  const result = assembleResult({
    app: { version: o.version, houseId: o.houseId, house: o.house },
    run: { mode: plan.mode, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      durationMs: Math.round(spentMs), estimatedMs: plan.estimatedMs, aborted, abortReason, hiddenEvents,
      shadows: shadowsMode,
      adaptiveState },
    device, matrix, plan, builds, stages
  });
  fitToSize(result);
  if (fatal) console.warn('[diagnostics] run stopped by an error', fatal);
  return result;
}

/** Every adaptive-quality record in `ls`, raw ({key: string}), or null without storage. */
export function snapshotAdaptive(ls) {
  try {
    if (!ls) return null;
    const out = {};
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.indexOf(ADAPTIVE_PREFIX) === 0) out[k] = ls.getItem(k);
    }
    return out;
  } catch (e) { return null; }
}

/**
 * Put the records back exactly as they were: keys added since are removed,
 * changed or deleted ones rewritten. Other keys are never touched. Returns
 * whether it managed.
 */
export function restoreAdaptive(ls, before, after) {
  if (!before || !ls) return false;
  try {
    Object.keys(after || {}).forEach(k => { if (!(k in before)) ls.removeItem(k); });
    Object.keys(before).forEach(k => ls.setItem(k, before[k]));
    return true;
  } catch (e) { return false; }
}

/**
 * Guard the adaptive records across a run. finish() compares with the
 * snapshot, restores on any difference, and can be called more than once
 * (the second call finds nothing to do). Returns the run.adaptiveState block.
 */
export function guardAdaptive(ls) {
  const before = snapshotAdaptive(ls);
  return {
    before,
    finish() {
      const after = snapshotAdaptive(ls);
      const untouched = JSON.stringify(before) === JSON.stringify(after);
      const restored = untouched ? false : restoreAdaptive(ls, before, after);
      return { untouched, restored, keysBefore: Object.keys(before || {}).length,
        note: before === null ? 'localStorage unavailable: nothing to protect'
          : 'the app\'s home3d.quality.v1 records were compared before and after the run' };
    }
  };
}

function stageLabel(s, b) {
  const bits = [b.levelName + ' @' + s.dpr];
  if (s.camera !== 'idle' || s.group === 'motion') bits.push('camera ' + s.camera);
  if (s.lights) bits.push('+' + s.lights + ' lights');
  if (s.strip) bits.push(s.strip.label);
  if (!s.furniture) bits.push('no furniture');
  if (b.shadows !== 'auto') bits.push('shadows ' + b.shadows);
  if (s.group === 'sustained') bits.push('sustained ' + Math.round(s.measureMs / 1000) + ' s');
  return s.id + ' -- ' + bits.join(', ');
}

/** Create one scene build and wait until it is fully ready. */
async function createBuild(o, b, device, check) {
  const tCreate = performance.now();
  let readyAt = 0;
  let shaderErrors = 0;
  const inst = o.Home3DScene.create(o.container, {
    house: o.house,
    interactive: false,
    autoRotate: false,
    level: b.level,
    shadows: b.shadows,
    pixelRatio: window.devicePixelRatio || 1,
    maxFps: 0,
    antialias: true,
    furniture: true,
    onReady: () => { readyAt = performance.now(); }
  });
  const D = inst.diagnostics;
  if (!D) { inst.dispose(); throw new Error('this build of the scene has no diagnostics API'); }
  const ren = D.renderer;
  // Captured, not logged: a shader that fails to compile (too many lights for
  // the uniform budget) is a RESULT here, recorded on the stage.
  if (ren.debug) ren.debug.onShaderError = () => { shaderErrors++; };
  // Same scene on every device: noon, local time, on the run date.
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  inst.setSunTime(noon);

  const teardown = () => { try { inst.dispose(); } catch (e) { /* best effort */ } };
  try {
    while (!readyAt) {
      check();
      if (performance.now() - tCreate > READY_TIMEOUT_MS) throw new Error('scene not ready after ' + READY_TIMEOUT_MS + ' ms');
      await sleep(20);
    }
    let furnitureAt = null;
    const fi0 = inst.getFurnitureInfo();
    if (fi0.items > 0) {
      while (!inst.getFurnitureInfo().attached) {
        check();
        if (performance.now() - tCreate > FURNITURE_TIMEOUT_MS) break;
        await sleep(30);
      }
      if (inst.getFurnitureInfo().attached) furnitureAt = performance.now();
    }
    D.setContinuous(true);
    const home = D.homeOrbit();
    inst.setOrbit(home.th, home.ph, home.r, home.target);
    // The first continuous frames after everything is attached: the cold
    // shadow pass lands here.
    const f0 = await nextFrame();
    let f1 = await nextFrame();
    const firstFrameMs = f1 - f0;
    const q = D.quality();
    const fi = inst.getFurnitureInfo();
    const info = {
      id: b.id, level: b.level, levelName: b.levelName, shadows: b.shadows,
      compileMs: Math.round(readyAt - tCreate),
      furnitureAttachMs: furnitureAt ? Math.round(furnitureAt - tCreate) : null,
      firstFrameMs: Math.round(firstFrameMs * 10) / 10,
      shaderErrors,
      quality: q,
      furniture: { items: fi.items, attached: fi.attached, programs: fi.programs },
      renderer: rendererInfo(ren),
      lights: D.lightCounts(),
      heap: heapMB(),
      crossCheck: device.app ? {
        tierMatches: q.compileTier === device.app.compileTier,
        mobileMatches: q.mobileGpu === device.app.mobileGpu
      } : null
    };
    return { inst, D, ren, info, teardown, shaderErrorCount: () => shaderErrors, lightsKey: 'none', lightsAdded: 0 };
  } catch (e) {
    teardown();
    throw e;
  }
}

/**
 * Idle rAF ticks with the scene not drawing: {medianMs, fps, throttled, ticks}.
 * Nothing moves the camera meanwhile, so the on-demand scene draws nothing.
 */
async function idleTicks(D, ms) {
  D.setContinuous(false);
  await nextFrame(); await nextFrame();   // let the last requested frame land
  const d = [];
  let last = 0;
  const end = performance.now() + ms;
  while (performance.now() < end || d.length < 5) {
    const ts = await nextFrame();
    if (last) d.push(ts - last);
    last = ts;
    if (d.length >= 40) break;
  }
  const t = rafThrottle(d);
  const med = percentile(d, 50);
  return { medianMs: Math.round(med * 100) / 100, fps: t.fps, throttled: t.throttled, ticks: d.length };
}

let rectAreaReady = null;
/**
 * RectAreaLight shades with LTC lookup tables that three keeps out of core:
 * RectAreaLightUniformsLib.init() patches this THREE instance's UniformsLib
 * once. Loaded lazily (~300 KB), only when a strip stage needs it.
 */
function ensureRectAreaLib() {
  if (!rectAreaReady) {
    rectAreaReady = import('../../vendor/three-r160/addons/lights/RectAreaLightUniformsLib.js')
      .then(m => { m.RectAreaLightUniformsLib.init(); });
  }
  return rectAreaReady;
}

/**
 * Light specs for n strips (binding addition #2). A strip is ~1 m x 2 cm on a
 * wall, 0.9 m up, facing into the room. 'point': perStrip dim PointLights
 * spread along the metre (reach 2.5 m, decay 2, total intensity per strip
 * fixed so B is brightness-comparable with A). 'rect': one RectAreaLight.
 */
export function stripLightSpecs(anchors, strip) {
  const out = [];
  anchors.forEach(a => {
    if (strip.kind === 'rect') {
      out.push({ type: 'rect', position: a.position, lookAt: a.facing, intensity: 8, width: 1, height: 0.02, color: 0xffd9a0 });
      return;
    }
    const k = Math.max(1, strip.perStrip | 0);
    for (let i = 0; i < k; i++) {
      const t = k === 1 ? 0 : (i + 0.5) / k - 0.5;
      out.push({ type: 'point', position: [a.position[0] + a.along[0] * t, a.position[1], a.position[2] + a.along[2] * t],
        intensity: 0.4 / k, distance: 2.5, decay: 2, color: 0xffd9a0 });
    }
  });
  return out;
}

/** Run one stage on a live build. */
async function runStage(built, b, s, ctx) {
  const { inst, D, ren } = built;
  const errors0 = built.shaderErrorCount();
  const home = D.homeOrbit();
  const fp = D.footprintMetres();
  const pose = (t) => { const p = motionPose(s.camera, t, home, fp); inst.setOrbit(p.th, p.ph, p.r, p.target); };

  // ---- apply ----
  const tApply = performance.now();
  let changeTimedOut = false;
  const frames0 = inst.getFrameCount();
  D.setPixelRatio(s.dpr);
  const lightsKey = s.strip ? 'strip:' + s.id : 'n:' + s.lights;
  if (built.lightsKey !== lightsKey) {
    D.clearPointLights();
    built.lightsAdded = 0;
    if (s.strip && s.strip.strips > 0) {
      if (s.strip.kind === 'rect') await ensureRectAreaLib();
      built.lightsAdded = D.addLights(stripLightSpecs(D.stripAnchors(s.strip.strips), s.strip));
    } else if (!s.strip && s.lights > 0) {
      built.lightsAdded = D.addPointLights(s.lights);
    }
    built.lightsKey = lightsKey;
  }
  if (inst.getFurnitureVisible() !== s.furniture) inst.setFurnitureVisible(s.furniture);
  pose(0);
  // Change frames: until two frames have been drawn with the new settings.
  while (inst.getFrameCount() < frames0 + 2) {
    ctx.check();
    await nextFrame();
    if (performance.now() - tApply > CHANGE_TIMEOUT_MS) { changeTimedOut = true; break; }
  }
  const changeFrameMs = Math.round((performance.now() - tApply) * 10) / 10;

  // ---- warm-up (moving, discarded) ----
  const gpu = createGpuTimer(ren.getContext());
  const cpu = createCpuTimer();
  const detach = attachToScene(D.scene, { gpu: gpu.supported ? gpu : null, cpu });
  const rec = createFrameRecorder();
  const lt = createLongTaskObserver();
  const tStart = performance.now();
  let hidden = ctx.isHidden();
  let result;
  try {
    let ts = await nextFrame();
    const motionT0 = ts;
    while (ts - motionT0 < s.warmupMs) {
      ctx.check();
      pose((ts - motionT0) / 1000);
      gpu.poll();
      ts = await nextFrame();
      if (ctx.isHidden()) hidden = true;
    }
    gpu.poll(); gpu.take(); cpu.take(); gpu.resetDrops();

    // ---- measure ----
    const renders0 = inst.getFrameCount();
    rec.start();
    lt.start();
    const heap0 = heapMB();
    const tMeasure = ts;
    let ticks = 0;
    let lastFrac = 0;
    const gpuSamples = [], cpuSamples = [];
    while (ts - tMeasure < s.measureMs) {
      ctx.check();
      rec.tick(ts);
      ticks++;
      pose((ts - motionT0) / 1000);
      gpu.poll();
      if (ctx.isHidden()) hidden = true;
      const frac = (ts - tMeasure) / s.measureMs;
      if (frac - lastFrac > 0.05) { lastFrac = frac; ctx.onTick(frac); }
      ts = await nextFrame();
    }
    rec.tick(ts);
    rec.stop();
    // Let the last queries land.
    for (let i = 0; i < 4; i++) { gpu.poll(); await nextFrame(); }
    gpuSamples.push(...gpu.take());
    cpuSamples.push(...cpu.take());
    const renders = inst.getFrameCount() - renders0;
    const longTasks = lt.take();
    // Is the BROWSER holding frames back? Stop drawing and time idle rAF
    // ticks: with nothing to draw they arrive at the display's refresh unless
    // the browser throttles (an occluded or background window, power saving,
    // an embedding page). The app's own adaptive quality uses the same test
    // (rafThrottle). A throttled stage measured the browser, not the GPU.
    const idle = await idleTicks(D, 450);
    D.setContinuous(true);
    lt.stop();

    const iv = rec.intervals;
    const frames = summarizeIntervals(iv);
    const maxGap = iv.length ? Math.max.apply(null, iv) : 0;
    const errors = built.shaderErrorCount() - errors0;
    let valid = true, invalidReason = null;
    if (changeTimedOut) { valid = false; invalidReason = 'the settings change had not reached the screen after ' + (CHANGE_TIMEOUT_MS / 1000) + ' s (shader recompile)'; }
    else if (hidden) { valid = false; invalidReason = 'page was hidden during the stage (rAF throttled)'; }
    else if (!frames) { valid = false; invalidReason = 'no frames recorded'; }
    else if (maxGap > GAP_INVALID_MS) { valid = false; invalidReason = 'a ' + Math.round(maxGap) + ' ms gap: the browser stopped delivering frames'; }
    else if (idle.throttled) { valid = false; invalidReason = 'the browser throttles animation frames (idle ticks at ~' + idle.fps + ' fps): an occluded/background window or power saving'; }
    else if (renders < iv.length * 0.8) { valid = false; invalidReason = 'the scene drew ' + renders + ' frames for ' + iv.length + ' ticks'; }

    result = {
      id: s.id, build: b.id, group: s.group, grid: !!s.grid,
      level: b.level, levelName: b.levelName, shadows: b.shadows,
      dpr: s.dpr, dprApplied: D.getPixelRatio(),
      camera: s.camera, lightsAdded: built.lightsAdded, furniture: s.furniture,
      config: b.config ? { tier: b.config.tier, furnitureDetail: b.config.furnitureDetail, dropMinorFurniture: b.config.dropMinorFurniture,
        sunShadow: b.config.sunShadow, roomShadowLights: b.config.roomShadowLights, shadowMapScale: b.config.shadowMapScale } : null,
      strip: s.strip || null,
      warmupMs: s.warmupMs, measureMs: s.measureMs,
      valid, invalidReason,
      compileFailed: errors > 0, shaderErrors: errors,
      uniforms: (s.group === 'strip' || s.group === 'lights' || s.group === 'baseline') ? {
        lightVectorsEstimate: estimateLightVectors(D.lightCounts()),
        measuredMaxVectors: measuredMaxUniformVectors(ren),
        maxFragmentUniformVectors: ctx.ctxInfo ? ctx.ctxInfo.maxFragU : null,
        note: 'estimate: lights only, three r160 structs (the number to compare with the limit, leaving room for material uniforms). measured: largest active-uniform footprint (vertex+fragment) among programs still alive at the end of the stage -- may include programs from the previous stage until three releases them'
      } : null,
      changeFrameMs,
      idleTick: { medianMs: idle.medianMs, fps: idle.fps, throttled: idle.throttled, ticks: idle.ticks },
      frames,
      histogram: histogram(iv),
      series: downsampleMax(iv, SERIES_POINTS),
      seriesNote: iv.length > SERIES_POINTS ? 'max per bucket of ' + Math.ceil(iv.length / SERIES_POINTS) + ' frames' : 'every frame',
      renderedFrames: renders, ticks,
      gpu: gpu.supported ? summarizeSamples(gpuSamples) : null,
      gpuReason: gpu.supported ? (gpuSamples.length ? null : 'no timer results landed (disjoint or not yet available)') : gpu.reason,
      gpuDisjointDrops: gpu.supported ? gpu.disjointDrops : null,
      cpu: summarizeSamples(cpuSamples),
      drift: s.group === 'sustained' ? drift(iv) : null,
      gpuDrift: s.group === 'sustained' && gpuSamples.length ? drift(gpuSamples) : null,
      renderer: rendererInfo(ren),
      lights: D.lightCounts(),
      heap: { start: heap0, end: heapMB() },
      heapReason: heap0 ? null : 'performance.memory not exposed (Chromium-only)',
      longTasks,
      longTasksReason: longTasks ? null : lt.reason,
      wallMs: Math.round(performance.now() - tStart)
    };
  } finally {
    detach();
    gpu.dispose();
  }
  return result;
}
