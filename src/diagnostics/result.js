/**
 * result.js - assemble the benchmark's result document (item 112ec00c). Pure.
 *
 * ONE JSON document, self-describing: a schema id and version, a short human
 * summary first (so an agent or a person reading the top of it knows what it
 * says before parsing anything), then the device, the matrix that ran, the
 * builds, every stage, and the verdict. The schema is documented field by
 * field in docs/diagnostics.md.
 *
 * SIZE: the whole document stays under MAX_BYTES (the save endpoint caps a
 * body at 256 KB). fitToSize() drops the downsampled per-frame series first,
 * longest stage first, then the extension list -- the summaries, histograms
 * and verdict always survive -- and records what it dropped.
 */

import { computeVerdict } from './verdict.js';

export const SCHEMA = 'home3d-diagnostics';
export const SCHEMA_VERSION = 1;
export const MAX_BYTES = 200 * 1024;

const fmt = (x, d = 1) => (Number.isFinite(x) ? (Math.round(x * 10 ** d) / 10 ** d).toString() : '?');

/**
 * The house as the result names it: 'demo' for the public demo house, and
 * 'custom' for anything else. A real profile's directory name is often a
 * person's name (it is on the live deployment), so it never leaves the
 * device -- the counts below say what an analyst needs.
 */
export function publicHouseId(id) {
  return id === 'demo' ? 'demo' : 'custom';
}

/** House counts only -- never names, coordinates or entity ids. */
export function houseCounts(house) {
  if (!house) return null;
  const n = v => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);
  return {
    rooms: n(house.rooms), walls: n(house.walls), doors: n(house.doors), windows: n(house.windows),
    curtains: n(house.curtains), furnitureItems: n(house.furniture)
  };
}

/** The human summary: a handful of plain lines. */
export function summarize(r) {
  const d = r.device || {};
  const gl = d.webgl || {};
  const app = d.app || {};
  const lines = [];
  lines.push('3dHome diagnostics (' + r.run.mode + (r.run.aborted ? ', ABORTED' : '') + ') -- app ' + r.app.version +
    ', house "' + r.app.houseId + '", ' + r.run.startedAt);
  lines.push('Device: ' + (gl.unmaskedRenderer || gl.renderer || 'unknown GPU') + ' | ' + (d.platform || '?') +
    ' | DPR ' + (d.devicePixelRatio || '?') + ' | ' + (d.hardwareConcurrency || '?') + ' cores' +
    (d.deviceMemoryGB ? ' | ' + d.deviceMemoryGB + ' GB' : '') +
    (d.refreshRateHz ? ' | ~' + d.refreshRateHz + ' Hz' : '') +
    (d.battery ? ' | battery ' + Math.round(d.battery.level * 100) + '%' + (d.battery.charging ? ' charging' : '') : '') +
    (d.embedding && d.embedding.inIframe ? ' | embedded' : ''));
  if (app && app.tier) {
    lines.push('App decision: compiles ' + app.compileTier + ', mobileGpu=' + app.mobileGpu + ' (' + app.mobileReason + ')' +
      ', max level ' + app.maxLevel + ', default ' + (app.defaultLevelName || app.defaultLevel) +
      '; RUNNING level ' + (app.currentLevelName || '?') + ' (' + (app.currentLevelFrom || '?') + ') @' +
      (app.currentDpr != null ? app.currentDpr : '?') + ', furniture ' +
      (app.currentLevelConfig ? app.currentLevelConfig.furnitureDetail + ' detail' +
        (app.currentLevelConfig.dropMinorFurniture ? ' without minor items' : '') : '?') +
      ', shadows=' + (app.shadowsMode || 'auto'));
  }
  const v = r.verdict || {};
  if (v.summary) lines.push('Verdict: ' + v.summary + '.');
  else if (v.recommendation) lines.push('Verdict: ' + v.recommendation + '.');
  if (v.target && v.smoothTarget) {
    lines.push('Lines: recommended = app step-down (p95 <= ' + v.target.p95Ms + ' ms, the adaptive ladder threshold on this display); ' +
      'smooth 30 fps (p95 <= ' + v.smoothTarget.p95Ms + ' ms): ' + (v.bestSmooth ? v.bestSmooth.levelName + ' @' + v.bestSmooth.dpr : 'nothing measured') + '.');
  }
  (v.levelLines || []).forEach(l => lines.push(l));
  if (v.furniture && v.furniture.line) lines.push(v.furniture.line);
  if (v.stripLights) v.stripLights.lines.forEach(l => lines.push(l));
  if (v.perLightMs) {
    lines.push('Per extra light: ' + (v.perLightMs.gpu != null ? fmt(v.perLightMs.gpu, 3) + ' ms GPU' : 'no GPU timer') +
      ', ' + fmt(v.perLightMs.frame, 3) + ' ms frame' +
      (v.perLightMs.firstFailingLights != null ? '; target first missed at +' + v.perLightMs.firstFailingLights : '; target held up to the max tested'));
  }
  if (v.thermal) lines.push('Sustained: frame-time drift ' + fmt(v.thermal.driftPct) + '%' +
    (v.thermal.throttlingSuspected ? ' -- thermal throttling suspected' : ''));
  if (r.run && r.run.adaptiveState) lines.push('App adaptive-quality record: ' + (r.run.adaptiveState.untouched ? 'untouched by this run' : 'CHANGED during the run' + (r.run.adaptiveState.restored ? ' and restored' : '')) + '.');
  const bad = r.stages.filter(s => !s.valid);
  if (bad.length) lines.push(bad.length + ' of ' + r.stages.length + ' stages invalid (' +
    bad.slice(0, 3).map(s => s.id + ': ' + s.invalidReason).join('; ') + (bad.length > 3 ? '; ...' : '') + ').');
  return lines;
}

