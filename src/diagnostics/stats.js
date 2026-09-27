/**
 * stats.js - frame-time statistics, as pure functions (item 112ec00c).
 *
 * Used by the /diagnostics benchmark, and written to be reused by anything
 * else that wants the same numbers from a series of frame intervals (a perf
 * HUD, a spec page's own meter). No DOM, no THREE, no clock: every input is
 * an array of numbers, so scripts/test-diagnostics-stats.mjs drives it
 * directly.
 *
 * DEFINITIONS (the result schema in docs/diagnostics.md repeats them; keep
 * the two in step):
 *
 *   interval       ms between two consecutive rendered frames (rAF timestamps).
 *   percentile     nearest-rank: the smallest value with at least p% of the
 *                  samples at or below it. Always a real sample, never an
 *                  interpolation, so a p99 of 3 frames is the max.
 *   over33 / over50  frames whose interval exceeds 33.4 / 50 ms. 33.4 rather
 *                  than 33.3 so a vsync-locked steady 30 fps (33.33 ms) is
 *                  not counted as a miss.
 *   jank           a frame longer than twice the stage's own median AND more
 *                  than one 60 Hz refresh (16.7 ms) over it: a frame the
 *                  device visibly dropped relative to its own cadence. Both
 *                  conditions, so a 120 Hz device (8.3 ms median) is not
 *                  charged a jank for an ordinary 17 ms frame.
 *   longest stall  the longest CONTIGUOUS run of frames each over 33.4 ms,
 *                  summed: a stutter the eye sees as one freeze, which a
 *                  single-frame max under-reports.
 */

export const MISS_33_MS = 33.4;
export const MISS_50_MS = 50;
export const REFRESH_60_MS = 1000 / 60;

/** Histogram bucket upper edges (ms); the last bucket is open-ended. */
export const HIST_EDGES = Object.freeze([8.4, 11.2, 16.8, 20, 25, 33.4, 50, 100]);

const r2 = x => Math.round(x * 100) / 100;

/** Nearest-rank percentile of an ALREADY SORTED ascending array. NaN when empty. */
export function percentileSorted(sorted, p) {
  if (!sorted.length) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Nearest-rank percentile of an unsorted array (copies; never mutates). */
export function percentile(values, p) {
  return percentileSorted(values.slice().sort((a, b) => a - b), p);
}

/** Longest contiguous run of intervals each above `limit`, summed (ms). */
export function longestStall(intervals, limit = MISS_33_MS) {
  let best = 0, run = 0;
  for (let i = 0; i < intervals.length; i++) {
    if (intervals[i] > limit) { run += intervals[i]; if (run > best) best = run; }
    else run = 0;
  }
  return best;
}

/** Frames that jank relative to the series' own median (see the header). */
export function jankCount(intervals, median) {
  if (!(median > 0)) return 0;
  const bar = Math.max(2 * median, median + REFRESH_60_MS);
  let n = 0;
  for (let i = 0; i < intervals.length; i++) if (intervals[i] > bar) n++;
  return n;
}

/** Counts per HIST_EDGES bucket (length HIST_EDGES.length + 1). */
export function histogram(intervals, edges = HIST_EDGES) {
  const out = new Array(edges.length + 1).fill(0);
  for (let i = 0; i < intervals.length; i++) {
    const v = intervals[i];
    let b = 0;
    while (b < edges.length && v > edges[b]) b++;
    out[b]++;
  }
  return out;
}

/**
 * Downsample a series to at most `max` points, keeping each bucket's MAX: a
 * stall must survive the compression, and a mean would smear it away.
 * Values are rounded to 0.1 ms.
 */
export function downsampleMax(values, max) {
  const out = [];
  if (!values.length || !(max > 0)) return out;
  const step = Math.max(1, Math.ceil(values.length / max));
  for (let i = 0; i < values.length; i += step) {
    let m = -Infinity;
    for (let j = i; j < Math.min(values.length, i + step); j++) if (values[j] > m) m = values[j];
    out.push(Math.round(m * 10) / 10);
  }
  return out;
}

/**
 * Summarise a series of frame intervals (ms). Returns null for an empty one.
 * Every number is rounded to 0.01 ms (or 0.01 %).
 */
export function summarizeIntervals(intervals) {
  const n = intervals.length;
  if (!n) return null;
  const sorted = intervals.slice().sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += intervals[i];
  const p50 = percentileSorted(sorted, 50);
  const over33 = intervals.filter(v => v > MISS_33_MS).length;
  const over50 = intervals.filter(v => v > MISS_50_MS).length;
  const jank = jankCount(intervals, p50);
  return {
    frames: n,
    durationMs: r2(sum),
    fpsMean: r2(n / (sum / 1000)),
    meanMs: r2(sum / n),
    p50Ms: r2(p50),
    p90Ms: r2(percentileSorted(sorted, 90)),
    p95Ms: r2(percentileSorted(sorted, 95)),
    p99Ms: r2(percentileSorted(sorted, 99)),
    maxMs: r2(sorted[n - 1]),
    minMs: r2(sorted[0]),
    over33: over33,
    over50: over50,
    pctOver33: r2(100 * over33 / n),
    pctOver50: r2(100 * over50 / n),
    longestStallMs: r2(longestStall(intervals)),
    jankFrames: jank,
    jankPct: r2(100 * jank / n)
  };
}

/**
 * Summarise any other per-frame sample series (GPU ms, CPU submit ms):
 * mean / p50 / p95 / max, or null when empty.
 */
export function summarizeSamples(values) {
  const n = values.length;
  if (!n) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  return {
    samples: n,
    meanMs: r2(sum / n),
    p50Ms: r2(percentileSorted(sorted, 50)),
    p95Ms: r2(percentileSorted(sorted, 95)),
    maxMs: r2(sorted[n - 1])
  };
}

/**
 * Least-squares slope and intercept of y on x. null with fewer than two
 * distinct x values.
 */
export function linearFit(xs, ys) {
  const pts = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pts.push([xs[i], ys[i]]);
  }
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0;
  pts.forEach(p => { sxx += (p[0] - mx) * (p[0] - mx); sxy += (p[0] - mx) * (p[1] - my); });
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, points: n };
}

/**
 * Thermal drift across a long stage: split the series into `windows`
 * consecutive chunks and compare the first chunk's MEAN with the last's.
 * driftPct > 0 means frames got SLOWER over the run. The mean, not the
 * median: on a vsync-locked display the median sits on the refresh interval
 * until the device is already dropping half its frames, while the mean moves
 * with the first dropped ones. The medians ride along for context.
 * Works on any per-frame series (frame intervals, or GPU ms).
 */
export function drift(values, windows = 6) {
  if (values.length < windows * 5) return null;
  const size = Math.floor(values.length / windows);
  const means = [], medians = [];
  for (let w = 0; w < windows; w++) {
    const chunk = values.slice(w * size, (w + 1) * size);
    means.push(r2(chunk.reduce((s, v) => s + v, 0) / chunk.length));
    medians.push(r2(percentile(chunk, 50)));
  }
  const first = means[0], last = means[means.length - 1];
  return { windowMeanMs: means, windowMedianMs: medians, driftPct: first > 0 ? r2(100 * (last - first) / first) : null };
}
