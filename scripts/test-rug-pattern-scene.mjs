#!/usr/bin/env node
/**
 * rooms[].rug.pattern: the path from a house profile to the rug the scene
 * draws. No framework, no install: `node scripts/test-rug-pattern-scene.mjs`.
 *
 * Each check names the source mutation that makes it fail:
 *
 *   1. rugPatternForBox lays the pattern out in PLAN orientation: a rug whose
 *      long side runs along plan y gets the pattern TRANSPOSED (its zig-zag
 *      runs down the long side), one whose long side runs along x does not.
 *   2. The rug's size comes from the box, never from params.widthCm/depthCm.
 *   3. house-loader passes only the overrides through, drops widthCm/depthCm
 *      and unknown keys with a warning, rejects an unknown pattern name, and
 *      makes a pattern win over a texture.
 *   4. houses/schema.json's `pattern` block names exactly the keys the
 *      loader accepts, and the same pattern names.
 *   5. The scene imports and uses the layout function (static check: the
 *      scene needs a DOM + WebGL, which this repo does not run headless).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const R = await imp('src/rug-pattern.js');
const { HouseLoader } = await imp('src/house-loader.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const quiet = fn => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---- 1. plan orientation ---------------------------------------------------------------
// A 150 (x) by 210 (y) rug: long side along plan y.
const LONG = 64;                                     // small, so the test is quick
const SHORT = Math.round(LONG * 150 / 210);
const direct = R.fillRugPattern(new Uint8ClampedArray(LONG * SHORT * 4), LONG, SHORT,
  { pileNoise: 0.25, widthCm: 210, depthCm: 150 });
{
  // Mutation: drop the transpose branch (return the pattern as drawn) ->
  // width/height swap back and the pixel comparison fails.
  const t = R.rugPatternForBox(150, 210, { pileNoise: 0.25 }, LONG);
  check('long side along y -> alongY', t.alongY === true, t.alongY);
  check('long side along y -> buffer is tall (width = short, height = long)',
    t.width === SHORT && t.height === LONG, [t.width, t.height]);
  // Mutation: swap i/o index roles in the transpose (row/col mixed up) -> fails.
  let ok = t.data.length === direct.length;
  for (let row = 0; ok && row < LONG; row++) {
    for (let col = 0; col < SHORT; col++) {
      const o = (row * SHORT + col) * 4, i = (col * LONG + row) * 4;
      if (t.data[o] !== direct[i] || t.data[o + 1] !== direct[i + 1] || t.data[o + 2] !== direct[i + 2]) { ok = false; break; }
    }
  }
  check('long side along y -> plan(x, y) is pattern(width = y, depth = x)', ok);
}
{
  // Mutation: invert the alongY test (sy < sx) -> this rug gets transposed.
  const t = R.rugPatternForBox(210, 150, { pileNoise: 0.25 }, LONG);
  check('long side along x -> not transposed', t.alongY === false && t.width === LONG && t.height === SHORT,
    [t.alongY, t.width, t.height]);
  check('long side along x -> bytes are the pattern exactly as drawn', same(t.data, direct));
}
{
  // Down the LONG side of a y-long rug the bands must zig AND zag: a row of
  // the pattern (its width) is now a column of the plan buffer.
  // Mutation: lay the width along the SHORT side (alongY computed backwards
  // but still transposing) -> the column no longer zig-zags.
  const t = R.rugPatternForBox(150, 210, { pileNoise: 0 }, 128);
  const pal = R.RUG_PATTERN_DEFAULTS.colors.map(h => R.hexToRgb(h).join(','));
  const idx = (x, y) => pal.indexOf([0, 1, 2].map(k => t.data[(y * t.width + x) * 4 + k]).join(','));
  const col = Math.floor(t.width / 2);
  let fwd = 0, back = 0, prev = idx(col, 0);
  for (let y = 1; y < t.height; y++) {
    const c = idx(col, y);
    if (c !== prev) { if (c === (prev + 1) % 3) fwd++; else back++; prev = c; }
  }
  check('a plan column of a y-long rug zig-zags (bands step both ways)', fwd > 0 && back > 0, { fwd, back });
}

// ---- 2. size comes from the box ----------------------------------------------------------
// Mutation: Object.assign({widthCm..}, params) (params win) -> the override leaks in.
{
  const a = R.rugPatternForBox(150, 210, { pileNoise: 0 }, LONG);
  const b = R.rugPatternForBox(150, 210, { pileNoise: 0, widthCm: 999, depthCm: 40 }, LONG);
  check('params.widthCm/depthCm cannot resize the pattern', same(a.data, b.data));
}
check('RUG_PATTERN_HOUSE_KEYS omits the size keys',
  !R.RUG_PATTERN_HOUSE_KEYS.includes('widthCm') && !R.RUG_PATTERN_HOUSE_KEYS.includes('depthCm') &&
  R.RUG_PATTERN_HOUSE_KEYS.includes('pileNoise') && R.RUG_PATTERN_HOUSE_KEYS.includes('colors'),
  R.RUG_PATTERN_HOUSE_KEYS);

// ---- 3. loader -----------------------------------------------------------------------------
function houseDoc(rug) {
  return {
    kind: 'geometry', schemaVersion: '1.1', id: 't', name: 't', units: 'cm',
    coordinateTransform: { originX: 0, originY: 0, scale: 0.01 },
    defaults: { wallHeight: 250, wallThickness: 10 },
    walls: { segments: [{ id: 1, start: [0, 0], end: [600, 0], exterior: true, thickness: 10 }] },
    rooms: [{ id: 'lounge', label: 'Lounge', polygon: [[0, 0], [600, 0], [600, 800], [0, 800]], rug }]
  };
}
const compile = rug => quiet(() => HouseLoader.compile(houseDoc(rug), 'houses/t/'));
{
  // Mutation: delete the `pattern: null` default -> undefined, not null.
  const h = compile({ polygon: [[100, 100], [250, 100], [250, 310], [100, 310]], color: '#b9b4ab' });
  check('no pattern -> rug.pattern is null (plain pile path)', h.rooms.lounge.rug.pattern === null, h.rooms.lounge.rug.pattern);
}
{
  // Mutation: copy rp wholesale (no key filter) -> widthCm and bogus survive.
  const h = compile({ polygon: [[100, 100], [250, 100], [250, 310], [100, 310]],
    pattern: { pileNoise: 0.25, widthCm: 5, bogus: 1 } });
  check('only real overrides pass through', JSON.stringify(h.rooms.lounge.rug.pattern) === '{"pileNoise":0.25}',
    h.rooms.lounge.rug.pattern);
  check('dropped keys are warned about',
    h.warnings.some(w => /"widthCm"/.test(w) && /polygon/.test(w)) && h.warnings.some(w => /"bogus"/.test(w)), h.warnings);
}
{
  // Mutation: drop the RUG_PATTERNS check -> 'plaid' reaches the scene.
  const h = compile({ inset: 20, pattern: { pattern: 'plaid', zigzags: 2 } });
  check('unknown pattern name is dropped (falls back to the default)',
    JSON.stringify(h.rooms.lounge.rug.pattern) === '{"zigzags":2}', h.rooms.lounge.rug.pattern);
}
{
  // Mutation: remove the `rug.textureUrl = null` line -> the photo loads over the pattern.
  const h = compile({ inset: 20, texture: { path: 'textures/rug.jpg' }, pattern: {} });
  check('pattern + texture -> texture ignored, pattern kept',
    h.rooms.lounge.rug.textureUrl === null && h.rooms.lounge.rug.pattern !== null, h.rooms.lounge.rug);
  const h2 = compile({ inset: 20, texture: { path: 'textures/rug.jpg' } });
  check('texture alone still loads', h2.rooms.lounge.rug.textureUrl === 'houses/t/textures/rug.jpg', h2.rooms.lounge.rug.textureUrl);
}

// ---- 4. schema drift -----------------------------------------------------------------------
{
  // Mutation: add a key to RUG_PATTERN_DEFAULTS without the schema (or vice versa) -> fails.
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'houses/schema.json'), 'utf8'));
  const find = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (o.rug && o.rug.properties && o.rug.properties.pattern) return o.rug.properties.pattern;
    for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
    return null;
  };
  const ps = find(schema);
  check('schema has rooms[].rug.pattern', !!ps);
  if (ps) {
    const keys = Object.keys(ps.properties).sort();
    check('schema pattern keys == RUG_PATTERN_HOUSE_KEYS', JSON.stringify(keys) === JSON.stringify([...R.RUG_PATTERN_HOUSE_KEYS].sort()),
      { schema: keys, module: R.RUG_PATTERN_HOUSE_KEYS });
    check('schema pattern enum == RUG_PATTERNS', JSON.stringify(ps.properties.pattern.enum) === JSON.stringify(R.RUG_PATTERNS));
    check('schema pattern block is closed', ps.additionalProperties === false);
  }
}

// ---- 5. scene wiring (static) --------------------------------------------------------------
{
  // Mutation: delete the import or the call -> fails. (What this cannot see is
  // whether the result looks right; the PR's screenshots are that evidence.)
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('scene imports rugPatternForBox', /import\s*\{\s*rugPatternForBox\s*\}\s*from\s*'\.\/rug-pattern\.js'/.test(src));
  check('scene builds the texture from rug.pattern over the rug bbox',
    /rugPatternTexture\(rug\.pattern,\s*_rb\.x2 - _rb\.x1,\s*_rb\.y2 - _rb\.y1\)/.test(src));
  check('scene caches pattern textures', /rugPatternCache\.get\(key\)/.test(src) && /rugPatternCache\.set\(key, tex\)/.test(src));
  check('scene marks the pattern texture sRGB', /rugPatternForBox[\s\S]{0,900}SRGBColorSpace/.test(src));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