/**
 * Assemble the document.
 *
 * @param {Object} o
 * @param {Object} o.app     { version, houseId, house (compiled profile; only counts are kept) }
 * @param {Object} o.run     { mode, startedAt, finishedAt, durationMs, aborted, abortReason, hiddenEvents }
 * @param {Object} o.device  collectDevice() output
 * @param {Object} o.matrix  describePlan() output
 * @param {Object} o.plan    the plan (defaultLevel, defaultDpr) for the verdict
 * @param {Object[]} o.builds
 * @param {Object[]} o.stages
 */
export function assembleResult(o) {
  const stages = o.stages || [];
  const r = {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    summary: [],
    app: { version: o.app.version, houseId: publicHouseId(o.app.houseId), house: houseCounts(o.app.house), page: '/diagnostics' },
    run: Object.assign({ stagesRun: stages.length, stagesInvalid: stages.filter(s => !s.valid).length }, o.run),
    device: o.device,
    matrix: o.matrix,
    builds: o.builds || [],
    stages,
    verdict: computeVerdict(stages, o.plan),
    trimmed: [],
    save: null
  };
  r.summary = summarize(r);
  return r;
}

/** Bytes of the JSON encoding (UTF-8). */
export function byteSize(obj) {
  const s = JSON.stringify(obj);
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf8');
}

/** Trim a result in place until it fits. Returns it. */
export function fitToSize(r, maxBytes = MAX_BYTES) {
  if (byteSize(r) <= maxBytes) return r;
  const withSeries = r.stages.filter(s => s.series && s.series.length).sort((a, b) => b.series.length - a.series.length);
  for (const s of withSeries) {
    s.series = null;
    r.trimmed.push('stages.' + s.id + '.series');
    if (byteSize(r) <= maxBytes) return r;
  }
  if (r.device && r.device.webgl && Array.isArray(r.device.webgl.extensions)) {
    r.device.webgl.extensions = r.device.webgl.extensions.length;
    r.trimmed.push('device.webgl.extensions (replaced by its count)');
  }
  return r;
}
