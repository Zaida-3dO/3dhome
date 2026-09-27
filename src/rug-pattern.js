/**
 * rug-pattern.js - a procedural rug LOOK, not a furniture type.
 *
 * Rugs are drawn by the scene from `rooms[].rug` (which already accepts a
 * house-supplied `texture` image). This module is the public, procedural
 * alternative to such an image: it fills an RGBA pixel buffer with bold
 * zig-zag (chevron) bands cycling through a palette, plus seeded per-pixel
 * pile noise so the result reads as a long shaggy pile rather than a flat
 * print.
 *
 * Pure and deterministic: no DOM, no Math.random (a seeded mulberry32 PRNG),
 * so it runs the same in Node tests and on a spec page, where the caller
 * copies the buffer into a canvas ImageData and wraps that in a
 * CanvasTexture.
 *
 * NOT YET READ BY THE SCENE: wiring a `pattern` key into home3d-scene.js is a
 * later step.
 */

export const RUG_PATTERN_DEFAULTS = Object.freeze({
  pattern: 'chevron',          // 'chevron' | 'solid'
  colors: Object.freeze(['#9a9a96', '#e8e2d4', '#2f7e8c']),
  bandWidth: 18,               // cm, measured across a band (perpendicular to the rug's length)
  angle: 35,                   // degrees, the zig-zag's slope off the rug's width axis
  pileNoise: 0.18,             // 0 = flat print, ~0.2 = shag; fuzzes band edges and shades strands
  seed: 1,
  widthCm: 210,
  depthCm: 150
});

export const RUG_PATTERNS = Object.freeze(['chevron', 'solid']);

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** '#rrggbb' (or '#rgb') -> [r, g, b]; anything else is mid grey. */
export function hexToRgb(hex) {
  let s = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return [128, 128, 128];
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Triangle wave with slope +-1 and period `p`: 0 at x = 0, peak p/2 at x = p/2. */
function tri(x, p) {
  const m = ((x % p) + p) % p;
  return m < p / 2 ? m : p - m;
}

/**
 * Fill `rgba` (a Uint8ClampedArray of w*h*4) with the rug pattern. The buffer
 * spans the whole rug: x across widthCm, y across depthCm. Returns `rgba`.
 * @param {Uint8ClampedArray} rgba
 * @param {number} w  pixels across the rug's width
 * @param {number} h  pixels across the rug's depth
 * @param {Object} [params]  overrides for RUG_PATTERN_DEFAULTS
 */
export function fillRugPattern(rgba, w, h, params) {
  const p = Object.assign({}, RUG_PATTERN_DEFAULTS, params || {});
  const colors = (Array.isArray(p.colors) && p.colors.length ? p.colors : RUG_PATTERN_DEFAULTS.colors).map(hexToRgb);
  const nc = colors.length;
  const widthCm = p.widthCm > 0 ? p.widthCm : RUG_PATTERN_DEFAULTS.widthCm;
  const depthCm = p.depthCm > 0 ? p.depthCm : RUG_PATTERN_DEFAULTS.depthCm;
  const band = p.bandWidth > 0 ? p.bandWidth : RUG_PATTERN_DEFAULTS.bandWidth;
  const noise = Math.max(0, Math.min(1, Number(p.pileNoise) || 0));
  const slope = Math.tan(Math.max(0, Math.min(80, Number(p.angle) || 0)) * Math.PI / 180);
  const solid = p.pattern === 'solid';
  const rand = mulberry32(Math.floor(Number(p.seed) || 0));
  const cmPerPxX = widthCm / w, cmPerPxY = depthCm / h;
  // Two full zig-zags across the rug's width, kinks centred on it.
  const zigPeriod = widthCm / 2;
  // Strand streaks: shag strands lie in a common direction, so shade each
  // pixel partly from a short run shared with its neighbours down the column.
  const runLen = Math.max(2, Math.round(h / 60));
  const strand = new Float32Array(w);

  for (let y = 0; y < h; y++) {
    const yc = (y + 0.5) * cmPerPxY;
    if (y % runLen === 0) for (let x = 0; x < w; x++) strand[x] = rand() - 0.5;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let ci = 0;
      const r1 = rand(), r2 = rand();
      if (!solid) {
        const xc = (x + 0.5) * cmPerPxX - widthCm / 2;
        let u = yc + slope * tri(xc + zigPeriod / 4, zigPeriod);
        // Fuzz the band edge: pile tufts overhang the boundary.
        u += noise * band * 0.6 * (r1 - 0.5);
        ci = ((Math.floor(u / band) % nc) + nc) % nc;
      }
      const c = colors[ci];
      // Brightness jitter: per-pixel grain plus the shared strand streak.
      const k = noise === 0 ? 1 : 1 + noise * (1.2 * (r2 - 0.5) + 0.9 * strand[x]);
      rgba[i] = c[0] * k;
      rgba[i + 1] = c[1] * k;
      rgba[i + 2] = c[2] * k;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}
