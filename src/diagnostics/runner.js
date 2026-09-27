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
import { assembleResult, fitToSize } from './result.js';
import { rafThrottle } from '../adaptive-quality.js';

const SERIES_POINTS = 240;
const READY_TIMEOUT_MS = 90000;
const FURNITURE_TIMEOUT_MS = 60000;
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
  const device = await collectDevice(window);
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
  const plan = buildPlan({ mode: o.mode, maxLevel: device.app.maxLevel, defaultLevel: device.app.defaultLevel,
    mobile: device.app.mobileCaps === true, deviceDpr: window.devicePixelRatio || 1 });
  const matrix = describePlan(plan);
  matrix.motions = MOTIONS;
  matrix.histogramEdgesMs = HIST_EDGES;
  matrix.sun = 'pinned to 12:00 local time on the run date, so every device lights the same scene';

  const builds = [];
  const stages = [];
  const total = plan.stageCount;
  let done = 0;
  let spentMs = 0;
  let aborted = false, abortReason = null, fatal = null;

  const eta = () => {
    const remaining = plan.builds.reduce((s, b) => s + b.stages.filter(st => !st._done)
      .reduce((a, st) => a + st.warmupMs + st.measureMs + 300, 0) + (b._done ? 0 : 4000), 0);
    return remaining;
  };

  try {
    for (const b of plan.builds) {
      check();
      progress({ phase: 'build', label: 'Building the scene: ' + b.id + ' (level ' + b.levelName + ', shadows ' + b.shadows + ')',
        stageIndex: done, stageCount: total, etaMs: eta() });
      const built = await createBuild(o, b, device, check);
      builds.push(built.info);
      try {
        for (const s of b.stages) {
          check();
          progress({ phase: 'stage', label: stageLabel(s, b), stageIndex: done + 1, stageCount: total, etaMs: eta(),
            measureMs: s.measureMs, warmupMs: s.warmupMs });
          const res = await runStage(built, b, s, { check, isHidden: () => hiddenNow, hiddenSince: () => hiddenSince,
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

  const result = assembleResult({
    app: { version: o.version, houseId: o.houseId, house: o.house },
    run: { mode: plan.mode, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      durationMs: Math.round(spentMs), estimatedMs: plan.estimatedMs, aborted, abortReason, hiddenEvents },
    device, matrix, plan, builds, stages
  });
  fitToSize(result);
  if (fatal) console.warn('[diagnostics] run stopped by an error', fatal);
  return result;
}

function stageLabel(s, b) {
  const bits = [b.levelName + ' @' + s.dpr];
  if (s.camera !== 'idle' || s.group === 'motion') bits.push('camera ' + s.camera);
  if (s.lights) bits.push('+' + s.lights + ' lights');
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
    return { inst, D, ren, info, teardown, shaderErrorCount: () => shaderErrors, lightsAdded: 0 };
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

/** Run one stage on a live build. */
async function runStage(built, b, s, ctx) {
  const { inst, D, ren } = built;
  const errors0 = built.shaderErrorCount();
  const home = D.homeOrbit();
  const fp = D.footprintMetres();
  const pose = (t) => { const p = motionPose(s.camera, t, home, fp); inst.setOrbit(p.th, p.ph, p.r, p.target); };

  // ---- apply ----
  const tApply = performance.now();
  const frames0 = inst.getFrameCount();
  D.setPixelRatio(s.dpr);
  if (built.lightsAdded !== s.lights) {
    D.clearPointLights();
    if (s.lights > 0) D.addPointLights(s.lights);
    built.lightsAdded = s.lights;
  }
  if (inst.getFurnitureVisible() !== s.furniture) inst.setFurnitureVisible(s.furniture);
  pose(0);
  // Change frames: until two frames have been drawn with the new settings.
  while (inst.getFrameCount() < frames0 + 2) {
    ctx.check();
    await nextFrame();
    if (performance.now() - tApply > READY_TIMEOUT_MS) break;
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
    if (hidden) { valid = false; invalidReason = 'page was hidden during the stage (rAF throttled)'; }
    else if (!frames) { valid = false; invalidReason = 'no frames recorded'; }
    else if (maxGap > GAP_INVALID_MS) { valid = false; invalidReason = 'a ' + Math.round(maxGap) + ' ms gap: the browser stopped delivering frames'; }
    else if (idle.throttled) { valid = false; invalidReason = 'the browser throttles animation frames (idle ticks at ~' + idle.fps + ' fps): an occluded/background window or power saving'; }
    else if (renders < iv.length * 0.8) { valid = false; invalidReason = 'the scene drew ' + renders + ' frames for ' + iv.length + ' ticks'; }

    result = {
      id: s.id, build: b.id, group: s.group, grid: !!s.grid,
      level: b.level, levelName: b.levelName, shadows: b.shadows,
      dpr: s.dpr, dprApplied: D.getPixelRatio(),
      camera: s.camera, lightsAdded: s.lights, furniture: s.furniture,
      warmupMs: s.warmupMs, measureMs: s.measureMs,
      valid, invalidReason,
      compileFailed: errors > 0, shaderErrors: errors,
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
