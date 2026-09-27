#!/usr/bin/env node
/**
 * src/rug-pattern.js: the procedural rug look. No framework, no install:
 * `node scripts/test-rug-pattern.mjs`.
 *
 * Each check names the source mutation that makes it fail:
 *
 *   1. Deterministic: the same seed gives identical bytes; a different seed
 *      gives different bytes.
 *   2. pileNoise 0 is a clean print: every pixel is exactly one palette
 *      colour, and each colour covers 1/3 of the rug within +-5 %.
 *   3. It is a ZIG-ZAG: along one row the colour changes at least twice per
 *      colour cycle, and the band order runs BOTH ways (a plain diagonal
 *      stripe only ever steps one way).
 *   4. 'solid' is a single colour.
 *   5. No DOM: the module never names a DOM global or Math.random, and it
 *      runs here in Node with none defined.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = await import(pathToFileURL(path.join(root, 'src/rug-pattern.js')).href);

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// 512 px on the long side, the spec page's texture size, at the default 210 x 150.
const W = 512, H = Math.round(512 * 150 / 210);
function fill(params, w = W, h = H) {
  const a = new Uint8ClampedArray(w * h * 4);
  R.fillRugPattern(a, w, h, params);
  return a;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const key = (a, i) => a[i] + ',' + a[i + 1] + ',' + a[i + 2];
const palette = R.RUG_PATTERN_DEFAULTS.colors.map(h => R.hexToRgb(h).join(','));

// ---- exports ------------------------------------------------------------------------
check('RUG_PATTERN_DEFAULTS frozen', Object.isFrozen(R.RUG_PATTERN_DEFAULTS));
check('defaults: chevron, 3 colours, 26 cm bands, 40 deg, one big zig-zag, 210 x 150',
  R.RUG_PATTERN_DEFAULTS.pattern === 'chevron' && R.RUG_PATTERN_DEFAULTS.colors.length === 3 &&
  R.RUG_PATTERN_DEFAULTS.bandWidth === 26 && R.RUG_PATTERN_DEFAULTS.angle === 40 && R.RUG_PATTERN_DEFAULTS.zigzags === 1 &&
  R.RUG_PATTERN_DEFAULTS.widthCm === 210 && R.RUG_PATTERN_DEFAULTS.depthCm === 150, R.RUG_PATTERN_DEFAULTS);

// ---- 1. determinism -------------------------------------------------------------------
// Mutations: swap mulberry32 for Math.random -> "same seed" fails;
// ignore p.seed (always mulberry32(1)) -> "different seed" fails.
{
  const a = fill({ seed: 7 }), b = fill({ seed: 7 }), c = fill({ seed: 8 });
  check('same seed -> identical bytes', same(a, b));
  check('different seed -> different bytes', !same(a, c));
  let opaque = true;
  for (let i = 3; i < a.length; i += 4) if (a[i] !== 255) { opaque = false; break; }
  check('every pixel is opaque', opaque);
}

// ---- 2. clean print: palette only, even shares -------------------------------------------
// Mutations: floor the noise clamp at 0.05 (Math.max(0.05, ...)) -> "palette only"
// fails; `% (nc - 1)` in the band index -> teal never appears and shares fail.
{
  const a = fill({ pileNoise: 0 });
  const counts = {};
  let off = 0;
  for (let i = 0; i < a.length; i += 4) {
    const k = key(a, i);
    if (palette.indexOf(k) === -1) off++;
    counts[k] = (counts[k] || 0) + 1;
  }
  check('pileNoise 0: every pixel is exactly a palette colour', off === 0, { off, sample: Object.keys(counts).slice(0, 6) });
  const n = W * H;
  for (const k of palette) {
    const share = (counts[k] || 0) / n;
    check('pileNoise 0: colour ' + k + ' covers 1/3 +-5 %', Math.abs(share - 1 / 3) <= (1 / 3) * 0.05, share);
  }
}

// ---- 3. a zig-zag, not flat or diagonal stripes ---------------------------------------------
// Mutations: slope = 0 (flat stripes) -> no colour changes along a row;
// drop tri() (u = yc + slope * xc, a plain diagonal) -> the order only runs one way.
for (const row of [Math.floor(H * 0.25), Math.floor(H * 0.5), Math.floor(H * 0.8)]) {
  const a = fill({ pileNoise: 0 });
  let changes = 0, fwd = 0, back = 0, prev = null;
  for (let x = 0; x < W; x++) {
    const c = palette.indexOf(key(a, (row * W + x) * 4));
    if (prev !== null && c !== prev) {
      changes++;
      if ((prev + 1) % 3 === c) fwd++; else back++;
    }
    prev = c;
  }
  const d = R.RUG_PATTERN_DEFAULTS;
  const periods = d.widthCm / (3 * d.bandWidth);           // colour cycles' worth of width
  check('row ' + row + ': >= 2 colour changes per colour cycle along the row', changes >= 2 * Math.floor(periods), { changes, periods });
  check('row ' + row + ': the band order runs both ways (zig AND zag)', fwd > 0 && back > 0, { fwd, back });
}

// ---- 3b. zigzags is honoured ---------------------------------------------------------------
// Mutation: hard-code zigPeriod = widthCm / 2 (ignore p.zigzags) -> 1 and 2 build the same.
check('zigzags 1 and 2 draw different patterns', !same(fill({ pileNoise: 0, zigzags: 1 }), fill({ pileNoise: 0, zigzags: 2 })));

// ---- 4. solid ------------------------------------------------------------------------------
// Mutation: ignore p.pattern (always chevron) -> more than one colour.
{
  const a = fill({ pattern: 'solid', pileNoise: 0 });
  const seen = new Set();
  for (let i = 0; i < a.length; i += 4) seen.add(key(a, i));
  check("'solid' with no noise is a single colour", seen.size === 1, [...seen].slice(0, 4));
  check("'solid' uses the first palette colour", seen.has(palette[0]), [...seen][0]);
}

// ---- 5. no DOM, no Math.random ---------------------------------------------------------------
// Mutation: add `document.createElement('canvas')` (or Math.random) to the module -> fails.
{
  const src = fs.readFileSync(path.join(root, 'src/rug-pattern.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const banned = ['document', 'window', 'navigator', 'HTMLCanvasElement', 'OffscreenCanvas', 'ImageData', 'Image(', 'Math.random', 'import '];
  const hits = banned.filter(b => src.indexOf(b) !== -1);
  check('module names no DOM global, no Math.random and imports nothing', hits.length === 0, hits);
  check('runs in Node with no DOM defined', typeof globalThis.document === 'undefined' && fill({}).length === W * H * 4);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
