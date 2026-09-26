/**
 * quality-tier.js - which quality tier a device gets, as pure functions.
 *
 * Two axes decide it:
 *
 *   1. COMPILE: MAX_FRAGMENT_UNIFORM_VECTORS. >= 1024 ultra, >= 512 mid,
 *      else low. This answers "will the lit shader compile at all?". A
 *      256-vector Adreno phone that got the full light set rendered nothing.
 *
 *   2. THROUGHPUT (task b37115bc): a mobile GPU. The uniform count says
 *      nothing about fragment throughput. A modern Mali/Immortalis tablet
 *      reports 1024 and would get the desktop light set -- every light
 *      evaluated for every fragment of every lit material, at up to DPR 2 --
 *      on a GPU that has a fraction of a desktop part's fill rate. A mobile
 *      GPU is capped at `mid` (no room-shadow SpotLights, whatever
 *      `?shadows=` says), at a pixel ratio of MOBILE_MAX_PIXEL_RATIO, and
 *      skips `priority: "minor"` furniture.
 *
 * No GPU-tier library (the project rule stands): two string checks.
 *
 * Pure ESM, no DOM and no THREE, so scripts/test-quality-tier.mjs drives it
 * directly. home3d-scene.js gathers the inputs and applies the result.
 */

export const TIERS = Object.freeze(['low', 'mid', 'ultra']);

/** The resolution ramp's ceiling on a mobile GPU. */
export const MOBILE_MAX_PIXEL_RATIO = 1.5;

// Mobile GPU families, as WEBGL_debug_renderer_info (or an unmasked
// gl.RENDERER) names them. "Apple GPU" is what Safari reports on EVERY Apple
// device, Macs included, so it only counts with an iOS/iPadOS user agent.
const MOBILE_RE = /\b(mali|immortalis|adreno|powervr|xclipse)\b/i;
const APPLE_GPU_RE = /\bapple\s+gpu\b/i;
// Names that identify a desktop part outright.
const DESKTOP_RE = /\b(nvidia|geforce|quadro|rtx|radeon|amd|intel|iris|uhd graphics|hd graphics|arc)\b|apple m\d/i;
// A renderer string that says nothing about the hardware.
const MASKED_RE = /^\s*(webkit webgl|mozilla|google swiftshader|angle \(google, vulkan[^)]*swiftshader)/i;

// A desktop operating system. A mobile-class GPU inside one (a Snapdragon X
// Windows laptop's Adreno) is not a tablet: it drives a laptop panel, with
// a laptop's power budget, and is not capped unless it has a touch pointer.
function isDesktopOS(ua, maxTouchPoints) {
  if (/\bandroid\b/i.test(ua) || isIOSLike(ua, maxTouchPoints)) return false;
  return /\b(windows nt|macintosh|x11|cros)\b/i.test(ua);
}

function isIOSLike(ua, maxTouchPoints) {
  if (/\b(iphone|ipad|ipod)\b/i.test(ua)) return true;
  // iPadOS 13+ reports a Mac user agent; a Mac has no touch points.
  return /\bmacintosh\b/i.test(ua) && (maxTouchPoints | 0) > 1;
}

/**
 * Is this a mobile GPU?
 *
 * @param {Object} s
 * @param {string} [s.renderer]       unmasked renderer string, or gl.RENDERER
 * @param {string} [s.userAgent]
 * @param {boolean} [s.coarsePointer] matchMedia('(pointer: coarse)').matches
 * @param {number} [s.maxTouchPoints]
 * @returns {{mobileGpu: ?boolean, reason: string}}
 *   mobileGpu is null when neither signal says anything -- the caller then
 *   keeps the uniform-count tier unchanged (the old behaviour).
 */
export function detectMobileGpu(s) {
  const o = s || {};
  const r = typeof o.renderer === 'string' ? o.renderer : '';
  const ua = typeof o.userAgent === 'string' ? o.userAgent : '';
  // 1. The GPU's own name, when it gives one.
  if (r && !MASKED_RE.test(r)) {
    if (MOBILE_RE.test(r)) {
      if (ua && isDesktopOS(ua, o.maxTouchPoints) && o.coarsePointer !== true) {
        return { mobileGpu: false, reason: 'mobile-class GPU in a desktop OS without touch' };
      }
      return { mobileGpu: true, reason: 'renderer names a mobile GPU' };
    }
    if (APPLE_GPU_RE.test(r)) {
      // On a Mac it falls through: a macOS user agent is no mobile signal.
      if (isIOSLike(ua, o.maxTouchPoints)) return { mobileGpu: true, reason: 'Apple GPU on iOS/iPadOS' };
    } else if (DESKTOP_RE.test(r)) {
      return { mobileGpu: false, reason: 'renderer names a desktop GPU' };
    }
  }
  // 2. The platform: Android or iOS/iPadOS with a coarse (touch) pointer.
  if (ua) {
    const mobileOs = /\bandroid\b/i.test(ua) || isIOSLike(ua, o.maxTouchPoints);
    if (mobileOs && o.coarsePointer === true) return { mobileGpu: true, reason: 'mobile OS with a coarse pointer' };
    if (mobileOs && o.coarsePointer == null) return { mobileGpu: null, reason: 'mobile OS, pointer unknown' };
    return { mobileGpu: false, reason: 'no mobile signal' };
  }
  return { mobileGpu: null, reason: 'no renderer name and no user agent' };
}

/** The tier the uniform budget allows (axis 1). */
export function tierForUniforms(maxFragU) {
  if (maxFragU >= 1024) return 'ultra';
  if (maxFragU >= 512) return 'mid';
  return 'low';
}

/**
 * The tier to use.
 *
 * @param {Object} s
 * @param {number} s.maxFragU
 * @param {?boolean} s.mobileGpu
 * @param {string} [s.override]  'ultra' | 'mid' | 'low' (the page's ?tier=).
 *        Wins over the mobile cap, for A/B testing, but never goes ABOVE what
 *        the uniform budget compiles: a forced 'ultra' on a 256-vector phone
 *        would render nothing, so it stays 'low'.
 * @returns {{tier: string, compileTier: string, capped: boolean, overridden: boolean,
 *            mobileCaps: boolean}}  mobileCaps: apply the mobile pixel-ratio cap and
 *            the minor-furniture skip. ?tier= lifts them along with the tier cap.
 */
export function resolveTier(s) {
  const compileTier = tierForUniforms(s.maxFragU);
  const rank = t => TIERS.indexOf(t);
  let tier = compileTier;
  let capped = false;
  if (s.mobileGpu === true && rank(tier) > rank('mid')) { tier = 'mid'; capped = true; }
  let overridden = false;
  if (TIERS.indexOf(s.override) !== -1) {
    tier = rank(s.override) <= rank(compileTier) ? s.override : compileTier;
    overridden = true;
    capped = false;
  }
  return { tier, compileTier, capped, overridden, mobileCaps: s.mobileGpu === true && !overridden };
}

/** The pixel ratio to use: capped at MOBILE_MAX_PIXEL_RATIO on a mobile GPU. */
export function capPixelRatio(pixelRatio, mobileGpu) {
  return mobileGpu === true ? Math.min(pixelRatio, MOBILE_MAX_PIXEL_RATIO) : pixelRatio;
}
