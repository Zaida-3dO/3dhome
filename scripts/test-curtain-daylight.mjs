#!/usr/bin/env node
/**
 * Sun through the OPEN part of a curtain (src/sun-position.js
 * windowLightPieces / windowSegments / poolGainForFloor, fed by
 * src/wall-fittings.js curtainCoverIntervals). No framework, no install --
 * `node scripts/test-curtain-daylight.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. A centre-split blackout at 0 / 10 / 50 / 100 % open: no sun at 0, a
 *      sliver at 10 (a small fraction of the full pool, centred on the
 *      window), more at 50, nearly the whole window at 100 -- and the sliver
 *      is a projection along the sun, not a dimmed copy of the full pool.
 *   2. A one-side curtain (its fabric gathered to one end): the light comes
 *      in at the OPEN end.
 *   3. A sheer lets a dimmed, tinted full-window pool through; a sheer behind
 *      a 10 %-open blackout gives only the sheer-dimmed sliver.
 *   4. windowSegments (the sky pool's runs) follows the same openings.
 *   5. Tone-mapping headroom: a white floor's pooled value stays under the
 *      clip; a dark floor keeps the full gain.
 *   6. The scene re-cuts a window's pools when its curtain moves (curtainKey)
 *      and feeds each piece's transmission into its vertex colours.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const S = await imp('src/sun-position.js');
const F = await imp('src/wall-fittings.js');
const { windowLightPieces, windowSegments, intervalUnion, intervalComplement, polygonArea,
  poolGainForFloor, POOL_HEADROOM, FLOOR_DISPLAY_AT_WHITE, sunDirection, MIN_PIECE_TRANSMIT } = S;

// A south-wall window in plan cm: along-wall = x, the room is north (-z),
// room face at plan y = 0 -> world z = 0, outer face at y = 30 cm. World
// metres = cm / 100. Window 200 cm wide centred at x = 0, sill 10, top 210.
const toWorld = ([along, across]) => [along / 100, across / 100];
const faceRect = (lo, hi, across, y0, y1) => {
  const a = toWorld([lo, across]), b = toWorld([hi, across]);
  return [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]];
};
const WIN = { c: 0, w: 200 };
const base = {
  outer: faceRect(-100, 100, 30, 0.1, 2.1),
  inner: faceRect(-100, 100, 0, 0.1, 2.1),
  inward: [0, -1],
  room: [[-4, -5], [4, -5], [4, 0], [-4, 0]],
  toSun: sunDirection(180, 40, 0),
  rect: (lo, hi, across) => faceRect(lo, hi, across, 0, 2.5),
  span: [-1100, 1100]
};
const area = pieces => pieces.reduce((a, p) => a + polygonArea(p.poly), 0);
const lit = pieces => pieces.reduce((a, p) => a + polygonArea(p.poly) * p.transmit, 0);
const centroidX = pieces => {
  let a = 0, x = 0;
  pieces.forEach(p => { const ar = polygonArea(p.poly); a += ar; x += ar * p.poly.reduce((s, q) => s + q[0], 0) / p.poly.length; });
  return a ? x / a : NaN;
};
// A curtain as house-loader compiles it, hanging 12 cm into the room
// (plan y = -12), wider than the window as real ones are.
const curtain = (extra) => Object.assign({
  id: 'c', wallId: 1, c: 0, w: 260, sheer: false, opacity: 1, outerColor: 0x1f4d3f,
  outerPleats: 6, innerPleats: 2, stackWidth: null
}, extra || {});
const layerOf = (cu, pct, across) => ({
  covered: F.curtainCoverIntervals(cu, pct), across,
  transmit: F.curtainTransmit(cu),
  tint: cu.sheer ? (() => { const h = cu.outerColor, c = [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
    const m = Math.max(...c); return c.map(x => x / m); })() : [1, 1, 1]
});
const withLayers = layers => windowLightPieces(Object.assign({}, base, { layers }));

// ---- 1. centre-split blackout -------------------------------------------------
console.log('centre-split blackout');
const full = withLayers([]);
const fullA = area(full);
check('no curtain: one full pool', full.length === 1 && fullA > 1, fullA);
const bo = curtain();
const at = pct => withLayers([layerOf(bo, pct, -12)]);
const p0 = at(0), p10 = at(10), p50 = at(50), p100 = at(100);
check('0 % open: no sun at all (a blackout is dropped, not dimmed)', p0.length === 0, p0.length);
check('10 % open: a sliver -- some sun, under 20 % of the full pool', area(p10) > 0.01 && area(p10) < 0.2 * fullA, [area(p10), fullA]);
check('10 % open: every piece is the GAP at full strength, not a dimmed whole', p10.every(p => p.transmit === 1), p10.map(p => p.transmit));
check('10 % open: the sliver is centred (the halves part in the middle)', near(centroidX(p10), centroidX(full), 0.05), [centroidX(p10), centroidX(full)]);
check('50 % open: more than 10 %, less than 100 %', area(p50) > area(p10) * 2 && area(p50) < area(p100), [area(p10), area(p50), area(p100)]);
check('100 % open: nearly the whole pool (only the gathered stacks shade it)', area(p100) > 0.8 * fullA && area(p100) <= fullA + 1e-9, [area(p100), fullA]);
// A sliver is a projection: its long edges run along the sun's ground track
// (straight into the room for a southern sun), not a scaled-down copy of the
// full pool.
{
  const xs = p10.flatMap(p => p.poly.map(q => q[0])), zs = p10.flatMap(p => p.poly.map(q => q[1]));
  const fzs = full[0].poly.map(q => q[1]);
  check('10 % sliver reaches as deep into the room as the full pool', near(Math.min(...zs), Math.min(...fzs), 0.02), [Math.min(...zs), Math.min(...fzs)]);
  check('10 % sliver is narrow', Math.max(...xs) - Math.min(...xs) < 0.6, Math.max(...xs) - Math.min(...xs));
}
// The room still clips each piece: a 1 m deep room stops the sliver at its
// far wall.
{
  const shallow = windowLightPieces(Object.assign({}, base, { room: [[-4, -1], [4, -1], [4, 0], [-4, 0]], layers: [layerOf(bo, 10, -12)] }));
  const zs = shallow.flatMap(p => p.poly.map(q => q[1]));
  check('a shallow room clips the sliver at its far wall', shallow.length > 0 && Math.min(...zs) >= -1 - 1e-9, Math.min(...zs));
}
// Oblique sun: the gap sits 12 cm in front of the glass, so the sliver shifts
// sideways away from the sun, not straight in.
{
  const sw = windowLightPieces(Object.assign({}, base, { toSun: sunDirection(210, 35, 0), layers: [layerOf(bo, 10, -12)] }));
  check('oblique sun: the sliver shifts east, away from a south-west sun', sw.length > 0 && centroidX(sw) > 0.1, centroidX(sw));
}

// ---- 2. one-side curtain --------------------------------------------------------
console.log('one-side curtain');
{
  // Fabric drawn from the WEST end, as wide as the window: at openness f it
  // covers the west (1-f) of it.
  const oneSide = f => [{ covered: [[-100, -100 + 200 * (1 - f)]], across: -12, transmit: F.BLACKOUT_TRANSMIT, tint: [1, 1, 1] }];
  const q10 = withLayers(oneSide(0.1)), q50 = withLayers(oneSide(0.5));
  check('one-side 10 %: a sliver at the OPEN (east) end', q10.length > 0 && centroidX(q10) > 0.5, centroidX(q10));
  check('one-side 50 %: the east half lit, the west dark', centroidX(q50) > 0.2 && area(q50) < 0.7 * fullA, [centroidX(q50), area(q50)]);
  check('one-side: 10 % lets in less than 50 %', area(q10) < area(q50), [area(q10), area(q50)]);
}

// ---- 3. sheer ----------------------------------------------------------------
console.log('sheer');
{
  const sh = curtain({ id: 's', sheer: true, opacity: 0.4, outerColor: 0xd9b86a });
  const T = F.curtainTransmit(sh);
  const shut = withLayers([layerOf(sh, 0, -4)]);
  check('closed sheer: the full-window pool, dimmed to its transmission', near(area(shut), fullA, 0.02) && shut.every(p => near(p.transmit, T, 1e-9)), [area(shut), fullA, T]);
  check('closed sheer: tinted toward its colour (blue down)', shut.every(p => p.tint[2] < 0.7 && p.tint[0] === 1), shut.map(p => p.tint));
  const both = withLayers([layerOf(sh, 0, -4), layerOf(bo, 10, -12)]);
  check('sheer closed + blackout 10 %: only the sliver, at sheer strength', both.length > 0 && both.every(p => near(p.transmit, T, 1e-9)) &&
    area(both) < 0.2 * fullA, both.map(p => [p.transmit, polygonArea(p.poly)]));
  const sheerOpenBoHalf = withLayers([layerOf(sh, 100, -4), layerOf(bo, 50, -12)]);
  const fullStrength = sheerOpenBoHalf.filter(p => p.transmit === 1), dimmed = sheerOpenBoHalf.filter(p => p.transmit < 1);
  check('open sheer (gathered) + half-open blackout: the gap is full strength, the stacks behind the sheer dimmed',
    fullStrength.length > 0 && dimmed.every(p => p.transmit >= MIN_PIECE_TRANSMIT), sheerOpenBoHalf.map(p => p.transmit));
  check('light through a closed sheer < through the open window', lit(shut) < lit(full) * 0.5, [lit(shut), lit(full)]);
}

// ---- 4. sky-pool runs ----------------------------------------------------------
console.log('windowSegments');
{
  const segs = windowSegments(-100, 100, [layerOf(bo, 10, -12)]);
  check('10 % blackout: one run, in the middle, full strength', segs.length === 1 && segs[0].transmit === 1 &&
    near((segs[0].lo + segs[0].hi) / 2, 0, 1e-6) && segs[0].hi - segs[0].lo < 40, segs);
  check('closed blackout: no sky pool', windowSegments(-100, 100, [layerOf(bo, 0, -12)]).length === 0);
  check('open: one run, the whole window', (() => { const s = windowSegments(-100, 100, []); return s.length === 1 && s[0].lo === -100 && s[0].hi === 100; })());
  check('intervalUnion merges overlaps', JSON.stringify(intervalUnion([[5, 8], [0, 3], [2, 6]])) === '[[0,8]]', intervalUnion([[5, 8], [0, 3], [2, 6]]));
  check('intervalComplement', JSON.stringify(intervalComplement([[2, 4], [6, 7]], 0, 10)) === '[[0,2],[4,6],[7,10]]', intervalComplement([[2, 4], [6, 7]], 0, 10));
}

// ---- 5. headroom ----------------------------------------------------------------
console.log('tone-mapping headroom');
{
  const kWhite = poolGainForFloor(1.4, 1.0);
  check('white floor: pooled value stays under the clip', FLOOR_DISPLAY_AT_WHITE * (1 + kWhite) <= POOL_HEADROOM + 1e-9, [kWhite, FLOOR_DISPLAY_AT_WHITE * (1 + kWhite)]);
  check('white floor: still visibly brighter (gain >= 0.3)', kWhite >= 0.3, kWhite);
  check('dark floor keeps the full gain', poolGainForFloor(1.4, 0.3) === 1.4, poolGainForFloor(1.4, 0.3));
  check('mid floor lands in between', (() => { const k = poolGainForFloor(1.4, 0.8); return k > kWhite && k < 1.4; })(), poolGainForFloor(1.4, 0.8));
  check('colourBrightness: white 1, #808080 ~0.5', S.colourBrightness(0xffffff) === 1 && near(S.colourBrightness(0x808080), 0.502, 0.01));
}

// ---- 6. scene wiring ------------------------------------------------------------
console.log('scene wiring');
{
  const scene = read('src/home3d-scene.js');
  check('updateDaylight re-cuts only windows whose curtain moved', /if \(key !== e\.curtainKey\) moved\.add\(e\);/.test(scene) &&
    /if \(moved\.size\) updateDaylightPools\(moved\);/.test(scene));
  check('pieces carry their transmission into the vertex colours', /daylightSunColor, sunK \* pc\.transmit, pc\.tint/.test(scene) &&
    /daylightSkyColor, skyK \* sg\.transmit, sg\.tint/.test(scene));
  check('the sun gain is capped by the room floor', /poolGainForFloor\(DAYLIGHT_SUN_POOL_GAIN, e\.floorAlbedo\)/.test(scene));
}

// ---- 7. title contrast over the sky ------------------------------------------------
console.log('title contrast');
{
  // The brightest sky the scene ever clears to (linear, as scene.background
  // takes it), shown in sRGB; the title plate composited over it; WCAG
  // contrast of the title (white) and the hint against that.
  const html = read('index.html');
  const plate = /\.title-overlay \{[^}]*background: rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/.exec(html);
  const hint = /\.title-overlay p \{[^}]*color: rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/.exec(html);
  check('title plate and hint colour are declared', !!plate && !!hint);
  if (plate && hint) {
    const toS = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255;
    const lum = rgb => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
    const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    let worstTitle = Infinity, worstHint = Infinity;
    for (let el = -20; el <= 70; el += 1) {
      const sky = S.daylightCurve(el).background.map(toS);
      const a = +plate[4];
      const under = sky.map((c, i) => a * +plate[i + 1] + (1 - a) * c);
      const h = +hint[1];
      const hintRgb = under.map(c => h * 255 + (1 - h) * c);
      worstTitle = Math.min(worstTitle, cr([255, 255, 255], under));
      worstHint = Math.min(worstHint, cr(hintRgb, under));
    }
    check('title >= 4.5:1 over every sky the day produces', worstTitle >= 4.5, worstTitle.toFixed(2));
    check('hint >= 4.5:1 over every sky the day produces', worstHint >= 4.5, worstHint.toFixed(2));
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
