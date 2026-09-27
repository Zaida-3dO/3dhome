#!/usr/bin/env node
/**
 * The /diagnostics device block and page I/O (item 112ec00c):
 * src/diagnostics/device-info.js and page-io.js, driven with fake windows.
 * No framework, no install: `node scripts/test-diagnostics-device.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. The null rule: a browser with NONE of the optional APIs still yields
 *      every field, each null WITH a reason in nullReasons -- never omitted.
 *      An API that throws or rejects is null with the error as the reason.
 *   2. A browser with everything yields values, and no reasons for them.
 *   3. The app decision is the app's own (quality-tier + adaptive-quality):
 *      an Immortalis tablet is mobile, compiles ultra, defaults to mid-lite.
 *   4. The referrer is reduced to its origin; the path never leaks.
 *   5. Device identity: generated once and reused; storage that is missing
 *      or throws gives a stable-per-page id reported persistent:false.
 *   6. Copy: Clipboard API, then execCommand, then a failure that says why.
 *   7. Save: success returns the server's id; each refusal a readable error.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const D = await imp('src/diagnostics/device-info.js');
const IO = await imp('src/diagnostics/page-io.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// A fake WebGL2 context. `opts.debug`: expose WEBGL_debug_renderer_info.
function fakeGL(opts) {
  const P = { VERSION: 1, SHADING_LANGUAGE_VERSION: 2, VENDOR: 3, RENDERER: 4, UNMASKED_VENDOR_WEBGL: 5, UNMASKED_RENDERER_WEBGL: 6,
    MAX_FRAGMENT_UNIFORM_VECTORS: 7, MAX_TEXTURE_SIZE: 8, MAX_SAMPLES: 9, MAX_VIEWPORT_DIMS: 10, FRAGMENT_SHADER: 11, HIGH_FLOAT: 12 };
  const values = { 1: 'WebGL 2.0', 2: 'WebGL GLSL ES 3.00', 3: 'WebKit', 4: 'WebKit WebGL', 5: 'ARM', 6: opts.renderer,
    7: opts.maxFragU, 8: 8192, 9: 4, 10: new Int32Array([8192, 8192]) };
  return Object.assign({}, P, {
    getParameter: k => values[k],
    getExtension: n => (n === 'WEBGL_debug_renderer_info' ? (opts.debug ? { UNMASKED_VENDOR_WEBGL: 5, UNMASKED_RENDERER_WEBGL: 6 } : null)
      : n === 'EXT_disjoint_timer_query_webgl2' ? (opts.timer ? {} : null)
      : n === 'WEBGL_lose_context' ? { loseContext() {} } : null),
    getContextAttributes: () => ({ antialias: true }),
    getShaderPrecisionFormat: () => ({ precision: 23 }),
    getSupportedExtensions: () => ['OES_b', 'EXT_a']
  });
}
const TAB_UA = 'Mozilla/5.0 (Linux; Android 15; SM-X930) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// ---- 1. a bare browser: nothing optional ----------------------------------------
const bare = {
  navigator: { userAgent: 'Bare/1.0', platform: 'X', language: 'en', hardwareConcurrency: 4, maxTouchPoints: 0 },
  document: { createElement: () => ({ getContext: () => null }), referrer: '' },
  devicePixelRatio: 1, innerWidth: 800, innerHeight: 600, isSecureContext: false,
  location: { origin: 'http://localhost:8792' }
};
bare.self = bare; bare.top = bare;
const b = await D.collectDevice(bare);
const expectNull = ['userAgentData', 'userAgentDataHighEntropy', 'deviceMemoryGB', 'screen', 'orientation', 'colorGamut',
  'prefersReducedMotion', 'battery', 'network', 'memory', 'longTaskSupported', 'webgl', 'webgpu', 'app',
  'embedding.referrerOrigin', 'embedding.ancestorOrigins'];
expectNull.forEach(k => {
  const val = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), b);
  check('bare: ' + k + ' is null (present, not omitted)', val === null, val);
  check('bare: ' + k + ' has a reason', typeof b.nullReasons[k] === 'string' && b.nullReasons[k].length > 5, b.nullReasons[k]);
});
check('bare: every top-level field is present', ['userAgent', 'platform', 'hardwareConcurrency', 'deviceMemoryGB', 'screen',
  'devicePixelRatio', 'viewport', 'orientation', 'colorGamut', 'battery', 'network', 'webgl', 'webgpu', 'embedding', 'app',
  'refreshRateHz', 'nullReasons'].every(k => Object.prototype.hasOwnProperty.call(b, k)));
check('bare: not in an iframe', b.embedding.inIframe === false);
check('bare: every null in the document has a reason', (() => {
  const missing = [];
  (function walk(o, p) {
    if (o === null) { if (!(p in b.nullReasons)) missing.push(p); return; }
    if (typeof o !== 'object' || Array.isArray(o)) return;
    Object.keys(o).forEach(k => { if (k !== 'nullReasons') walk(o[k], p ? p + '.' + k : k); });
  })(b, '');
  return missing.length === 0 || (console.error('  nulls without a reason:', missing), false);
})());

// ---- throwing / rejecting APIs ----------------------------------------------------
const hostile = Object.assign({}, bare, {
  navigator: Object.defineProperty(Object.assign({}, bare.navigator, {
    getBattery: () => Promise.reject(new Error('NotAllowedError')),
    userAgentData: { brands: [], mobile: false, platform: 'X', getHighEntropyValues: () => Promise.reject(new Error('denied')) }
  }), 'deviceMemory', { get() { throw new Error('boom'); } }),
  matchMedia: () => { throw new Error('mm broke'); }
});
hostile.self = hostile; hostile.top = {};   // cross-origin top: an iframe
const h = await D.collectDevice(hostile);
check('rejecting Battery API -> null with the rejection', h.battery === null && /rejected: NotAllowedError/.test(h.nullReasons.battery), h.nullReasons.battery);
check('throwing getter -> null with the error', h.deviceMemoryGB === null && /threw: boom/.test(h.nullReasons.deviceMemoryGB), h.nullReasons.deviceMemoryGB);
check('rejecting high-entropy -> null with reason', h.userAgentDataHighEntropy === null && /denied/.test(h.nullReasons.userAgentDataHighEntropy));
check('throwing matchMedia -> null with reason', h.prefersReducedMotion === null && /mm broke/.test(h.nullReasons.prefersReducedMotion));
check('a different top window reads as an iframe', h.embedding.inIframe === true);

// ---- 2 & 3. a full browser: an Immortalis tablet ------------------------------------
const store = new Map();
const full = {
  navigator: { userAgent: TAB_UA, platform: 'Linux armv8l', language: 'en-GB', hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 10,
    userAgentData: { brands: [{ brand: 'Chromium', version: '140' }], mobile: false, platform: 'Android',
      getHighEntropyValues: async () => ({ model: 'SM-X930', platformVersion: '15.0.0' }) },
    getBattery: async () => ({ level: 0.82, charging: true, chargingTime: 1200, dischargingTime: Infinity }),
    connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
    wakeLock: { request() {} },
    gpu: { requestAdapter: async () => ({ info: { vendor: 'arm', architecture: 'valhall' }, features: new Set(['a']), limits: { maxTextureDimension2D: 8192, maxBufferSize: 1 } }) } },
  screen: { width: 1600, height: 2560, availWidth: 1600, availHeight: 2500, colorDepth: 24, orientation: { type: 'landscape-primary', angle: 90 } },
  document: { createElement: () => ({ getContext: t => (t === 'webgl2' ? fakeGL({ renderer: 'Immortalis-G925 MC12', maxFragU: 1024, debug: true, timer: true }) : null) }),
    referrer: 'https://dash.example.test/lovelace/secret-path?token=abc' },
  matchMedia: q => ({ matches: /coarse|p3|reduce/.test(q) }),
  devicePixelRatio: 2.25, innerWidth: 1422, innerHeight: 1000, isSecureContext: true,
  performance: { memory: { jsHeapSizeLimit: 4294705152, usedJSHeapSize: 52428800 } },
  PerformanceObserver: { supportedEntryTypes: ['longtask', 'paint'] },
  location: { origin: 'https://app.example.test', ancestorOrigins: ['https://dash.example.test'] },
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }
};
full.self = full; full.top = {};
const f = await D.collectDevice(full);
check('full: battery level and charging', f.battery && f.battery.level === 0.82 && f.battery.charging === true, f.battery);
check('full: an infinite dischargingTime becomes null', f.battery.dischargingTimeS === null);
check('full: webgl unmasked renderer', f.webgl && f.webgl.unmaskedRenderer === 'Immortalis-G925 MC12', f.webgl);
check('full: webgl limits read', f.webgl.limits.MAX_FRAGMENT_UNIFORM_VECTORS === 1024 && f.webgl.limits.MAX_TEXTURE_SIZE === 8192);
check('full: typed array limits become plain arrays', Array.isArray(f.webgl.limits.MAX_VIEWPORT_DIMS), f.webgl.limits.MAX_VIEWPORT_DIMS);
check('full: a limit the context lacks is null with a reason', f.webgl.limits.MAX_3D_TEXTURE_SIZE === null &&
  typeof f.nullReasons['webgl.limits.MAX_3D_TEXTURE_SIZE'] === 'string');
check('full: timer query detected', f.webgl.timerQuery === 'EXT_disjoint_timer_query_webgl2');
check('full: extensions sorted', f.webgl.extensions.join() === 'EXT_a,OES_b');
check('full: colour gamut p3', f.colorGamut === 'p3', f.colorGamut);
check('full: high-entropy values kept', f.userAgentDataHighEntropy && f.userAgentDataHighEntropy.model === 'SM-X930');
check('full: webgpu adapter info', f.webgpu && f.webgpu.available === true && f.webgpu.architecture === 'valhall', f.webgpu);
check('full: no reason recorded for battery/network/webgpu', !('battery' in f.nullReasons) && !('network' in f.nullReasons) && !('webgpu' in f.nullReasons));
check('app decision: Immortalis tablet is a mobile GPU', f.app.mobileGpu === true, f.app);
check('app decision: compiles ultra, runs mid, defaults to mid-lite (level 1)', f.app.compileTier === 'ultra' && f.app.tier === 'mid' && f.app.defaultLevel === 1 && f.app.maxLevel === 4, f.app);
check('app decision: nothing stored -> null with reason, per shadows mode', f.app.storedAdaptiveState.auto === null &&
  typeof f.nullReasons['app.storedAdaptiveState.auto'] === 'string' && typeof f.nullReasons['app.storedAdaptiveState.low'] === 'string');
check('app decision: nothing stored -> running the default level', f.app.currentLevel === 1 && f.app.currentLevelFrom === 'default' &&
  f.app.currentLevelConfig.dropMinorFurniture === true && f.app.currentLevelConfig.furnitureDetail === 'full', f.app);
check('app decision: start ratio 1.5 on a mobile GPU', f.app.startDpr === 1.5 && f.app.currentDpr === 1.5);
check('app decision: auto and low keys differ, and name the GPU', f.app.storageKeys.auto !== f.app.storageKeys.low &&
  f.app.storageKeys.auto === 'home3d.quality.v1|Immortalis-G925 MC12|1024|auto', f.app.storageKeys);
// A stored level 0 (the owner's low-poly bed): read, never written.
store.set(f.app.storageKeys.low, JSON.stringify({ v: 1, level: 0, blocked: { level: 1, until: 9e15 }, dprCap: null,
  settled: { level: 0, dpr: 1.25, p95: 40, at: 1 } }));
const before = JSON.stringify([...store]);
const f2 = await D.collectDevice(full, { shadows: 'low' });
check('stored level 0 in low mode -> running low (stored)', f2.app.shadowsMode === 'low' && f2.app.currentLevel === 0 &&
  f2.app.currentLevelFrom === 'stored' && f2.app.currentLevelConfig.furnitureDetail === 'low', f2.app);
check('stored settled ratio is the current ratio', f2.app.currentDpr === 1.25 && f2.app.currentDprFrom === 'stored settled');
check('the stored record is reported', f2.app.storedAdaptiveState.low && f2.app.storedAdaptiveState.low.level === 0);
check('reading the device never writes storage', JSON.stringify([...store]) === before);
check('auto mode is unaffected by the low record', (await D.collectDevice(full)).app.currentLevelFrom === 'default');
check('referrer is reduced to its origin', f.embedding.referrerOrigin === 'https://dash.example.test', f.embedding.referrerOrigin);
check('the referrer path and query never appear', JSON.stringify(f).indexOf('secret-path') === -1 && JSON.stringify(f).indexOf('token=abc') === -1);
const masked = Object.assign({}, full, { document: { createElement: () => ({ getContext: t => (t === 'webgl2' ? fakeGL({ renderer: 'x', maxFragU: 256, debug: false }) : null) }), referrer: '' } });
masked.self = masked; masked.top = masked;
const m = await D.collectDevice(masked);
check('masked: unmaskedRenderer null with a reason', m.webgl.unmaskedRenderer === null && /debug_renderer_info/.test(m.nullReasons['webgl.unmaskedRenderer']));
check('masked: 256 vectors -> low tier', m.app.compileTier === 'low' && m.app.maxLevel === 0, m.app);

// ---- 5. identity -------------------------------------------------------------------
const mem = new Map();
const w = { crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
  localStorage: { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) } };
const id1 = IO.getDeviceIdentity(w);
check('identity: generated and persisted', id1.deviceId === '11111111-2222-4333-8444-555555555555' && id1.persistent === true);
w.crypto.randomUUID = () => '99999999-2222-4333-8444-555555555555';
check('identity: reused on the next load, not regenerated', IO.getDeviceIdentity(w).deviceId === id1.deviceId);
check('identity: name remembered', IO.setDeviceName(w, '  Wall tablet  ') && IO.getDeviceIdentity(w).deviceName === 'Wall tablet');
check('identity: name capped at 60', (IO.setDeviceName(w, 'x'.repeat(100)), IO.getDeviceIdentity(w).deviceName.length === 60));
mem.set(IO.ID_KEY, '../../etc/passwd');
check('identity: a garbage stored id is replaced', /^[0-9a-f-]{36}$/.test(IO.getDeviceIdentity(w).deviceId));
const throwing = { crypto: { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, get localStorage() { throw new Error('SecurityError'); } };
const t1 = IO.getDeviceIdentity(throwing);
check('identity: throwing storage -> persistent:false, no throw', t1.persistent === false && t1.deviceId.length === 36, t1);
throwing.crypto.randomUUID = () => 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
check('identity: stable for the page even without storage', IO.getDeviceIdentity(throwing).deviceId === t1.deviceId);
check('identity: setDeviceName with throwing storage returns false', IO.setDeviceName(throwing, 'x') === false);
const noCrypto = { localStorage: null };
check('identity: works without crypto.randomUUID', /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(IO.getDeviceIdentity(noCrypto).deviceId));

// ---- 6. copy -------------------------------------------------------------------------
let written = null;
check('copy: Clipboard API path', (await IO.copyText({ navigator: { clipboard: { writeText: async t => { written = t; } } } }, 'abc')).method === 'Clipboard API' && written === 'abc');
const fakeDoc = (ok) => ({ body: { appendChild() {} }, execCommand: () => ok,
  createElement: () => ({ style: {}, setAttribute() {}, select() {}, setSelectionRange() {}, parentNode: { removeChild() {} } }) });
const c2 = await IO.copyText({ navigator: { clipboard: { writeText: async () => { throw new Error('NotAllowedError: denied'); } } }, document: fakeDoc(true) }, 'x');
check('copy: falls back to execCommand when the Clipboard API is refused', c2.ok && c2.method === 'execCommand', c2);
const c3 = await IO.copyText({ navigator: {}, document: fakeDoc(false) }, 'x');
check('copy: both fail -> ok:false with both reasons', !c3.ok && /no Clipboard API/.test(c3.error) && /execCommand returned false/.test(c3.error), c3);

// ---- apply recommended level --------------------------------------------------------
const AQ = await imp('src/adaptive-quality.js');
const qmem = new Map();
const qw = { localStorage: { getItem: k => (qmem.has(k) ? qmem.get(k) : null), setItem: (k, v) => qmem.set(k, String(v)), removeItem: k => qmem.delete(k) } };
const qkey = 'home3d.quality.v1|GPU|1024|low';
const old = JSON.stringify({ v: 1, level: 0, blocked: { level: 1, until: 9e15 }, dprCap: null, settled: null });
qmem.set(qkey, old);
const ap = IO.applyStoredLevel(qw, qkey, 2);
check('apply: returns the previous raw value', ap.ok && ap.previousRaw === old, ap);
const loaded = AQ.loadState(qw.localStorage, qkey, 4);
check('apply: written in the app format (loadState reads level 2, no block)', loaded && loaded.level === 2 && loaded.blocked === null, loaded);
check('undo: previous value restored exactly', IO.restoreStoredLevel(qw, qkey, ap.previousRaw) && qmem.get(qkey) === old);
const ap2 = IO.applyStoredLevel(qw, 'home3d.quality.v1|NEW|1024|auto', 3);
check('undo of a fresh key removes it', ap2.previousRaw === null && IO.restoreStoredLevel(qw, 'home3d.quality.v1|NEW|1024|auto', null) &&
  !qmem.has('home3d.quality.v1|NEW|1024|auto'));
check('apply refuses a key that is not an adaptive-quality record', IO.applyStoredLevel(qw, 'home3d.diagnostics.deviceId', 1).ok === false);
check('apply refuses a non-integer level', IO.applyStoredLevel(qw, qkey, 1.5).ok === false);
check('apply with throwing storage fails cleanly', IO.applyStoredLevel({ get localStorage() { throw new Error('x'); } }, qkey, 1).ok === false);

// ---- lights budget and strip specs ------------------------------------------------------
const LB = await imp('src/diagnostics/lights-budget.js');
check('light vectors: 13 points + 1 dir + 1 hemi = 13*4 + 2 + 3 + 1', LB.estimateLightVectors({ point: 13, directional: 1, hemisphere: 1 }) === 58);
check('light vectors: rect areas count 4 each', LB.estimateLightVectors({ rectArea: 25 }) === 101);
check('light vectors: point shadows add 6 each', LB.estimateLightVectors({ point: 1, pointShadow: 1 }) === 11);
const R = await imp('src/diagnostics/runner.js');
const anchors = [{ position: [0, 0.9, 0], along: [1, 0, 0], facing: [0, 0.9, 1] }, { position: [5, 0.9, 5], along: [0, 0, 1], facing: [4, 0.9, 5] }];
const b6 = R.stripLightSpecs(anchors, { kind: 'point', perStrip: 6 });
check('strip B x6: 6 dim points per strip', b6.length === 12 && b6.every(x => x.type === 'point' && x.distance === 2.5 && x.decay === 2));
check('strip B x6: spread along the metre, centred', Math.abs(Math.min(...b6.slice(0, 6).map(x => x.position[0])) + 5 / 12) < 1e-9 &&
  Math.abs(Math.max(...b6.slice(0, 6).map(x => x.position[0])) - 5 / 12) < 1e-9);
check('strip B keeps total intensity per strip', Math.abs(b6.slice(0, 6).reduce((a, x) => a + x.intensity, 0) - R.stripLightSpecs(anchors, { kind: 'point', perStrip: 1 })[0].intensity) < 1e-9);
const c = R.stripLightSpecs(anchors, { kind: 'rect', perStrip: 1 });
check('strip C: one 1 m x 2 cm RectAreaLight per strip, facing into the room', c.length === 2 && c[0].type === 'rect' && c[0].width === 1 &&
  c[0].height === 0.02 && c[0].lookAt === anchors[0].facing);

// ---- 7. save ---------------------------------------------------------------------------
const fetchOK = async (url, init) => ({ ok: true, status: 201, json: async () => ({ ok: true, id: 'run-1', receivedAt: 'T', echo: init.method }) });
const s1 = await IO.saveRun({ fetch: fetchOK }, '/api/diagnostics', { a: 1 });
check('save: success returns the id', s1.ok && s1.id === 'run-1', s1);
const fetchStatus = st => async () => ({ ok: false, status: st, json: async () => { throw new Error('not json'); } });
check('save: 404 explains the endpoint is off', /not enabled/.test((await IO.saveRun({ fetch: fetchStatus(404) }, '/x', {})).error));
check('save: 429 explains the rate limit', /too many saves/.test((await IO.saveRun({ fetch: fetchStatus(429) }, '/x', {})).error));
check('save: 413 explains the size', /larger than/.test((await IO.saveRun({ fetch: fetchStatus(413) }, '/x', {})).error));
const fetchErr = async () => ({ ok: false, status: 422, json: async () => ({ ok: false, error: 'expected schema v1' }) });
check('save: the server error text wins', /HTTP 422: expected schema v1/.test((await IO.saveRun({ fetch: fetchErr }, '/x', {})).error));
check('save: network failure is reported', /network error/.test((await IO.saveRun({ fetch: async () => { throw new Error('offline'); } }, '/x', {})).error));
check('save: a 2xx without an id is not success', !(await IO.saveRun({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }, '/x', {})).ok);

console.log(`test-diagnostics-device: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
