#!/usr/bin/env node
/**
 * The profile's `camera` block (src/camera-config.js) -- `node scripts/test-camera-config.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. No block == today: the resolved defaults are the engine's own numbers,
 *      and every walk / glide / preview pose on the demo house is identical
 *      with and without the default options threaded through.
 *   2. Each key does what it says: a walk key changes the plan the way its
 *      name says (double the speed -> a shorter straight hop, a lower turn cap
 *      -> a slower sharp turn...), a preview key changes the orbit.
 *   3. Clamping / fallback: a non-number or out-of-range value warns ONCE and
 *      uses the default; nothing throws; unknown keys warn.
 *   4. URL > profile > default for the preview speed (?rotateSpeed=0 freezes).
 *   5. Wiring: the loader resolves the block onto the compiled house, the
 *      scene hands the config to planWalk / planGlide / outsideView /
 *      sharedVantage / previewPose and the flight durations, index.html
 *      resolves the preview speed through previewRotateSpeed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const section = s => console.log('\n' + s);

const C = await imp('src/camera-config.js');
const W = await imp('src/doorway-walk.js');
const F = await imp('src/camera-focus.js');
const P = await imp('src/preview-orbit.js');
const { HouseLoader } = await imp('src/house-loader.js');

const resolve = raw => { const w = []; const cfg = C.resolveCameraConfig(raw, m => w.push(m)); return { cfg, w }; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- The demo house, compiled by the real loader -----------------------------
const demoGeo = JSON.parse(read('houses/demo/geometry.json'));
const demo = HouseLoader.compile(demoGeo, '');
const inputs = W.navInputsFromHouse(demo);
const graph = W.buildNavGraph(inputs);
const poses = {};
for (const id of Object.keys(inputs.rooms)) {
  const r = F.chooseInRoomView({ poly: inputs.rooms[id], ceiling: inputs.ceiling, items: [], aspect: 1.6 });
  if (r.pose) poses[id] = r.pose;
  else { const o = W.outsideView(graph, id); if (o) poses[id] = o.pose; }
}
const ids = Object.keys(poses);
const roomOf = pose => { const e = F.eyeOf(pose); return W.roomAt(graph.rooms, e[0], e[2]); };
const walk = (a, b, cfg) => W.planWalk(graph, poses[a], roomOf(poses[a]), poses[b], roomOf(poses[b]), cfg ? { options: C.walkOptions(cfg) } : undefined);
const sampleAt = (plan, n = 40) => Array.from({ length: n + 1 }, (_, i) => plan.at(plan.ease(i / n)));
const cfgOf = raw => resolve(raw).cfg;

// ---- 1. No block == today ----------------------------------------------------
section('defaults are the engine\'s own');
{
  const d = C.DEFAULT_CAMERA, o = C.walkOptions(d);
  const merged = Object.assign({}, W.WALK, o);
  check('walkOptions(default) leaves every WALK value it touches unchanged',
    ['walkSpeed', 'accel', 'maxYawRate', 'minMs', 'maxMs', 'turnMinMs', 'lookChord', 'travelPitchDeg', 'eyeY'].every(k => merged[k] === W.WALK[k]),
    Object.keys(o).filter(k => o[k] !== W.WALK[k]));
  check('preview defaults are preview-orbit.js\'s constants',
    d.preview.topHoldLaps === P.TOP_HOLD_LAPS && d.preview.descentLaps === P.DESCENT_LAPS && d.preview.eyeLevelLaps === P.LOW_HOLD_LAPS &&
    d.preview.ascentLaps === P.ASCENT_LAPS && d.preview.eyeHeightM === P.EYE_HEIGHT_M &&
    d.preview.eyeLevelDistanceFactor === P.EYE_LEVEL_DISTANCE_FACTOR && d.preview.eyeLevelExtraM === P.EYE_LEVEL_EXTRA_M);
  check('rotate default is 2*pi/120 exactly, flights 1200 / 700 ms', C.previewRotateSpeed(null, d) === (Math.PI * 2) / 120 && d.flight.homeToRoomMs === 1200 && d.flight.betweenOutsideViewsMs === 700);
  check('shared spot defaults: on, 0.75 coverage, 1 m', same(C.sharedSpotOptions(d), { ratio: 0.75, reach: 1 }));
  check('an empty block, {} sections and no block all resolve identically',
    same(cfgOf(undefined), cfgOf({})) && same(cfgOf({}), cfgOf({ walk: {}, preview: {}, flight: {}, })) && same(cfgOf(undefined), d));
  check('the compiled demo carries the default config (no block in the profile)', demo.camera && same(demo.camera, d));

  let n = 0, planned = 0;
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const p0 = walk(a, b), p1 = walk(a, b, d);
    if (!p0 && !p1) continue;
    planned++;
    if (same({ ms: p0.ms, len: p0.length, wp: p0.waypoints, portals: p0.portals, s: sampleAt(p0) }, { ms: p1.ms, len: p1.length, wp: p1.waypoints, portals: p1.portals, s: sampleAt(p1) })) n++;
  }
  check('every demo walk is identical with the default options threaded through (' + planned + ' walks)', planned >= 20 && n === planned, { planned, n });
  const g0 = W.planGlide(poses[ids[0]], poses[ids[1]]), g1 = W.planGlide(poses[ids[0]], poses[ids[1]], { options: C.walkOptions(d) });
  check('... and a glide', g0.ms === g1.ms && same(sampleAt(g0), sampleAt(g1)));
  const geom = { rotateSpeed: 0.0524, th0: 0.7, rTop: 20, phTop: 1, halfDiag: 7, midY: 1.25, still: false };
  let diff = 0;
  for (let t = 0; t < 1500; t += 7.3) if (!same(P.previewPose(t, geom), P.previewPose(t, Object.assign({}, geom, C.previewOptions(d))))) diff++;
  check('preview poses are identical with the default options threaded through', diff === 0, diff);
}

// ---- 2. Each key does what its name says -------------------------------------
section('walk keys');
// A long straight glide in one room, same look both ends: timing is all speed + ramps.
const eyeA = [0, 1.5, 0], eyeB = [8, 1.5, 0];
const flat = (eye, yaw) => F.poseFromLook(eye, yaw, 0, 3, 50);
const straight = raw => W.planGlide(flat(eyeA, 0), flat(eyeB, 0), { options: C.walkOptions(cfgOf(raw)) });
const base = straight(undefined);
{
  const fast = straight({ walk: { speedMps: 11 } }), slow = straight({ walk: { speedMps: 2.75 } });
  const L = 8, ramp = base.ms / 1000 - L / 5.5;
  // Between the ramps it moves at exactly V: the time over the 8 m beyond the ramps halves.
  check('speedMps: double the speed halves the straight run (' + base.ms + ' ms -> ' + fast.ms + ' ms)', Math.abs((fast.ms / 1000 - ramp) - (base.ms / 1000 - ramp) / 2) < 0.06, { base: base.ms, fast: fast.ms });
  check('speedMps: half the speed is much slower', slow.ms > base.ms * 1.5, { base: base.ms, slow: slow.ms });
  const soft = straight({ walk: { easeSec: 0.6 } }), crisp = straight({ walk: { easeSec: 0.05 } });
  check('easeSec: a longer ease is a slower hop, a shorter one quicker', soft.ms > base.ms + 150 && crisp.ms < base.ms - 40, { soft: soft.ms, base: base.ms, crisp: crisp.ms });
  const tiny = raw => W.planGlide(flat([0, 1.5, 0], 0), flat([0.3, 1.5, 0], 0), { options: C.walkOptions(cfgOf(raw)) });
  check('minMoveMs: the quickest hop is exactly that (330 default)', tiny(undefined).ms === 330 && tiny({ walk: { minMoveMs: 800 } }).ms === 800 && tiny({ walk: { minMoveMs: 100 } }).ms < 330);
  const longHop = raw => W.planGlide(flat([0, 1.5, 0], 0), flat([30, 1.5, 0], 0), { options: C.walkOptions(cfgOf(raw)) });
  check('maxMoveMs: the default cap holds a very long walk near 3 s; a bigger cap lets it take longer',
    longHop(undefined).ms < 3200 && longHop({ walk: { maxMoveMs: 20000 } }).ms > longHop(undefined).ms + 500, [longHop(undefined).ms, longHop({ walk: { maxMoveMs: 20000 } }).ms]);
  const spin = (raw, deg) => W.planGlide(flat(eyeA, 0), flat(eyeA, deg * Math.PI / 180), { options: C.walkOptions(cfgOf(raw)) });
  check('maxTurnDegPerSec: a half turn on the spot takes longer under a lower cap', spin({ walk: { maxTurnDegPerSec: 100 } }, 150).ms > spin(undefined, 150).ms * 3 &&
    spin({ walk: { maxTurnDegPerSec: 1500 } }, 150).ms < spin(undefined, 150).ms, [spin(undefined, 150).ms, spin({ walk: { maxTurnDegPerSec: 100 } }, 150).ms]);
  check('minTurnMs: the quickest turn on the spot (300 default)', spin(undefined, 5).ms === 300 && spin({ walk: { minTurnMs: 900 } }, 5).ms === 900);
  // Through doorways: eye height, look-ahead, pitch.
  const hop = ids.flatMap(a => ids.map(b => [a, b])).find(([a, b]) => a !== b && walk(a, b) && walk(a, b).portals.length >= 1);
  const wd = walk(hop[0], hop[1]), wl = walk(hop[0], hop[1], cfgOf({ walk: { eyeHeightM: 1.2 } }));
  const midY = pl => pl.path[Math.floor(pl.path.length / 2)][1];
  check('eyeHeightM: the eye through a doorway is that high (1.6 -> 1.2)', Math.abs(Math.max(...wd.path.map(p => p[1])) - Math.max(1.6, wd.path[0][1])) < 0.3 &&
    Math.abs(midY(wl) - 1.2) < 0.05 && Math.abs(midY(wd) - 1.6) < 0.05, [midY(wd), midY(wl)]);
  const pitchAt = (pl, f) => W.lookOf(pl.at(pl.ease(f))).pitch;
  const wp = walk(hop[0], hop[1], cfgOf({ walk: { lookDownDeg: 25 } }));
  const maxDiff = Math.max(...Array.from({ length: 21 }, (_, i) => Math.abs(pitchAt(wp, i / 20) - pitchAt(wd, i / 20))));
  check('lookDownDeg: a bigger tilt changes the pitch while walking', maxDiff > 5 * Math.PI / 180, maxDiff);
  const wk = walk(hop[0], hop[1], cfgOf({ walk: { lookAheadM: 5 } }));
  const yawDiff = Math.max(...Array.from({ length: 41 }, (_, i) => Math.abs(F.shortestArc(W.lookOf(wk.at(wk.ease(i / 40))).yaw, W.lookOf(wd.at(wd.ease(i / 40))).yaw))));
  check('lookAheadM: a longer look-ahead changes where the view points along the walk', yawDiff > 1 * Math.PI / 180, yawDiff);
  check('speedMps on a real walk: faster speed shortens it, same route', walk(hop[0], hop[1], cfgOf({ walk: { speedMps: 11 } })).ms < wd.ms && same(walk(hop[0], hop[1], cfgOf({ walk: { speedMps: 11 } })).portals, wd.portals));
  // sharedSpot
  check('sharedSpot: minCoverage / maxDistM map to sharedVantage ratio / reach; enabled:false -> null',
    same(C.sharedSpotOptions(cfgOf({ walk: { sharedSpot: { minCoverage: 0.9, maxDistM: 2 } } })), { ratio: 0.9, reach: 2 }) &&
    C.sharedSpotOptions(cfgOf({ walk: { sharedSpot: { enabled: false } } })) === null);
}

section('preview keys');
{
  const g = { rotateSpeed: 0.0524, th0: 0.7, rTop: 20, phTop: 1, halfDiag: 7, midY: 1.25, still: false };
  const lap = 2 * Math.PI / g.rotateSpeed;
  const at = (laps, raw) => P.previewPose(laps * lap, Object.assign({}, g, C.previewOptions(cfgOf(raw))));
  const topY = at(0).camY;
  check('topHoldLaps: the hold at the top lasts that many laps (2 -> still on top at 1.9 laps, descending by 2.2)',
    Math.abs(at(1.9, { preview: { topHoldLaps: 2 } }).camY - topY) < 1e-9 && at(2.2, { preview: { topHoldLaps: 2 } }).camY < topY - 0.1 && at(1.2).camY < topY - 0.1);
  check('descentLaps: 0.4 lap by default is at eye level by 1.4; at 1.0 it is still descending at 1.4',
    Math.abs(at(1.4).camY - 1.7) < 1e-9 && at(1.4, { preview: { descentLaps: 1 } }).camY > 3);
  check('eyeLevelLaps: 0 -> straight back up after the descent', Math.abs(at(1.4 + 0.1, { preview: { eyeLevelLaps: 0 } }).camY - 1.7) > 0.05 && Math.abs(at(1.4 + 0.5, { preview: { eyeLevelLaps: 3 } }).camY - 1.7) < 1e-9);
  check('ascentLaps: slower climb is still low where the default has risen', at(2.4 + 1 / 6, { preview: { ascentLaps: 2 } }).camY < at(2.4 + 1 / 6).camY - 0.1);
  check('eyeHeightM: eye level is that high', Math.abs(at(2, { preview: { eyeHeightM: 2.2 } }).camY - 2.2) < 1e-9);
  check('eyeLevelDistanceFactor / eyeLevelExtraM: set the stand-off, and it stays outside the footprint',
    at(2, { preview: { eyeLevelDistanceFactor: 3 } }).horiz > at(2).horiz + 5 && Math.abs(at(2, { preview: { eyeLevelExtraM: 10 } }).horiz - (at(2).horiz + 7)) < 1e-9 &&
    at(2, { preview: { eyeLevelDistanceFactor: 1.05, eyeLevelExtraM: 0 } }).horiz > g.halfDiag);
  check('rotateSecPerLap: profile sets the speed', Math.abs(C.previewRotateSpeed(null, cfgOf({ preview: { rotateSecPerLap: 60 } })) - 2 * Math.PI / 60) < 1e-12);
}

section('flight durations');
{
  const f = cfgOf({ flight: { homeToRoomMs: 2000, betweenOutsideViewsMs: 300 } }).flight;
  check('flight keys resolve', f.homeToRoomMs === 2000 && f.betweenOutsideViewsMs === 300);
}

// ---- 3. Clamping and fallback ----------------------------------------------------
section('clamping and fallback');
{
  const bad = [
    ['walk', 'speedMps', 'fast'], ['walk', 'speedMps', 0], ['walk', 'speedMps', 1000], ['walk', 'speedMps', -3], ['walk', 'speedMps', null],
    ['walk', 'speedMps', Infinity], ['walk', 'speedMps', NaN], ['walk', 'speedMps', '5.5'], ['walk', 'speedMps', [5]], ['walk', 'speedMps', true],
    ['walk', 'easeSec', 9], ['walk', 'maxTurnDegPerSec', 1], ['walk', 'eyeHeightM', 9], ['preview', 'rotateSecPerLap', 0], ['preview', 'descentLaps', 0],
    ['preview', 'eyeLevelDistanceFactor', 0.5], ['flight', 'homeToRoomMs', 5], ['flight', 'homeToRoomMs', 1e9],
  ];
  for (const [sec, k, v] of bad) {
    const { cfg, w } = resolve({ [sec]: { [k]: v } });
    check(`${sec}.${k} = ${String(v)} -> default, exactly one warning`, cfg[sec][k] === C.DEFAULT_CAMERA[sec][k] && w.length === 1 && w[0].includes(sec + '.' + k), w);
  }
  const edges = resolve({ walk: { speedMps: 0.5, maxTurnDegPerSec: 2000 }, preview: { rotateSecPerLap: 3600 }, flight: { homeToRoomMs: 100 } });
  check('values exactly on the range ends are accepted', edges.w.length === 0 && edges.cfg.walk.speedMps === 0.5 && edges.cfg.preview.rotateSecPerLap === 3600 && edges.cfg.flight.homeToRoomMs === 100, edges.w);
  const mixed = resolve({ walk: { speedMps: 3, easeSec: 'x' } });
  check('one bad key does not drop its good neighbour', mixed.cfg.walk.speedMps === 3 && mixed.cfg.walk.easeSec === C.DEFAULT_CAMERA.walk.easeSec && mixed.w.length === 1);
  for (const raw of ['str', 5, [], [1, 2], true, null]) {
    const { cfg, w } = resolve(raw);
    if (raw === null) check('camera: null -> a warning and the defaults', same(cfg, C.DEFAULT_CAMERA) && w.length === 1, w);
    else check('camera: ' + JSON.stringify(raw) + ' -> ignored with one warning', same(cfg, C.DEFAULT_CAMERA) && w.length === 1, w);
  }
  const sec = resolve({ walk: 'quick', preview: [1], flight: 3 });
  check('a section that is not an object -> defaults, one warning each', same(sec.cfg, C.DEFAULT_CAMERA) && sec.w.length === 3, sec.w);
  const unk = resolve({ walk: { warp: 9 }, sharedSpot: {}, extra: 1 });
  check('unknown keys warn and change nothing', same(unk.cfg, C.DEFAULT_CAMERA) && unk.w.length === 3, unk.w);
  const mm = resolve({ walk: { minMoveMs: 2000, maxMoveMs: 1000 } });
  check('maxMoveMs below minMoveMs -> minMoveMs, one warning', mm.cfg.walk.maxMoveMs === 2000 && mm.w.length === 1, mm.w);
  const en = resolve({ walk: { sharedSpot: { enabled: 'no', minCoverage: 2 } } });
  check('sharedSpot: a non-boolean enabled and an out-of-range coverage fall back', en.cfg.walk.sharedSpot.enabled === true && en.cfg.walk.sharedSpot.minCoverage === 0.75 && en.w.length === 2, en.w);
  const off = resolve({ walk: { sharedSpot: { enabled: false } } });
  check('sharedSpot.enabled false is honoured', off.cfg.walk.sharedSpot.enabled === false && off.w.length === 0);
  check('the resolved config is frozen', Object.isFrozen(off.cfg) && Object.isFrozen(off.cfg.walk) && Object.isFrozen(off.cfg.walk.sharedSpot));
  let threw = false;
  try { C.resolveCameraConfig({ walk: { speedMps: {} }, preview: null }, () => { throw new Error('warn threw'); }); } catch { threw = true; }
  check('(sanity) a throwing warn callback is the caller\'s problem, not swallowed', threw);
  const origWarn = console.warn; let seen = 0; console.warn = () => { seen++; };
  try { C.resolveCameraConfig({ walk: { speedMps: 'x' } }); } finally { console.warn = origWarn; }
  check('with no callback a bad value is one console.warn', seen === 1, seen);
  // Through the real loader: warns land in house.warnings and the page still compiles.
  const geo = JSON.parse(JSON.stringify(demoGeo));
  geo.camera = { walk: { speedMps: 2.75, sharedSpot: { enabled: false } }, preview: { topHoldLaps: 'lots' }, flight: { homeToRoomMs: 2500 } };
  let h; console.warn = () => {};
  try { h = HouseLoader.compile(geo, ''); } finally { console.warn = origWarn; }
  check('loader: the block is resolved onto house.camera; a bad key warns into house.warnings and falls back',
    h.camera.walk.speedMps === 2.75 && h.camera.walk.sharedSpot.enabled === false && h.camera.preview.topHoldLaps === 1 && h.camera.flight.homeToRoomMs === 2500 &&
    h.warnings.filter(m => m.includes('camera.preview.topHoldLaps')).length === 1, h.warnings);
}

// ---- 4. URL precedence --------------------------------------------------------------
section('URL > profile > default');
{
  const prof = cfgOf({ preview: { rotateSecPerLap: 60 } });
  const t = (u, c) => C.previewRotateSpeed(u, c);
  check('no URL value: the profile', Math.abs(t(null, prof) - 2 * Math.PI / 60) < 1e-12);
  check('a URL value beats the profile', t('0.1047', prof) === 0.1047);
  check('?rotateSpeed=0 freezes, even with a profile lap', t('0', prof) === 0);
  check('a negative URL value spins the other way', t('-0.05', prof) === -0.05);
  check('an unparsable URL value falls through to the profile, then the default', Math.abs(t('abc', prof) - 2 * Math.PI / 60) < 1e-12 && t('', C.DEFAULT_CAMERA) === 2 * Math.PI / 120);
  check('neither: 2*pi/120', t(null, undefined) === 2 * Math.PI / 120);
  const g = Object.assign({ rotateSpeed: t('0', prof), th0: 0.7, rTop: 20, phTop: 1, halfDiag: 7, midY: 1.25 }, C.previewOptions(prof));
  check('frozen stays frozen: the pose is the top pose at the start azimuth whatever the profile says',
    [0, 100, 5000].every(s => { const p = P.previewPose(s, g); return p.th === 0.7 && Math.abs(p.camY - 20 * Math.cos(1)) < 1e-9; }));
}

// ---- 5. Wiring ----------------------------------------------------------------------
section('wiring');
{
  const scene = read('src/home3d-scene.js'), idx = read('index.html'), loader = read('src/house-loader.js');
  // The scene needs a browser to run, but it must at least PARSE (a stray global rename once broke `HOUSE.cameraPresets`).
  const tmp = path.join(os.tmpdir(), 'camcfg-scene-' + process.pid + '.mjs');
  fs.writeFileSync(tmp, scene);
  let parses = true, why = '';
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); } catch (e) { parses = false; why = String(e.stderr).split(String.fromCharCode(10)).slice(0, 4).join(' | '); }
  fs.rmSync(tmp, { force: true });
  check('scene: home3d-scene.js parses as a module', parses, why);
  check('scene: HOUSE.cameraPresets is still read as is', /Object\.keys\(HOUSE\.cameraPresets \|\| \{\}\)/.test(scene));
  check('loader resolves geo.camera and exposes it on the compiled house', /resolveCameraConfig\(geo\.camera, warn\)/.test(loader) && /camera: camera,/.test(loader));
  check('scene: planWalk gets the walk options', /planWalk\(navGraph\(\), from, ra, to, rb, \{ obstacles: walkObstacles\(\), options: walkOptions\(/.test(scene));
  check('scene: planGlide gets the walk options', /planGlide\(from, to, \{ options: walkOptions\(/.test(scene));
  check('scene: outsideView gets the walk options (eye height)', /outsideView\(navGraph\(\), id, Object\.assign\(\{ leaves, aspect: cam\.aspect \}, walkOptions\(/.test(scene));
  check('scene: sharedVantage gets ratio / reach, and is skipped when switched off', /ratio: spot\.ratio, reach: spot\.reach/.test(scene) && /if \(!spot\) return null;/.test(scene));
  check('scene: previewPose geometry carries the preview options', /\.\.\.previewOptions\(/.test(scene));
  check('scene: arc / outside flights take their durations from the config', /flight\.homeToRoomMs : [^;]*flight\.betweenOutsideViewsMs/.test(scene) && !/mode === 'arc' \? 1200/.test(scene));
  check('index.html: the preview speed goes through previewRotateSpeed(URL, house.camera)', /rotateSpeed: previewRotateSpeed\(params\.get\('rotateSpeed'\), house\.camera\)/.test(idx));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
