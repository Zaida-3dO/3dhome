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
 * Read by the scene through `rooms[].rug.pattern` (see rugPatternForBox,
 * which lays the pattern out over a rug's plan-space bounding box).
 */

export const RUG_PATTERN_DEFAULTS = Object.freeze({
  pattern: 'chevron',          // 'chevron' | 'solid'
  colors: Object.freeze(['#9a9a96', '#e8e2d4', '#2f7e8c']),
  bandWidth: 26,               // cm, measured across a band (perpendicular to the rug's length)
  angle: 40,                   // degrees, the zig-zag's slope off the rug's width axis
  zigzags: 1,                  // full zig-zags across the width: 1 = one big V, as on a bold shag
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
  // `zigzags` full zig-zags across the rug's width, kinks centred on it.
  const zigPeriod = widthCm / Math.max(1, Math.round(Number(p.zigzags) || 1));
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

/**
 * The keys a house may set under `rooms[].rug.pattern`: every default EXCEPT
 * the rug's size, which the scene takes from the rug polygon's bounding box so
 * the outline stays the single source of truth for how big the rug is.
 */
export const RUG_PATTERN_HOUSE_KEYS = Object.freeze(
  Object.keys(RUG_PATTERN_DEFAULTS).filter(k => k !== 'widthCm' && k !== 'depthCm'));

/**
 * Lay the pattern out over a rug's PLAN-space bounding box.
 *
 * The pattern's own axes are the rug's width (its LONG side, which the
 * zig-zag spans) and depth (its short side, across which the bands stack).
 * A rug in a plan can lie either way round, so this picks the long side of
 * the box as the pattern's width and, when that long side runs along plan y,
 * transposes the buffer. The result is always in plan orientation: column =
 * plan x (increasing x), row = plan y (increasing y), so a caller maps it
 * onto the rug with u = (x - x1) / spanX, row = (y - y1) / spanY.
 *
 * @param {number} spanXCm  bounding-box extent along plan x, cm
 * @param {number} spanYCm  bounding-box extent along plan y, cm
 * @param {Object} [params] overrides for RUG_PATTERN_DEFAULTS (widthCm/depthCm ignored)
 * @param {number} [longSidePx=512] texture pixels along the rug's long side
 * @returns {{width:number, height:number, data:Uint8ClampedArray, alongY:boolean}}
 */
export function rugPatternForBox(spanXCm, spanYCm, params, longSidePx) {
  const sx = spanXCm > 0 ? spanXCm : 1, sy = spanYCm > 0 ? spanYCm : 1;
  const alongY = sy > sx;
  const longCm = alongY ? sy : sx, shortCm = alongY ? sx : sy;
  const L = Math.max(8, Math.round(longSidePx > 0 ? longSidePx : 512));
  const S = Math.max(8, Math.round(L * shortCm / longCm));
  const p = Object.assign({}, params || {}, { widthCm: longCm, depthCm: shortCm });
  const pat = fillRugPattern(new Uint8ClampedArray(L * S * 4), L, S, p);
  if (!alongY) return { width: L, height: S, data: pat, alongY };
  // Transpose: plan column x <- pattern row, plan row y <- pattern column.
  const out = new Uint8ClampedArray(L * S * 4);
  for (let row = 0; row < L; row++) {
    for (let col = 0; col < S; col++) {
      const o = (row * S + col) * 4, i = (col * L + row) * 4;
      out[o] = pat[i]; out[o + 1] = pat[i + 1]; out[o + 2] = pat[i + 2]; out[o + 3] = pat[i + 3];
    }
  }
  return { width: S, height: L, data: out, alongY };
}
