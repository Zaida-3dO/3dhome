#!/usr/bin/env node
/**
 * The quality tier's mobile-GPU axis (task b37115bc): src/quality-tier.js.
 * No framework, no install: `node scripts/test-quality-tier.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. The classifier on real renderer strings: Adreno 750, Mali-G925 /
 *      Immortalis, Apple GPU (iPad yes, Mac no), NVIDIA, Radeon 780M, Intel,
 *      and a masked "WebKit WebGL" that falls back to the user agent.
 *   2. No signal at all -> null, and a null never changes the tier (the old
 *      behaviour stands).
 *   3. The tier: a mobile GPU is capped at mid; ?tier= wins over the cap
 *      but never exceeds what the uniform budget compiles.
 *   4. The pixel ratio: capped at 1.5 on a mobile GPU only.
 *   5. The scene applies it: the tier line logs mobileGpu, a mobile GPU
 *      drops room-shadow lights even with shadows=high, and minor furniture.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Q = await import(pathToFileURL(path.join(root, 'src/quality-tier.js')).href);

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

const UA = {
  androidTablet: 'Mozilla/5.0 (Linux; Android 15; SM-X930) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  androidPhone: 'Mozilla/5.0 (Linux; Android 14; SM-F956B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
  iPad: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iPadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
};

// ---- 1. the classifier on renderer strings ----------------------------------
const cases = [
  ['Adreno 750 (ANGLE)', 'ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)', UA.androidPhone, true],
  ['Adreno bare', 'Adreno (TM) 750', UA.androidPhone, true],
  ['Mali-G925 Immortalis', 'Mali-G925-Immortalis MC12', UA.androidTablet, true],
  ['Immortalis via ANGLE', 'ANGLE (ARM, Immortalis-G925 MC12, OpenGL ES 3.2)', UA.androidTablet, true],
  ['PowerVR', 'PowerVR Rogue GE8320', UA.androidPhone, true],
  ['Apple GPU on an iPad', 'Apple GPU', UA.iPad, true],
  ['Apple GPU on an iPad in desktop mode (touch points)', 'Apple GPU', UA.iPadDesktopMode, true, 5],
  ['Apple GPU on a Mac', 'Apple GPU', UA.mac, false, 0],
  ['NVIDIA', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)', UA.windows, false],
  ['Radeon 780M', 'ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)', UA.windows, false],
  ['Intel UHD', 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', UA.windows, false],
  ['Apple M-series by name', 'Apple M2', UA.mac, false, 0]
];
cases.forEach(([name, renderer, ua, want, touch]) => {
  const r = Q.detectMobileGpu({ renderer, userAgent: ua, coarsePointer: want, maxTouchPoints: touch != null ? touch : (want ? 5 : 0) });
  check('classifier: ' + name + ' -> ' + want, r.mobileGpu === want, r);
});
// The renderer's name decides even against the platform signal.
check('a named desktop GPU wins over a coarse pointer (touch-screen laptop)',
  Q.detectMobileGpu({ renderer: 'NVIDIA GeForce RTX 4080', userAgent: UA.windows, coarsePointer: true }).mobileGpu === false);
// A masked renderer falls back to the platform.
check('masked "WebKit WebGL" + Android + coarse pointer -> mobile',
  Q.detectMobileGpu({ renderer: 'WebKit WebGL', userAgent: UA.androidTablet, coarsePointer: true }).mobileGpu === true);
check('masked "WebKit WebGL" + Windows -> not mobile',
  Q.detectMobileGpu({ renderer: 'WebKit WebGL', userAgent: UA.windows, coarsePointer: false }).mobileGpu === false);
check('masked "WebKit WebGL" + iPad UA + coarse pointer -> mobile',
  Q.detectMobileGpu({ renderer: 'WebKit WebGL', userAgent: UA.iPad, coarsePointer: true, maxTouchPoints: 5 }).mobileGpu === true);
check('Android with a FINE pointer and a masked name -> not mobile (a desktop-mode Android box)',
  Q.detectMobileGpu({ renderer: 'WebKit WebGL', userAgent: UA.androidTablet, coarsePointer: false }).mobileGpu === false);

// ---- 2. no signal -> null, and null changes nothing -------------------------
const none = Q.detectMobileGpu({});
check('no renderer and no UA -> null', none.mobileGpu === null, none);
check('masked name, Android, pointer unknown -> null',
  Q.detectMobileGpu({ renderer: 'WebKit WebGL', userAgent: UA.androidTablet }).mobileGpu === null);
[1024, 512, 256].forEach(u => {
  check('null keeps the uniform tier at ' + u, Q.resolveTier({ maxFragU: u, mobileGpu: null }).tier === Q.tierForUniforms(u));
  check('false keeps the uniform tier at ' + u, Q.resolveTier({ maxFragU: u, mobileGpu: false }).tier === Q.tierForUniforms(u));
});

// ---- 3. the tier ----------------------------------------------------------------
check('uniform tiers: 1024 ultra, 512 mid, 256 low', Q.tierForUniforms(1024) === 'ultra' &&
  Q.tierForUniforms(1023) === 'mid' && Q.tierForUniforms(512) === 'mid' && Q.tierForUniforms(511) === 'low');
const tab = Q.resolveTier({ maxFragU: 1024, mobileGpu: true });
check('mobile GPU at 1024 -> mid, marked capped', tab.tier === 'mid' && tab.capped && tab.compileTier === 'ultra', tab);
check('mobile GPU at 256 stays low', Q.resolveTier({ maxFragU: 256, mobileGpu: true }).tier === 'low');
check('?tier=ultra wins over the mobile cap (A/B on the tablet)',
  Q.resolveTier({ maxFragU: 1024, mobileGpu: true, override: 'ultra' }).tier === 'ultra');
check('?tier=low on a desktop -> low', Q.resolveTier({ maxFragU: 4096, mobileGpu: false, override: 'low' }).tier === 'low');
check('?tier=ultra never exceeds what compiles (256 stays low)',
  Q.resolveTier({ maxFragU: 256, mobileGpu: true, override: 'ultra' }).tier === 'low');
check('an unknown ?tier= is ignored', Q.resolveTier({ maxFragU: 1024, mobileGpu: true, override: 'max' }).tier === 'mid');

// ---- 4. pixel ratio --------------------------------------------------------------
check('pixel ratio capped at 1.5 on a mobile GPU', Q.capPixelRatio(2, true) === 1.5 && Q.capPixelRatio(1, true) === 1);
check('pixel ratio unchanged otherwise', Q.capPixelRatio(2, false) === 2 && Q.capPixelRatio(2, null) === 2);

// ---- 5. the scene applies it ------------------------------------------------------
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('scene: tier comes from resolveTier with the page override',
    /resolveTier\(\{ maxFragU, mobileGpu: gpu\.mobileGpu, override: opts\.tier \}\)/.test(src));
  check('scene: the tier line logs mobileGpu and the light counts',
    /Quality tier=\$\{tier\}/.test(src) && /mobileGpu=\$\{gpu\.mobileGpu\}/.test(src) && /lights: point=\$\{lc\.point\}/.test(src));
  check('scene: the ramp ceiling is the capped pixel ratio', /const basePixelRatio = scenePixelRatio;/.test(src));
  check('scene: room-shadow lights need the TIER (not only the uniforms) to allow them under shadows=high',
    /roomShadowLights = tier !== 'low' && !tierInfo\.capped;/.test(src) && /const tier = tierInfo\.tier;/.test(src));
  check('scene: a mobile GPU drops minor furniture', /dropMinorFurniture: mobileGpu/.test(src) &&
    /quality\.dropMinorFurniture && item\.priority === 'minor'/.test(src));
  const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('page: ?tier= is passed to create()', /tier: tierParam,/.test(page) && /params\.get\('tier'\)/.test(page));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
