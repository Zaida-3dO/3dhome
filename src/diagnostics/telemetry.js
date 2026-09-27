/**
 * telemetry.js - per-frame measurement primitives for a running three.js
 * scene (item 112ec00c). Browser-side, no THREE import.
 *
 * WRITTEN TO BE REUSED. The /diagnostics benchmark is the first consumer; a
 * perf HUD (the strip-light work has one) can adopt the same pieces instead
 * of growing its own meter:
 *
 *   const rec = createFrameRecorder();      // feed it rAF timestamps
 *   const gpu = createGpuTimer(renderer.getContext());
 *   const detach = attachToScene(scene, { gpu, cpu });  // bracket every render
 *   ...
 *   summarizeIntervals(rec.intervals)       // from ./stats.js
 *
 * Every primitive reports `supported` and, when false, a `reason` -- the
 * result schema's null-with-a-reason rule starts here.
 */

/** Frame intervals from rAF timestamps. */
export function createFrameRecorder() {
  let last = 0;
  let on = false;
  const intervals = [];
  return {
    intervals,
    /** Start recording; the next tick is the reference, not a sample. */
    start() { intervals.length = 0; last = 0; on = true; },
    stop() { on = false; },
    tick(ts) {
      if (!on) return;
      if (last) intervals.push(ts - last);
      last = ts;
    },
    get recording() { return on; }
  };
}

/**
 * GPU time per frame via EXT_disjoint_timer_query_webgl2 (WebGL2 only).
 * begin()/end() bracket one frame; results arrive a few frames later and
 * are collected by poll(). A disjoint event (the GPU was interrupted:
 * power state, context switch) invalidates every query in flight; those are
 * dropped and counted, never reported as numbers.
 */
export function createGpuTimer(gl) {
  let ext = null, reason = null;
  const isGL2 = !!(gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext);
  if (!gl) reason = 'no WebGL context';
  else if (!isGL2) reason = 'WebGL1 context: EXT_disjoint_timer_query_webgl2 needs WebGL2';
  else {
    try { ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch (e) { ext = null; }
    if (!ext) reason = 'EXT_disjoint_timer_query_webgl2 not exposed (common: restricted for fingerprinting)';
  }
  const pending = [];
  const free = [];
  let active = null;
  let samples = [];
  let disjointDrops = 0;
  const MAX_PENDING = 16;
  return {
    supported: !!ext,
    reason,
    begin() {
      if (!ext || active || pending.length >= MAX_PENDING) return;
      const q = free.pop() || gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      active = q;
    },
    end() {
      if (!ext || !active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    },
    /** Collect finished queries into the sample list. Call once per frame. */
    poll() {
      if (!ext) return;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      while (pending.length) {
        const q = pending[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        pending.shift();
        if (disjoint) disjointDrops++;
        else samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        free.push(q);
      }
      if (disjoint) { disjointDrops += pending.length; pending.forEach(q => free.push(q)); pending.length = 0; }
    },
    /** Take (and clear) the samples collected so far, in ms. */
    take() { const s = samples; samples = []; return s; },
    get disjointDrops() { return disjointDrops; },
    resetDrops() { disjointDrops = 0; },
    dispose() {
      if (!ext) return;
      try { if (active) gl.endQuery(ext.TIME_ELAPSED_EXT); } catch (e) { /* ignore */ }
      pending.concat(free).forEach(q => { try { gl.deleteQuery(q); } catch (e) { /* ignore */ } });
      pending.length = 0; free.length = 0; active = null;
    }
  };
}

/** CPU time of the render call, from scene.onBeforeRender to onAfterRender. */
export function createCpuTimer() {
  let t0 = 0;
  let samples = [];
  return {
    supported: typeof performance !== 'undefined' && typeof performance.now === 'function',
    reason: null,
    begin() { t0 = performance.now(); },
    end() { if (t0) samples.push(performance.now() - t0); t0 = 0; },
    take() { const s = samples; samples = []; return s; }
  };
}

/**
 * Bracket every render of `scene` with the given timers, using three's own
 * scene.onBeforeRender / onAfterRender hooks (called by WebGLRenderer.render
 * before the shadow pass and after the last draw). Returns a detach function
 * that restores the previous hooks.
 */
export function attachToScene(scene, timers) {
  const prevBefore = scene.onBeforeRender;
  const prevAfter = scene.onAfterRender;
  const list = Object.values(timers).filter(Boolean);
  scene.onBeforeRender = function () {
    for (let i = 0; i < list.length; i++) list[i].begin();
    return prevBefore.apply(this, arguments);
  };
  scene.onAfterRender = function () {
    const r = prevAfter.apply(this, arguments);
    for (let i = list.length - 1; i >= 0; i--) list[i].end();
    return r;
  };
  return () => { scene.onBeforeRender = prevBefore; scene.onAfterRender = prevAfter; };
}

/** Long tasks (> 50 ms on the main thread), where the browser reports them. */
export function createLongTaskObserver() {
  const PO = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null;
  const ok = !!(PO && PO.supportedEntryTypes && PO.supportedEntryTypes.indexOf('longtask') !== -1);
  let obs = null;
  let entries = [];
  return {
    supported: ok,
    reason: ok ? null : 'PerformanceObserver longtask not supported (Chromium-only)',
    start() {
      entries = [];
      if (!ok || obs) return;
      try {
        obs = new PO(list => { list.getEntries().forEach(e => entries.push(e.duration)); });
        obs.observe({ type: 'longtask', buffered: false });
      } catch (e) { obs = null; }
    },
    /** Summary since start(): {count, totalMs, maxMs}, or null when unsupported. */
    take() {
      if (!ok) return null;
      const out = { count: entries.length, totalMs: Math.round(entries.reduce((s, v) => s + v, 0)),
        maxMs: entries.length ? Math.round(Math.max.apply(null, entries)) : 0 };
      entries = [];
      return out;
    },
    stop() { if (obs) { try { obs.disconnect(); } catch (e) { /* ignore */ } obs = null; } }
  };
}

/** performance.memory in MB, or null (Chromium only). */
export function heapMB() {
  const m = typeof performance !== 'undefined' ? performance.memory : null;
  if (!m) return null;
  return { usedMB: Math.round(m.usedJSHeapSize / 1048576), totalMB: Math.round(m.totalJSHeapSize / 1048576),
    limitMB: Math.round(m.jsHeapSizeLimit / 1048576) };
}

/** renderer.info as plain numbers (the LAST frame's render counts; memory totals). */
export function rendererInfo(renderer) {
  const i = renderer && renderer.info;
  if (!i) return null;
  return {
    drawCalls: i.render ? i.render.calls : null,
    triangles: i.render ? i.render.triangles : null,
    points: i.render ? i.render.points : null,
    lines: i.render ? i.render.lines : null,
    geometries: i.memory ? i.memory.geometries : null,
    textures: i.memory ? i.memory.textures : null,
    programs: Array.isArray(i.programs) ? i.programs.length : null
  };
}
