/**
 * device-info.js - the benchmark's device/environment block (item 112ec00c).
 *
 * THE RULE: every field is always present. An API this browser does not
 * expose, refuses, or throws from is recorded as `null`, and the reason goes
 * into `nullReasons` under the same dotted path -- never omitted. An agent
 * comparing two devices must be able to tell "this tablet has no Battery API"
 * from "the benchmark forgot to ask".
 *
 * Everything the browser offers is read through an injected `env` (window by
 * default), so scripts/test-diagnostics-device.mjs drives it with fakes that
 * lack, refuse or throw from each API in turn.
 *
 * PRIVACY: nothing here identifies a person or a home. It is the same class
 * of data any website reads to pick a video resolution. Not collected on
 * purpose: geolocation, the IP address, device names, the page URL (only its
 * ORIGIN is kept, and only for the embedding case), and anything from the
 * house profile beyond counts (the caller adds those).
 */

import { detectMobileGpu, resolveTier } from '../quality-tier.js';
import { maxLevelFor, defaultLevel, storageKey, loadState } from '../adaptive-quality.js';

/**
 * A probe: `get(path, fn)` runs fn and returns its value, or null -- and when
 * it is null, why, recorded under `path` in `reasons`. fn may itself return
 * {__null: 'reason'} to record a specific reason.
 */
export function createProbe() {
  const reasons = {};
  function get(path, fn) {
    try {
      const v = fn();
      if (v && typeof v === 'object' && typeof v.__null === 'string') { reasons[path] = v.__null; return null; }
      if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) {
        reasons[path] = 'not exposed by this browser';
        return null;
      }
      return v;
    } catch (e) {
      reasons[path] = 'threw: ' + (e && e.message ? String(e.message).slice(0, 160) : String(e));
      return null;
    }
  }
  async function getAsync(path, fn) {
    try {
      const v = await fn();
      if (v && typeof v === 'object' && typeof v.__null === 'string') { reasons[path] = v.__null; return null; }
      if (v === undefined || v === null) { reasons[path] = 'not exposed by this browser'; return null; }
      return v;
    } catch (e) {
      reasons[path] = 'rejected: ' + (e && e.message ? String(e.message).slice(0, 160) : String(e));
      return null;
    }
  }
  function nul(path, why) { reasons[path] = why; return null; }
  return { get, getAsync, nul, reasons };
}

const NO = why => ({ __null: why });

const GL_LIMITS = [
  'MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_VIEWPORT_DIMS',
  'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS',
  'MAX_VERTEX_ATTRIBS', 'MAX_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS',
  'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_SAMPLES', 'MAX_DRAW_BUFFERS', 'MAX_COLOR_ATTACHMENTS',
  'MAX_3D_TEXTURE_SIZE', 'MAX_ARRAY_TEXTURE_LAYERS', 'MAX_UNIFORM_BLOCK_SIZE',
  'MAX_FRAGMENT_UNIFORM_BLOCKS', 'MAX_VERTEX_UNIFORM_BLOCKS', 'MAX_COMBINED_UNIFORM_BLOCKS',
  'ALIASED_POINT_SIZE_RANGE', 'ALIASED_LINE_WIDTH_RANGE', 'MAX_ELEMENTS_VERTICES', 'MAX_ELEMENTS_INDICES'
];

function plain(v) {
  if (v == null) return v;
  if (typeof v === 'object' && typeof v.length === 'number') return Array.prototype.slice.call(v);
  return v;
}

