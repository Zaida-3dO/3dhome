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
// The NAME alone must decide these. So no case below carries a signal the
// user-agent fallback could answer with: no user agent at all (the fallback
// then says null, not true), or -- for Apple, whose name only counts on
// iOS/iPadOS -- an iPad UA with the pointer UNKNOWN (fallback: null again).
// Remove any one entry from the mobile-GPU pattern and its case fails.
const byName = [
  ['Mali (bare)', 'Mali-G78 MP14'],
  ['Mali via ANGLE', 'ANGLE (ARM, Mali-G710 MC10, OpenGL ES 3.2)'],
  ['Immortalis alone (the Tab S11 class)', 'Immortalis-G925 MC12'],
  ['Immortalis via ANGLE', 'ANGLE (ARM, Immortalis-G925 MC12, OpenGL ES 3.2)'],
  ['Adreno 750 via ANGLE', 'ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)'],
  ['Adreno (bare)', 'Adreno (TM) 740'],
  ['PowerVR', 'PowerVR Rogue GE8320'],
  ['PowerVR B-Series via ANGLE', 'ANGLE (Imagination Technologies, PowerVR B-Series BXM-8-256, OpenGL ES 3.2)'],
  ['Xclipse (Samsung RDNA)', 'Samsung Xclipse 940'],
  ['Xclipse via ANGLE', 'ANGLE (Samsung Electronics Co., Ltd., Xclipse 940, Vulkan 1.3.231)']
];
byName.forEach(([name, renderer]) => {
  const r = Q.detectMobileGpu({ renderer, userAgent: '' });
  check('by name alone: ' + name + ' -> mobile', r.mobileGpu === true, r);
});
check('control: the same call with a desktop name and no UA is not mobile',
  Q.detectMobileGpu({ renderer: 'NVIDIA GeForce RTX 4080', userAgent: '' }).mobileGpu === false);
// Apple: the name counts only with an iOS/iPadOS user agent, and the pointer
// is left unknown so the platform fallback cannot be what says yes.
check('by name: Apple GPU on an iPad -> mobile',
  Q.detectMobileGpu({ renderer: 'Apple GPU', userAgent: UA.iPad, maxTouchPoints: 5 }).mobileGpu === true);
check('by name: Apple GPU on an iPad in desktop mode (Mac UA, touch points) -> mobile',
  Q.detectMobileGpu({ renderer: 'Apple GPU', userAgent: UA.iPadDesktopMode, maxTouchPoints: 5 }).mobileGpu === true);
check('Apple GPU on a Mac -> not mobile',
  Q.detectMobileGpu({ renderer: 'Apple GPU', userAgent: UA.mac, maxTouchPoints: 0 }).mobileGpu === false);
// Desktop names, on a desktop UA.
[
  ['NVIDIA', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)', UA.windows],
  ['Radeon 780M', 'ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)', UA.windows],
  ['Intel UHD', 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', UA.windows],
  ['Apple M2', 'Apple M2', UA.mac]
].forEach(([name, renderer, ua]) => {
  check('desktop: ' + name + ' -> not mobile', Q.detectMobileGpu({ renderer, userAgent: ua, maxTouchPoints: 0 }).mobileGpu === false);
});
// The desktop-name branch must decide on its own: here the platform says
// "mobile" (Android, coarse pointer), and only the named desktop GPU says no.
check('a named desktop GPU wins over an Android UA with a coarse pointer',
  Q.detectMobileGpu({ renderer: 'NVIDIA GeForce RTX 4080', userAgent: UA.androidTablet, coarsePointer: true }).mobileGpu === false);
// A Snapdragon X Windows laptop names an Adreno: not a tablet, not capped...
const snap = 'ANGLE (Qualcomm, Snapdragon(R) X Elite - X1E80100 - Qualcomm(R) Adreno(TM) GPU (0x0000036E) Direct3D11 vs_5_0 ps_5_0, D3D11)';
check('Snapdragon X Windows laptop (Adreno, no touch) -> not mobile',
  Q.detectMobileGpu({ renderer: snap, userAgent: UA.windows, coarsePointer: false, maxTouchPoints: 0 }).mobileGpu === false);
// ...but the same chip in a Windows tablet held as one (coarse pointer) is.
check('the same Adreno on Windows with a coarse pointer -> mobile',
  Q.detectMobileGpu({ renderer: snap, userAgent: UA.windows, coarsePointer: true, maxTouchPoints: 10 }).mobileGpu === true);
check('an Adreno on Android is never excused by the desktop rule',
  Q.detectMobileGpu({ renderer: 'Adreno (TM) 750', userAgent: UA.androidPhone, coarsePointer: false }).mobileGpu === true);
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
check('a mobile GPU gets the mobile caps (pixel ratio, minor furniture)',
  Q.resolveTier({ maxFragU: 1024, mobileGpu: true }).mobileCaps === true &&
  Q.resolveTier({ maxFragU: 1024, mobileGpu: false }).mobileCaps === false &&
  Q.resolveTier({ maxFragU: 1024, mobileGpu: null }).mobileCaps === false);
check('?tier= lifts the mobile caps too, whatever tier it names',
  ['ultra', 'mid', 'low'].every(t => Q.resolveTier({ maxFragU: 1024, mobileGpu: true, override: t }).mobileCaps === false));
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
  // Since task 230713da the build comes from an adaptive-quality LEVEL
  // (src/adaptive-quality.js); scripts/test-adaptive-quality.mjs proves each
  // start level builds what the old formula built. Here: the wiring.
  check('scene: room-shadow lights and the tier come from the level config (shadows=high: top level only)',
    /roomShadowLights: startLevel\.roomShadowLights,/.test(src) && /const tier = startLevel\.tier;/.test(src));
  check('scene: the pixel-ratio start and minor skip follow mobileCaps (so ?tier= lifts them)',
    /const mobileGpu = tierInfo\.mobileCaps;/.test(src) &&
    /const dprStart = mobileGpu \? Math\.min\(scenePixelRatio, MOBILE_START_RATIO\) : scenePixelRatio;/.test(src) &&
    /mobile: mobileGpu === true/.test(src));
  check('scene: with adaptation off a mobile GPU keeps the hard 1.5 cap',
    /const scenePixelRatio = \(mobileGpu && adaptiveOff\) \? Math\.min\(pixelRatio, MOBILE_START_RATIO\) : pixelRatio;/.test(src));
  check('scene: the level decides minor furniture', /dropMinorFurniture: startLevel\.dropMinorFurniture,/.test(src) &&
    /quality\.dropMinorFurniture && item\.priority === 'minor'/.test(src));
  const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  check('page: ?tier= is passed to create()', /tier: tierParam,/.test(page) && /params\.get\('tier'\)/.test(page));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
