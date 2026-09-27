#!/usr/bin/env node
/**
 * The /diagnostics benchmark's plan, verdict and result document
 * (item 112ec00c): src/diagnostics/matrix.js, verdict.js, result.js.
 * No framework, no install: `node scripts/test-diagnostics-verdict.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. The plan: the base build is the app's default level; other levels are
 *      deduped by what they BUILD (not by name); quick mode is a strict
 *      subset; pixel ratios never exceed the device's; the default ratio is
 *      the app's (1.5 cap on a mobile GPU).
 *   2. The verdict: "holds" needs BOTH p95 and the >50 ms rate; invalid
 *      stages are never used; raise / keep / reduce each come out when they
 *      should; headroom uses the GPU basis when present; per-light cost is
 *      the slope; thermal drift flags throttling.
 *   3. The document: schema id and version, a summary first, house COUNTS
 *      only (no names, no coordinates), and fitToSize() drops series before
 *      anything else and records what it dropped.
 *   4. The scene hooks are inert by default (static check on
 *      src/home3d-scene.js): the pin starts null, continuous starts false,
 *      and `opts.level` is only read behind Number.isInteger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const MX = await imp('src/diagnostics/matrix.js');
const V = await imp('src/diagnostics/verdict.js');
const R = await imp('src/diagnostics/result.js');
const AQ = await imp('src/adaptive-quality.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// ---- 1. the plan --------------------------------------------------------------
check('dprSteps(1) = [1]', MX.dprSteps(1).join() === '1', MX.dprSteps(1));
check('dprSteps(2) = [1,1.5,2]', MX.dprSteps(2).join() === '1,1.5,2', MX.dprSteps(2));
check('dprSteps(2.625) keeps the device max', MX.dprSteps(2.625).join() === '1,1.5,2.63', MX.dprSteps(2.625));
check('dprSteps(1.25) has no 1.5 (above the max)', MX.dprSteps(1.25).join() === '1,1.25', MX.dprSteps(1.25));
check('app default dpr: desktop min(dpr,2)', MX.appDefaultDpr(3, false) === 2 && MX.appDefaultDpr(1, false) === 1);
check('app default dpr: mobile capped at 1.5', MX.appDefaultDpr(2.6, true) === 1.5);

const desk = MX.buildPlan({ mode: 'full', maxLevel: 4, defaultLevel: 4, mobile: false, deviceDpr: 1 });
check('desktop: base build is the default level (ultra)', desk.builds[0].id === 'base' && desk.builds[0].level === 4);
check('desktop: every stage dpr <= device dpr', desk.builds.every(b => b.stages.every(s => s.dpr <= 1)));
const baseIds = desk.builds[0].stages.map(s => s.id);
['baseline', 'motion-idle', 'motion-orbit-slow', 'motion-orbit-fast', 'motion-pan', 'motion-zoom', 'motion-swipe-burst',
  'lights+10', 'lights+25', 'lights+50', 'furniture-none', 'sustained'].forEach(id =>
  check('full base build has ' + id, baseIds.indexOf(id) !== -1, baseIds));
check('sustained is 60 s in full', desk.builds[0].stages.find(s => s.id === 'sustained').measureMs === 60000);
// Dedupe by what a level builds: under shadows=auto every rung builds something different.
const distinct = new Set([0, 1, 2, 3, 4].map(l => JSON.stringify(AQ.levelConfig(l, { maxLevel: 4, mobile: false, shadows: 'auto' }))));
check('desktop: one build per distinct level config', desk.builds.filter(b => b.id === 'base' || b.id.startsWith('level-')).length === distinct.size,
  desk.builds.map(b => b.id));
check('no two builds build the same thing', new Set(desk.builds.map(b => JSON.stringify(b.config) + b.shadows)).size === desk.builds.length);
check('shadow-off build present', desk.builds.some(b => b.id === 'shadows-off'));
check('full plan estimate is 4-8 minutes', desk.estimatedMs > 240000 && desk.estimatedMs < 480000, desk.estimatedMs);

const tab = MX.buildPlan({ mode: 'full', maxLevel: 4, defaultLevel: AQ.defaultLevel(true, 4), mobile: true, deviceDpr: 2.25 });
check('mobile: base build is mid-lite', tab.builds[0].levelName === 'mid-lite', tab.builds[0].levelName);
check('mobile: default dpr 1.5, interaction dpr 1', tab.defaultDpr === 1.5 && tab.interactionDpr === 1);
check('mobile: motion stages at the interaction ratio',
  tab.builds[0].stages.filter(s => s.group === 'motion').every(s => s.dpr === 1));
check('mobile: grid includes device max ratio', tab.builds.some(b => b.stages.some(s => s.grid && s.dpr === 2.25)));
check('mobile: levels up to ultra are measured', tab.builds.some(b => b.levelName === 'ultra'));

const low = MX.buildPlan({ mode: 'full', maxLevel: 0, defaultLevel: 0, mobile: false, deviceDpr: 1 });
check('low-only GPU: no level builds beyond low', low.builds.filter(b => b.id !== 'strip').every(b => b.level === 0));

const quick = MX.buildPlan({ mode: 'quick', maxLevel: 4, defaultLevel: 1, mobile: true, deviceDpr: 2 });
const quickIds = quick.builds.flatMap(b => b.stages.map(s => s.id));
check('quick has a sustained stage of 10 s', quick.builds[0].stages.find(s => s.id === 'sustained').measureMs === 10000);
check('quick has no +50 lights', quickIds.indexOf('lights+50') === -1);
check('quick measures the top level', quick.builds.some(b => b.level === 4));
check('quick is ~2-3 minutes (light recompiles dominate)', quick.estimatedMs > 60000 && quick.estimatedMs < 200000, quick.estimatedMs);
check('quick stages are a subset of full stage ids (same device)', (() => {
  const full = MX.buildPlan({ mode: 'full', maxLevel: 4, defaultLevel: 1, mobile: true, deviceDpr: 2 });
  const fullIds = new Set(full.builds.flatMap(b => b.stages.map(s => s.id)));
  return quickIds.every(id => fullIds.has(id));
})());
// Binding addition #1: the base build is the level the device RUNS (stored), every rung is measured.
const stored0 = MX.buildPlan({ mode: 'full', maxLevel: 4, currentLevel: 0, currentDpr: 1.25, mobile: true, deviceDpr: 2.25 });
check('stored level: base build is the stored level (low)', stored0.builds[0].levelName === 'low' && stored0.currentLevel === 0);
check('stored level: every compiling rung is measured', [0, 1, 2, 3, 4].every(l => stored0.builds.some(b => b.level === l)),
  stored0.builds.map(b => b.id));
check('stored settled ratio joins the ratio list', stored0.dprs.indexOf(1.25) !== -1 && stored0.currentDpr === 1.25, stored0.dprs);
check('every rung at every ratio (full)', stored0.builds.filter(b => b.id.startsWith('level-')).every(b => b.stages.length === stored0.dprs.length));
check('level builds carry the furniture detail they build', stored0.builds[0].config.furnitureDetail === 'low' &&
  stored0.builds.find(b => b.levelName === 'mid').config.furnitureDetail === 'full');
const quickAll = MX.buildPlan({ mode: 'quick', maxLevel: 4, currentLevel: 0, mobile: true, deviceDpr: 2 });
check('quick still measures every rung', [1, 2, 3, 4].every(l => quickAll.builds.some(b => b.level === l)), quickAll.builds.map(b => b.id));
const lowMode = MX.buildPlan({ mode: 'full', maxLevel: 4, currentLevel: 4, mobile: false, deviceDpr: 1, shadows: 'low' });
check('shadows=low: ultra-lite dedupes into ultra (same build)', !lowMode.builds.some(b => b.levelName === 'ultra-lite'), lowMode.builds.map(b => b.id));
check('shadows=low: every level build uses low', lowMode.builds.filter(b => b.id.startsWith('level-') || b.id === 'base').every(b => b.shadows === 'low'));
check('shadows=low: the shadow variants are the other two modes', lowMode.builds.filter(b => b.id.startsWith('shadows-')).every(b => b.shadows !== 'low'));
// Binding addition #2: the strip group.
const strip = desk.builds.find(b => b.id === 'strip');
check('strip build present, level chosen at run time', strip && strip.level === null && strip.dynamic === 'recommended');
check('strip stages: ref, A13, B13x3, B13x6, C13, C25', strip.stages.map(s => s.id).join() === 'strip-0,strip-A13,strip-B13x3,strip-B13x6,strip-C13,strip-C25',
  strip.stages.map(s => s.id));
check('strip B x6 is 78 dim points; C is RectAreaLights', strip.stages.find(s => s.id === 'strip-B13x6').strip.perStrip === 6 &&
  strip.stages.find(s => s.id === 'strip-C25').strip.kind === 'rect');
check('quick strip group is ref/A/Bx3/C13', quick.builds.find(b => b.id === 'strip').stages.map(s => s.id).join() === 'strip-0,strip-A13,strip-B13x3,strip-C13');
const desc = MX.describePlan(desk);
check('describePlan lists every build and stage id', desc.builds.length === desk.builds.length && desc.stageCount === desk.stageCount);

// ---- 2. the verdict -----------------------------------------------------------
function st(o) {
  return Object.assign({ id: o.id || ('s' + Math.random()), build: 'base', group: 'grid', grid: true, level: 2, levelName: 'mid',
    shadows: 'auto', dpr: 1, lightsAdded: 0, furniture: true, valid: true, gpu: null, cpu: null }, o,
  { frames: Object.assign({ p95Ms: 16.7, pctOver50: 0, meanMs: 16.7 }, o.frames || {}) });
}
check('holds: p95 33.4 and 2% ok', V.holds(st({ frames: { p95Ms: 33.4, pctOver50: 2 } })));
check('holds: p95 33.5 fails', !V.holds(st({ frames: { p95Ms: 33.5, pctOver50: 0 } })));
check('holds: good p95 but 2.1% >50 ms fails', !V.holds(st({ frames: { p95Ms: 20, pctOver50: 2.1 } })));
check('holds: invalid stage never holds', !V.holds(st({ valid: false })));

const plan = { defaultLevel: 1, defaultDpr: 1.5 };
// raise: default holds and a higher level holds
let v = V.computeVerdict([
  st({ id: 'a', level: 1, levelName: 'mid-lite', dpr: 1.5, frames: { p95Ms: 18 } }),
  st({ id: 'b', level: 2, levelName: 'mid', dpr: 1.5, frames: { p95Ms: 25 } }),
  st({ id: 'c', level: 4, levelName: 'ultra', dpr: 1.5, frames: { p95Ms: 60, pctOver50: 30 } })
], plan);
check('raise: recommendation', v.recommendation === 'raise', v);
check('raise: best is mid @1.5', v.best && v.best.stage === 'b', v.best);
check('raise: frame-basis headroom 46% for 18 ms', v.current.headroomPct === 46, v.current);
check('raise: summary names the current and the target', /mid-lite @1\.5/.test(v.summary) && /highest sustainable: mid @1\.5/.test(v.summary), v.summary);

// reduce: default fails, lower holds
v = V.computeVerdict([
  st({ id: 'a', level: 1, levelName: 'mid-lite', dpr: 1.5, frames: { p95Ms: 45 } }),
  st({ id: 'b', level: 1, levelName: 'mid-lite', dpr: 1, frames: { p95Ms: 30 } }),
  st({ id: 'c', level: 0, levelName: 'low', dpr: 1.5, frames: { p95Ms: 20 } })
], plan);
check('reduce: recommendation', v.recommendation === 'reduce', v);
check('reduce: level outranks ratio (mid-lite @1 over low @1.5)', v.best.stage === 'b', v.best);

// keep
v = V.computeVerdict([st({ id: 'a', level: 1, levelName: 'mid-lite', dpr: 1.5, frames: { p95Ms: 20 } }),
  st({ id: 'b', level: 2, levelName: 'mid', dpr: 1.5, frames: { p95Ms: 50 } })], plan);
check('keep: recommendation', v.recommendation === 'keep', v);

// invalid best candidate is ignored
v = V.computeVerdict([st({ id: 'a', level: 1, levelName: 'mid-lite', dpr: 1.5, frames: { p95Ms: 20 } }),
  st({ id: 'b', level: 4, levelName: 'ultra', dpr: 1.5, frames: { p95Ms: 10 }, valid: false, invalidReason: 'hidden' })], plan);
check('invalid stage is never the best', v.recommendation === 'keep' && v.best.stage === 'a', v);

// non-grid stages (lights, furniture off) never compete
v = V.computeVerdict([st({ id: 'a', level: 1, levelName: 'mid-lite', dpr: 1.5, frames: { p95Ms: 20 } }),
  st({ id: 'x', level: 4, levelName: 'ultra', dpr: 1.5, furniture: false, frames: { p95Ms: 10 } }),
  st({ id: 'y', level: 4, levelName: 'ultra', dpr: 1.5, shadows: 'off', frames: { p95Ms: 10 } })], plan);
check('furniture-off and shadows-off stages do not count as settings', v.best.stage === 'a', v.best);

// default missing / invalid
check('no default stage -> unknown', V.computeVerdict([], plan).recommendation === 'unknown');
check('invalid default -> unknown', V.computeVerdict([st({ level: 1, dpr: 1.5, valid: false })], plan).recommendation === 'unknown');

// GPU basis
v = V.computeVerdict([st({ id: 'a', level: 1, levelName: 'mid-lite', dpr: 1.5, frames: { p95Ms: 16.7 },
  gpu: { p95Ms: 6.68 }, cpu: { p95Ms: 3 } })], plan);
check('gpu basis used when present', v.basis === 'gpu' && v.current.headroomPct === 80, v.current);
v = V.computeVerdict([st({ id: 'a', level: 1, levelName: 'mid-lite', dpr: 1.5, frames: { p95Ms: 16.7 },
  gpu: { p95Ms: 2 }, cpu: { p95Ms: 10.02 } })], plan);
check('gpu basis takes the larger of gpu and cpu', v.current.costMs === 10, v.current);

// per-light cost and first failing count
v = V.computeVerdict([
  st({ id: 'baseline', group: 'baseline', level: 1, levelName: 'mid-lite', dpr: 1.5, lightsAdded: 0, frames: { p95Ms: 17, meanMs: 16.7 }, gpu: { meanMs: 5, p95Ms: 6 } }),
  st({ id: 'l10', group: 'lights', grid: false, level: 1, dpr: 1.5, lightsAdded: 10, frames: { p95Ms: 17, meanMs: 16.7 }, gpu: { meanMs: 7, p95Ms: 8 } }),
  st({ id: 'l25', group: 'lights', grid: false, level: 1, dpr: 1.5, lightsAdded: 25, frames: { p95Ms: 25, meanMs: 20 }, gpu: { meanMs: 10, p95Ms: 11 } }),
  st({ id: 'l50', group: 'lights', grid: false, level: 1, dpr: 1.5, lightsAdded: 50, frames: { p95Ms: 40, meanMs: 33 }, gpu: { meanMs: 15, p95Ms: 16 } })
], plan);
check('per-light GPU slope is 0.2 ms', v.perLightMs && Math.abs(v.perLightMs.gpu - 0.2) < 1e-9, v.perLightMs);
check('first failing light count is 50', v.perLightMs.firstFailingLights === 50, v.perLightMs);

// thermal
v = V.computeVerdict([st({ id: 'a', level: 1, dpr: 1.5 }),
  st({ id: 'sus', group: 'sustained', grid: false, level: 1, dpr: 1.5, drift: { driftPct: 22 } })], plan);
check('thermal drift over 15% flags throttling', v.thermal && v.thermal.throttlingSuspected === true, v.thermal);

// levels, furniture and strip lines (binding additions)
const cfgOf = (tier, drop) => ({ tier, furnitureDetail: tier === 'low' ? 'low' : 'full', dropMinorFurniture: drop });
const plan0 = { currentLevel: 0, currentDpr: 1.5, currentLevelFrom: 'stored' };
v = V.computeVerdict([
  st({ id: 'l0a', level: 0, levelName: 'low', dpr: 1, config: cfgOf('low', true), frames: { p95Ms: 10 } }),
  st({ id: 'l0b', level: 0, levelName: 'low', dpr: 1.5, config: cfgOf('low', true), frames: { p95Ms: 12 } }),
  st({ id: 'l2a', level: 2, levelName: 'mid', dpr: 1, config: cfgOf('mid', false), frames: { p95Ms: 20 } }),
  st({ id: 'l2b', level: 2, levelName: 'mid', dpr: 1.5, config: cfgOf('mid', false), frames: { p95Ms: 40 } }),
  st({ id: 'l4a', level: 4, levelName: 'ultra', dpr: 1, config: cfgOf('ultra', false), frames: { p95Ms: 90, pctOver50: 60 } })
], plan0);
check('verdict names the stored current level', v.current.levelName === 'low' && v.current.levelFrom === 'stored' && /(stored)/.test(v.summary), v.summary);
check('verdict: highest sustainable is mid @1', v.best.stage === 'l2a' && v.recommendedLevel === 2, v.best);
check('levels: mid holds up to DPR 1 only', v.levels.find(L => L.level === 2).holdsAtDpr === 1);
check('levels: ultra misses at every ratio', v.levels.find(L => L.level === 4).holdsAtDpr === null && /misses the target/.test(v.levelLines.find(l => /ultra/.test(l))));
check('furniture: current is low detail, full detail affordable', v.furniture.currentDetail === 'low' && v.furniture.fullDetailAffordable === true &&
  v.furniture.allItemsFullDetailAffordable === true, v.furniture);
v = V.computeVerdict([st({ id: 'l0', level: 0, levelName: 'low', dpr: 1.5, config: cfgOf('low', true), frames: { p95Ms: 10 } }),
  st({ id: 'l1', level: 1, levelName: 'mid-lite', dpr: 1.5, config: cfgOf('mid', true), frames: { p95Ms: 20 } }),
  st({ id: 'l2', level: 2, levelName: 'mid', dpr: 1.5, config: cfgOf('mid', false), frames: { p95Ms: 50 } })], plan0);
check('furniture: full detail yes, every item no (only mid-lite holds)', v.furniture.fullDetailAffordable === true && v.furniture.allItemsFullDetailAffordable === false, v.furniture);
const sv = (id, opt, kind, n, per, p95, extra) => st(Object.assign({ id, group: 'strip', grid: false, level: 2, levelName: 'mid', dpr: 1.5,
  lightsAdded: n * per, strip: { option: opt, kind, strips: n, perStrip: per, label: id }, frames: { p95Ms: p95 } }, extra || {}));
const sVerdict = V.stripVerdict([sv('ref', 'ref', null, 0, 0, 16.7), sv('A', 'A', 'point', 13, 1, 17.5),
  sv('B3', 'B', 'point', 13, 3, 30), sv('B6', 'B', 'point', 13, 6, 45),
  sv('C13', 'C', 'rect', 13, 1, 20), sv('C25', 'C', 'rect', 25, 1, 22, { compileFailed: true })]);
check('strip: delta p95 vs the reference', sVerdict.options.find(o => o.stage === 'A').deltaP95Ms === 0.8, sVerdict.options[0]);
check('strip: A tenable', sVerdict.tenable.A === true);
check('strip: B not tenable when x6 misses', sVerdict.tenable.B === false);
check('strip: a compile failure is NOT tenable even with good frames', sVerdict.options.find(o => o.stage === 'C25').tenable === false &&
  sVerdict.tenable.C === false && /DID NOT COMPILE/.test(sVerdict.lines.find(l => /C25/.test(l))));
check('strip lines name the level and ratio', /at mid @1.5/.test(sVerdict.lines[0]), sVerdict.lines[0]);
check('no strip stages -> null', V.stripVerdict([st({})]) === null);

// ---- 3. the document -----------------------------------------------------------
const house = { id: 'x', name: 'SECRET NAME', rooms: { a: { poly: [[1, 2]] }, b: {} }, walls: [1, 2, 3], doors: [1],
  windows: [], curtains: [1, 2], furniture: [1, 2, 3, 4], site: { latitude: 51.5, longitude: -0.1 } };
const stages = [st({ id: 'baseline', group: 'baseline', level: 1, levelName: 'mid-lite', dpr: 1.5, series: new Array(240).fill(16.7) })];
for (let i = 0; i < 40; i++) stages.push(st({ id: 'big' + i, grid: false, group: 'lights', series: new Array(240).fill(123.4) }));
const device = { webgl: { renderer: 'GPU X', extensions: new Array(40).fill('EXT_something_long_name') }, app: { tier: 'mid', compileTier: 'ultra', mobileGpu: true } };
const doc = R.assembleResult({ app: { version: '0.99.0', houseId: 'x', house },
  run: { mode: 'full', startedAt: '2026-01-01T00:00:00.000Z', aborted: false }, device,
  matrix: { defaultLevelName: 'mid-lite', defaultDpr: 1.5 }, plan, builds: [], stages });
check('schema id and version', doc.schema === 'home3d-diagnostics' && doc.schemaVersion === 1);
check('summary is the first content key after the schema', Object.keys(doc).indexOf('summary') === 2, Object.keys(doc));
check('summary is non-empty lines', Array.isArray(doc.summary) && doc.summary.length >= 2 && doc.summary.every(l => typeof l === 'string'));
const text = JSON.stringify(doc);
check('house NAME never in the document', text.indexOf('SECRET NAME') === -1);
check('house coordinates never in the document', text.indexOf('51.5') === -1 && text.indexOf('latitude') === -1);
check('house counts are there', doc.app.house.rooms === 2 && doc.app.house.walls === 3 && doc.app.house.furnitureItems === 4, doc.app.house);
check('run carries stage counts', doc.run.stagesRun === 41 && doc.run.stagesInvalid === 0);
const before = R.byteSize(doc);
R.fitToSize(doc, 20000);
check('fitToSize shrinks the document', R.byteSize(doc) < before);
check('fitToSize drops series before anything else', doc.trimmed.length > 0 && doc.trimmed[0].startsWith('stages.'), doc.trimmed);
check('fitToSize keeps every stage summary', doc.stages.length === 41 && doc.stages.every(s => s.frames));
check('fitToSize under the default cap is a no-op', (() => {
  const d2 = R.assembleResult({ app: { version: '1', houseId: 'x', house }, run: { mode: 'quick', startedAt: 'now' }, device: {},
    matrix: {}, plan, builds: [], stages: [st({ id: 'q', series: [1, 2] })] });
  R.fitToSize(d2); return d2.trimmed.length === 0 && d2.stages[0].series.length === 2;
})());

// ---- 4. scene hooks are inert by default ---------------------------------------
const scene = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
check('scene: pixel-ratio pin starts null', /let diagPixelRatio = null;/.test(scene));
check('scene: continuous starts false', /let diagContinuous = false;/.test(scene));
check('scene: level pin only behind Number.isInteger(opts.level)', /const levelPinned = !tierInfo\.overridden && Number\.isInteger\(opts\.level\);/.test(scene));
check('scene: resolver returns the pin only when set', /if \(diagPixelRatio != null\) return diagPixelRatio;/.test(scene));
check('scene: the on-demand gate only changes when continuous is on', /!transitionsActive && !diagContinuous\)/.test(scene));
check('scene: diagPixelRatio is only assigned in the diagnostics API and its declaration',
  (scene.match(/diagPixelRatio =/g) || []).length === 2, (scene.match(/diagPixelRatio =/g) || []).length);
check('scene: diagContinuous is only assigned in the diagnostics API and its declaration',
  (scene.match(/diagContinuous =/g) || []).length === 2);

console.log(`test-diagnostics-verdict: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