/** The WebGL block, from a throwaway context. Frees it afterwards. */
export function collectWebGL(env, probe) {
  const P = probe;
  const doc = env.document;
  let canvas = null, gl = null, version = null;
  try {
    canvas = doc && typeof doc.createElement === 'function' ? doc.createElement('canvas') : null;
    if (canvas) {
      gl = canvas.getContext('webgl2');
      version = gl ? 2 : null;
      if (!gl) { gl = canvas.getContext('webgl'); version = gl ? 1 : null; }
    }
  } catch (e) { gl = null; }
  if (!gl) {
    P.nul('webgl', canvas ? 'no WebGL context could be created' : 'no document to create a canvas in');
    return null;
  }
  const out = { version };
  out.glVersion = P.get('webgl.glVersion', () => gl.getParameter(gl.VERSION));
  out.shadingLanguageVersion = P.get('webgl.shadingLanguageVersion', () => gl.getParameter(gl.SHADING_LANGUAGE_VERSION));
  out.vendor = P.get('webgl.vendor', () => gl.getParameter(gl.VENDOR));
  out.renderer = P.get('webgl.renderer', () => gl.getParameter(gl.RENDERER));
  const dbg = P.get('webgl.debugRendererInfo', () => gl.getExtension('WEBGL_debug_renderer_info') ||
    NO('WEBGL_debug_renderer_info not exposed (masked by the browser)'));
  out.unmaskedVendor = dbg ? P.get('webgl.unmaskedVendor', () => gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
    : P.nul('webgl.unmaskedVendor', 'WEBGL_debug_renderer_info not exposed');
  out.unmaskedRenderer = dbg ? P.get('webgl.unmaskedRenderer', () => gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : P.nul('webgl.unmaskedRenderer', 'WEBGL_debug_renderer_info not exposed');
  out.limits = {};
  GL_LIMITS.forEach(name => {
    if (gl[name] === undefined) { out.limits[name] = P.nul('webgl.limits.' + name, 'not a WebGL' + version + ' parameter'); return; }
    out.limits[name] = P.get('webgl.limits.' + name, () => plain(gl.getParameter(gl[name])));
  });
  out.antialias = P.get('webgl.antialias', () => { const a = gl.getContextAttributes(); return a ? !!a.antialias : null; });
  out.highpFragment = P.get('webgl.highpFragment', () => {
    const f = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    return f ? f.precision > 0 : null;
  });
  out.extensions = P.get('webgl.extensions', () => (gl.getSupportedExtensions() || []).slice().sort());
  out.timerQuery = P.get('webgl.timerQuery', () => version === 2
    ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') ? 'EXT_disjoint_timer_query_webgl2'
      : NO('EXT_disjoint_timer_query_webgl2 not exposed (common: browsers restrict it for fingerprinting)'))
    : (gl.getExtension('EXT_disjoint_timer_query') ? 'EXT_disjoint_timer_query'
      : NO('EXT_disjoint_timer_query not exposed')));
  out.parallelShaderCompile = P.get('webgl.parallelShaderCompile', () => !!gl.getExtension('KHR_parallel_shader_compile'));
  try { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch (e) { /* best effort */ }
  return out;
}

/**
 * The app's own decisions for this device, recomputed with the app's own pure
 * functions (quality-tier.js, adaptive-quality.js) from the same inputs the
 * scene reads. The runner cross-checks these against what the first scene
 * build actually reports.
 */
export function appDecision(env, webgl, probe) {
  const nav = env.navigator || {};
  const renderer = webgl ? (webgl.unmaskedRenderer || webgl.renderer || '') : '';
  const maxFragU = webgl && webgl.limits ? webgl.limits.MAX_FRAGMENT_UNIFORM_VECTORS : null;
  if (!webgl || !Number.isFinite(maxFragU)) {
    probe.nul('app', 'no WebGL, so the app cannot pick a tier');
    return null;
  }
  const coarse = typeof env.matchMedia === 'function' ? env.matchMedia('(pointer: coarse)').matches : undefined;
  const gpu = detectMobileGpu({ renderer, userAgent: nav.userAgent || '', coarsePointer: coarse, maxTouchPoints: nav.maxTouchPoints || 0 });
  const t = resolveTier({ maxFragU, mobileGpu: gpu.mobileGpu });
  const maxLevel = maxLevelFor(t.compileTier);
  const def = defaultLevel(t.mobileCaps === true, maxLevel);
  let stored = null;
  let storage = null;
  try { storage = env.localStorage || null; } catch (e) { storage = null; }
  stored = probe.get('app.storedAdaptiveState', () => {
    const s = loadState(storage, storageKey(renderer, maxFragU, 'auto'), maxLevel);
    return s || NO('nothing stored for this GPU (the app has not settled a level here, or storage is unavailable)');
  });
  return {
    mobileGpu: gpu.mobileGpu, mobileReason: gpu.reason, mobileCaps: t.mobileCaps,
    compileTier: t.compileTier, tier: t.tier, maxLevel, defaultLevel: def,
    storedAdaptiveState: stored
  };
}

function mm(env, q) {
  if (typeof env.matchMedia !== 'function') return NO('matchMedia not available');
  return env.matchMedia(q).matches;
}

/**
 * Collect the whole device block. Async only for the APIs that are
 * (userAgentData high-entropy values, Battery, WebGPU adapter info).
 *
 * @param {Object} env  window, or a fake with the same shape
 */
export async function collectDevice(env) {
  const P = createProbe();
  const nav = env.navigator || {};
  const out = {};
  out.userAgent = P.get('userAgent', () => nav.userAgent);
  out.platform = P.get('platform', () => nav.platform);
  out.language = P.get('language', () => nav.language);
  out.userAgentData = P.get('userAgentData', () => nav.userAgentData
    ? { brands: plain(nav.userAgentData.brands || []).map(b => ({ brand: b.brand, version: b.version })),
        mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform }
    : NO('navigator.userAgentData not exposed (Firefox and Safari do not implement it)'));
  out.userAgentDataHighEntropy = nav.userAgentData && typeof nav.userAgentData.getHighEntropyValues === 'function'
    ? await P.getAsync('userAgentDataHighEntropy', () => nav.userAgentData.getHighEntropyValues(
      ['architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'formFactors']))
    : P.nul('userAgentDataHighEntropy', 'getHighEntropyValues not available');
  out.hardwareConcurrency = P.get('hardwareConcurrency', () => nav.hardwareConcurrency);
  out.deviceMemoryGB = P.get('deviceMemoryGB', () => nav.deviceMemory !== undefined ? nav.deviceMemory
    : NO('navigator.deviceMemory not exposed (Chromium-only, secure contexts)'));
  out.maxTouchPoints = P.get('maxTouchPoints', () => nav.maxTouchPoints);
  const scr = env.screen || null;
  out.screen = scr ? {
    width: P.get('screen.width', () => scr.width), height: P.get('screen.height', () => scr.height),
    availWidth: P.get('screen.availWidth', () => scr.availWidth), availHeight: P.get('screen.availHeight', () => scr.availHeight),
    colorDepth: P.get('screen.colorDepth', () => scr.colorDepth)
  } : P.nul('screen', 'window.screen not available');
  out.devicePixelRatio = P.get('devicePixelRatio', () => env.devicePixelRatio);
  out.viewport = { width: P.get('viewport.width', () => env.innerWidth), height: P.get('viewport.height', () => env.innerHeight) };
  out.orientation = P.get('orientation', () => scr && scr.orientation && scr.orientation.type
    ? { type: scr.orientation.type, angle: scr.orientation.angle }
    : NO('screen.orientation not exposed'));
  out.colorGamut = P.get('colorGamut', () => {
    if (typeof env.matchMedia !== 'function') return NO('matchMedia not available');
    return ['rec2020', 'p3', 'srgb'].find(g => env.matchMedia('(color-gamut: ' + g + ')').matches) || NO('no color-gamut query matched');
  });
  out.dynamicRange = P.get('dynamicRange', () => {
    const r = mm(env, '(dynamic-range: high)');
    return r && typeof r === 'object' ? r : (r ? 'high' : 'standard');
  });
  out.prefersReducedMotion = P.get('prefersReducedMotion', () => mm(env, '(prefers-reduced-motion: reduce)'));
  out.pointerCoarse = P.get('pointerCoarse', () => mm(env, '(pointer: coarse)'));
  out.hover = P.get('hover', () => mm(env, '(hover: hover)'));
  out.refreshRateHz = null; // measured by the runner from idle rAF ticks; filled in later
  P.nul('refreshRateHz', 'measured by the runner (idle rAF), filled in after the calibration');

  // Embedding: an iframe (the Home Assistant companion app's dashboard) or a
  // plain tab. The referrer is reduced to its ORIGIN; the path never leaves.
  out.embedding = {
    inIframe: P.get('embedding.inIframe', () => { try { return env.self !== env.top; } catch (e) { return true; } }),
    referrerOrigin: P.get('embedding.referrerOrigin', () => {
      const r = env.document && env.document.referrer;
      if (!r) return NO('no referrer (opened directly, or the embedder sends none)');
      try { return new URL(r).origin; } catch (e) { return NO('referrer is not a URL'); }
    }),
    ancestorOrigins: P.get('embedding.ancestorOrigins', () => env.location && env.location.ancestorOrigins
      ? plain(env.location.ancestorOrigins) : NO('location.ancestorOrigins not exposed (Chromium/Safari only)')),
    standalone: P.get('embedding.standalone', () => mm(env, '(display-mode: standalone)')),
    webviewHint: P.get('embedding.webviewHint', () => {
      const ua = nav.userAgent || '';
      if (/\bwv\b/.test(ua)) return 'android-webview';
      if (/Home ?Assistant/i.test(ua)) return 'home-assistant-app';
      if (/(iPhone|iPad).*AppleWebKit(?!.*Safari)/.test(ua)) return 'ios-webview';
      return 'none';
    }),
    secureContext: P.get('embedding.secureContext', () => env.isSecureContext),
    origin: P.get('embedding.origin', () => env.location ? env.location.origin : NO('no location'))
  };

  out.battery = typeof nav.getBattery === 'function'
    ? await P.getAsync('battery', async () => {
      const b = await nav.getBattery();
      return { level: b.level, charging: b.charging,
        chargingTimeS: Number.isFinite(b.chargingTime) ? b.chargingTime : null,
        dischargingTimeS: Number.isFinite(b.dischargingTime) ? b.dischargingTime : null };
    })
    : P.nul('battery', 'navigator.getBattery not available (Firefox and Safari/iOS do not implement it)');

  out.network = P.get('network', () => {
    const c = nav.connection;
    if (!c) return NO('navigator.connection not exposed (Firefox and Safari do not implement it)');
    return { effectiveType: c.effectiveType != null ? c.effectiveType : null, downlinkMbps: c.downlink != null ? c.downlink : null,
      rttMs: c.rtt != null ? c.rtt : null, saveData: c.saveData != null ? !!c.saveData : null, type: c.type != null ? c.type : null };
  });

  out.memory = P.get('memory', () => {
    const m = env.performance && env.performance.memory;
    if (!m) return NO('performance.memory not exposed (Chromium-only)');
    return { jsHeapSizeLimitMB: Math.round(m.jsHeapSizeLimit / 1048576), usedJSHeapSizeMB: Math.round(m.usedJSHeapSize / 1048576) };
  });
  out.longTaskSupported = P.get('longTaskSupported', () => {
    const PO = env.PerformanceObserver;
    if (!PO || !PO.supportedEntryTypes) return NO('PerformanceObserver.supportedEntryTypes not exposed');
    return PO.supportedEntryTypes.indexOf('longtask') !== -1;
  });
  out.wakeLockSupported = P.get('wakeLockSupported', () => !!(nav.wakeLock && typeof nav.wakeLock.request === 'function'));

  out.webgl = collectWebGL(env, P);
  out.webgpu = nav.gpu && typeof nav.gpu.requestAdapter === 'function'
    ? await P.getAsync('webgpu', async () => {
      const a = await nav.gpu.requestAdapter();
      if (!a) return NO('navigator.gpu present but no adapter was granted');
      let info = a.info || null;
      if (!info && typeof a.requestAdapterInfo === 'function') { try { info = await a.requestAdapterInfo(); } catch (e) { info = null; } }
      return { available: true, isFallbackAdapter: a.isFallbackAdapter != null ? !!a.isFallbackAdapter : null,
        vendor: info ? info.vendor || null : null, architecture: info ? info.architecture || null : null,
        device: info ? info.device || null : null, description: info ? info.description || null : null,
        features: a.features ? Array.from(a.features).sort() : null,
        limits: a.limits ? { maxTextureDimension2D: a.limits.maxTextureDimension2D, maxBufferSize: a.limits.maxBufferSize } : null };
    })
    : P.nul('webgpu', 'navigator.gpu not available (no WebGPU, or not a secure context)');

  out.app = appDecision(env, out.webgl, P);
  out.nullReasons = P.reasons;
  return out;
}
