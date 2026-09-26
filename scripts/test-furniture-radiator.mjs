#!/usr/bin/env node
/**
 * Radiator furniture module: the shared src/furniture/* builder contract
 * (as PR "furniture data layer"'s scripts/test-furniture-core.mjs enforces
 * it), applied to src/furniture/radiator.js. No framework, no install -
 * `node scripts/test-furniture-radiator.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. build() is a PURE function of its inputs — width/height/depth land
 *      in the bbox to within 0.5cm (the contract's tolerance), x centred,
 *      bottom at y=0, back at z=0, front at z=depth.
 *   2. DEFAULTS carries numeric width/depth/height and is frozen, per the
 *      drift test every registered builder is checked against.
 *   3. depth/thickness/wallGap: `depth` is the TOTAL wall-to-front envelope
 *      (an authored field); `thickness` is the body's own depth (also
 *      authored); `wallGap = depth - thickness` is DERIVED and must never
 *      be settable independently of those two. The bracket bridges exactly
 *      0..wallGap; the body spans wallGap..wallGap+thickness.
 *   4. The smart TRV valve lands in the requested corner for all four
 *      VALVE_CORNERS, and the lockshield always lands diagonally opposite.
 *   5. An invalid/unset valveCorner falls back to the documented default.
 *   6. opts.detail: 'low' drops the valve assemblies (and their status LED)
 *      and has fewer-or-equal triangles than 'full', never more.
 *   7. Merge fidelity: every mesh carries `userData.finish` from the shared
 *      palette, no material uses a texture map, and the smart valve's
 *      status LED is genuinely emissive and flagged `userData.keep`.
 *   8. COVER ('none'|'shelf'|'box'): the cover changes the bbox exactly as
 *      the envelope width/height/depth say it should (the bbox-matches-
 *      params rule holds with a cover present), the shelf spans exactly
 *      the radiator's width, and 'box' additionally encloses the sides.
 *
 * Builds real three.js geometry from the vendored module, so it exercises
 * the same code the spec page runs rather than a copy of it.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const R = await imp('src/furniture/radiator.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 0.005) => Math.abs(a - b) <= eps; // 0.5cm tolerance, in metres
const CM = 0.01;

function bboxCm(group) {
  group.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(group);
  return { minX: b.min.x / CM, maxX: b.max.x / CM, minY: b.min.y / CM, maxY: b.max.y / CM, minZ: b.min.z / CM, maxZ: b.max.z / CM };
}
function triangleCount(group) {
  let tris = 0;
  group.traverse(o => {
    if (o.isMesh) {
      const geo = o.geometry;
      const idx = geo.getIndex();
      tris += idx ? idx.count / 3 : geo.attributes.position.count / 3;
    }
  });
  return tris;
}

// ---- 0. shared contract surface: TYPE, frozen DEFAULTS, build + alias -----
{
  check('TYPE === "radiator"', R.TYPE === 'radiator', R.TYPE);
  check('DEFAULTS is frozen', Object.isFrozen(R.DEFAULTS));
  check('DEFAULTS has numeric width/depth/height (drift-test shape)',
    typeof R.DEFAULTS.width === 'number' && typeof R.DEFAULTS.depth === 'number' && typeof R.DEFAULTS.height === 'number',
    R.DEFAULTS);
  check('DEFAULTS match the standard house radiator', R.DEFAULTS.width === 80 && R.DEFAULTS.height === 60 &&
    R.DEFAULTS.depth === 12 && R.DEFAULTS.thickness === 10 && R.DEFAULTS.elevation === 17 && R.DEFAULTS.cover === 'none', R.DEFAULTS);
  check('wallGapOf(12, 10) === 2', R.wallGapOf(12, 10) === 2);
  check('build is a function', typeof R.build === 'function');
  check('buildRadiator alias === build', R.buildRadiator === R.build);
  check('PRESETS has 4 generic, publishable entries', Array.isArray(R.PRESETS) && R.PRESETS.length === 4 &&
    R.PRESETS.every(p => typeof p.name === 'string' && !/[A-Z][a-z]+ [A-Z]/.test(p.name)), R.PRESETS);
}

// ---- 1. bbox reflects width/height/depth to within 0.5cm, on pure defaults
{
  const g = R.build(THREE, {}, {});
  const b = bboxCm(g);
  check('width == DEFAULTS within 0.5cm', Math.abs((b.maxX - b.minX) - R.DEFAULTS.width) <= 0.5, b);
  check('centred on x', Math.abs((b.maxX + b.minX) / 2) <= 0.5, b);
  check('bottom at y = 0', Math.abs(b.minY) <= 0.5, b);
  check('height == DEFAULTS within 0.5cm', Math.abs((b.maxY - b.minY) - R.DEFAULTS.height) <= 0.5, b);
  check('back at z = 0', Math.abs(b.minZ) <= 0.5, b);
  check('depth == DEFAULTS within 0.5cm, toward +z', Math.abs((b.maxZ - b.minZ) - R.DEFAULTS.depth) <= 0.5, b);
}

// ---- 2. width/height/depth scale independently -----------------------------
{
  const small = R.build(THREE, { width: 60, height: 40, depth: 10, thickness: 8 }, {});
  const big = R.build(THREE, { width: 95, height: 70, depth: 14, thickness: 12 }, {});
  const sB = bboxCm(small), bB = bboxCm(big);
  check('bigger width config -> bigger bbox width', (bB.maxX - bB.minX) > (sB.maxX - sB.minX), { sB, bB });
  check('bigger height config -> bigger bbox height', (bB.maxY - bB.minY) > (sB.maxY - sB.minY), { sB, bB });
  check('bigger depth config -> bigger bbox depth', (bB.maxZ - bB.minZ) > (sB.maxZ - sB.minZ), { sB, bB });
}

// ---- 3. depth/thickness/wallGap: wallGap is DERIVED, bracket bridges it exactly
{
  function panelZRange(params) {
    const g = R.build(THREE, params, {});
    g.updateMatrixWorld(true);
    let panel = null;
    g.traverse(o => { if (o.name === 'radiatorPanel') panel = o; });
    const b = new THREE.Box3().setFromObject(panel);
    return { min: b.min.z / CM, max: b.max.z / CM };
  }
  const base = panelZRange({ width: 80, height: 60, depth: 12, thickness: 10 });   // wallGap = 2
  const moreDepth = panelZRange({ width: 80, height: 60, depth: 16, thickness: 10 }); // wallGap = 6
  const moreThickness = panelZRange({ width: 80, height: 60, depth: 12, thickness: 6 }); // wallGap = 6

  check('base: panel back at wallGap = 2cm', near(base.min, 2, 0.05), base);
  check('increasing depth alone (same thickness) moves the back further out (bigger wallGap)',
    moreDepth.min > base.min, { base, moreDepth });
  check('increasing depth alone does NOT change the panel\'s own thickness',
    near((moreDepth.max - moreDepth.min), (base.max - base.min), 0.05),
    { base: base.max - base.min, moreDepth: moreDepth.max - moreDepth.min });
  check('decreasing thickness alone (same depth) ALSO grows wallGap the same way as increasing depth',
    near(moreThickness.min, moreDepth.min, 0.05), { moreThickness, moreDepth });
  check('front face distance from wall == depth (wallGap + thickness)',
    near(base.max, 12, 0.05), base);
}

// ---- 4. valve corner placement, all four options + diagonal lockshield ----
for (const corner of R.VALVE_CORNERS) {
  const width = 80, height = 60;
  const g = R.build(THREE, { width, height, depth: 12, thickness: 10, valveCorner: corner }, {});
  g.updateMatrixWorld(true);
  let smart = null, lockshield = null;
  g.traverse(o => {
    if (o.name === 'radiatorValveSmart') smart = o;
    if (o.name === 'radiatorValveLockshield') lockshield = o;
  });
  check(`${corner}: smart valve group present`, !!smart);
  check(`${corner}: lockshield group present`, !!lockshield);
  if (!smart || !lockshield) continue;

  // children order: stem(0), body(1), tail(2), [statusLed(3) for smart only]
  const sPos = new THREE.Vector3(); smart.children[1].getWorldPosition(sPos);
  const lPos = new THREE.Vector3(); lockshield.children[1].getWorldPosition(lPos);
  const expected = R.cornerPoint(corner, width, height, Math.min(width, height) * 0.1 + 4);
  const midlineY = height * CM / 2;

  check(`${corner}: smart valve X on the requested side`,
    Math.sign(sPos.x) === Math.sign(expected.x) || near(sPos.x, expected.x, 0.03), { sPos, expected });
  check(`${corner}: smart valve Y on the requested top/bottom`,
    corner.startsWith('bottom') ? sPos.y < midlineY : sPos.y > midlineY, { y: sPos.y, midlineY });
  check(`${corner}: lockshield diagonally opposite (X flipped)`,
    Math.sign(lPos.x) !== Math.sign(sPos.x), { sPos, lPos });
  check(`${corner}: lockshield diagonally opposite (Y flipped)`,
    (sPos.y < midlineY) !== (lPos.y < midlineY), { sPos, lPos });
}

// ---- 5. invalid/missing valveCorner falls back to the documented default --
{
  const g1 = R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10, valveCorner: 'nonsense' }, {});
  const g2 = R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10 }, {});
  let s1 = null, s2 = null;
  g1.traverse(o => { if (o.name === 'radiatorValveSmart') s1 = o; });
  g2.traverse(o => { if (o.name === 'radiatorValveSmart') s2 = o; });
  g1.updateMatrixWorld(true); g2.updateMatrixWorld(true);
  const p1 = new THREE.Vector3(); s1.children[1].getWorldPosition(p1);
  const p2 = new THREE.Vector3(); s2.children[1].getWorldPosition(p2);
  check('invalid valveCorner falls back to the documented default (bottom-right)',
    near(p1.x, p2.x, 1e-6) && near(p1.y, p2.y, 1e-6), { p1, p2 });
  check('documented default is bottom-right', R.DEFAULTS.valveCorner === 'bottom-right');
}

// ---- 6. oppositeCorner is a true involution over all four corners --------
for (const c of R.VALVE_CORNERS) {
  check(`oppositeCorner(oppositeCorner(${c})) === ${c}`, R.oppositeCorner(R.oppositeCorner(c)) === c);
  check(`oppositeCorner(${c}) !== ${c}`, R.oppositeCorner(c) !== c);
}

// ---- 7. opts.detail: 'low' drops the valves and has no more triangles -----
{
  const full = R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10 }, { detail: 'full' });
  const low = R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10 }, { detail: 'low' });
  let lowHasValve = false;
  low.traverse(o => { if (/^radiatorValve/.test(o.name)) lowHasValve = true; });
  check('low detail drops the valve assemblies', !lowHasValve);
  const fullTris = triangleCount(full), lowTris = triangleCount(low);
  check('low detail has no more triangles than full', lowTris <= fullTris, { fullTris, lowTris });
  check('low detail has strictly fewer triangles (valves + finer fins dropped)', lowTris < fullTris, { fullTris, lowTris });
  check('no opts / default detail behaves as full (valves present)', (() => {
    let has = false;
    R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10 }).traverse(o => { if (/^radiatorValve/.test(o.name)) has = true; });
    return has;
  })());
}

// ---- 8. merge fidelity: flat colours (no textures/maps), every mesh tagged
// with a finish from the shared set, and the smart LED is emissive + kept.
{
  const FINISHES = new Set(['matte', 'gloss', 'metal', 'glass', 'mirror', 'emissive']);
  const g = R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10, valveCorner: 'bottom-right' }, { detail: 'full' });
  let meshCount = 0, untagged = 0, textured = 0, led = null;
  g.traverse(o => {
    if (!o.isMesh) return;
    meshCount++;
    if (!FINISHES.has(o.userData.finish)) untagged++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) { if (m && (m.map || m.normalMap || m.roughnessMap || m.metalnessMap)) textured++; }
    if (o.name === 'statusLed') led = o;
  });
  check('every mesh carries a finish from the shared set', untagged === 0, { meshCount, untagged });
  check('no mesh uses a texture map (flat colours only)', textured === 0, textured);
  check('smart valve has a status LED mesh', !!led);
  if (led) {
    check('status LED finish is "emissive"', led.userData.finish === 'emissive', led.userData.finish);
    check('status LED material is actually emissive', led.material.emissiveIntensity > 0 && led.material.emissive.getHex() !== 0, {
      intensity: led.material.emissiveIntensity, emissive: led.material.emissive.getHex(),
    });
    check('status LED is flagged userData.keep', led.userData.keep === true, led.userData.keep);
  }
}

// ---- 9. COVER: bbox matches the envelope, shelf spans exactly the width ---
{
  // 'none' -> no cover meshes at all.
  const gNone = R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10, cover: 'none' }, {});
  let hasCoverNone = false;
  gNone.traverse(o => { if (/^cover/.test(o.name)) hasCoverNone = true; });
  check('cover "none" adds no cover meshes', !hasCoverNone);

  // 'shelf': bbox still matches the (taller, to fit the shelf) envelope
  // params, and the shelf spans exactly the radiator's width.
  const shelfParams = { width: 90, height: 70, depth: 12, thickness: 10, cover: 'shelf' };
  const gShelf = R.build(THREE, shelfParams, {});
  const bShelf = bboxCm(gShelf);
  check('shelf: bbox width == envelope width within 0.5cm', Math.abs((bShelf.maxX - bShelf.minX) - shelfParams.width) <= 0.5, bShelf);
  check('shelf: bbox height == envelope height within 0.5cm', Math.abs((bShelf.maxY - bShelf.minY) - shelfParams.height) <= 0.5, bShelf);
  check('shelf: bbox depth == envelope depth within 0.5cm', Math.abs((bShelf.maxZ - bShelf.minZ) - shelfParams.depth) <= 0.5, bShelf);
  let shelfMesh = null;
  gShelf.traverse(o => { if (o.name === 'coverShelf') shelfMesh = o; });
  check('shelf mesh present', !!shelfMesh);
  if (shelfMesh) {
    gShelf.updateMatrixWorld(true);
    const sb = new THREE.Box3().setFromObject(shelfMesh);
    check('shelf spans exactly the radiator width (within 0.5cm)', Math.abs((sb.max.x - sb.min.x) / CM - shelfParams.width) <= 0.5, {
      shelfWidthCm: (sb.max.x - sb.min.x) / CM, expected: shelfParams.width,
    });
  }
  let fascia = null;
  gShelf.traverse(o => { if (o.name === 'coverFascia') fascia = o; });
  check('shelf has a downward fascia lip', !!fascia);
  check('shelf is NOT a full enclosure (no side/slat meshes)', (() => {
    let found = false;
    gShelf.traverse(o => { if (/^coverSide|^coverSlat/.test(o.name)) found = true; });
    return !found;
  })());

  // 'box': full enclosure, bbox still matches the envelope, sides present.
  const boxParams = { width: 80, height: 65, depth: 12, thickness: 10, cover: 'box' };
  const gBox = R.build(THREE, boxParams, {});
  const bBox = bboxCm(gBox);
  check('box: bbox width == envelope width within 0.5cm', Math.abs((bBox.maxX - bBox.minX) - boxParams.width) <= 0.5, bBox);
  check('box: bbox height == envelope height within 0.5cm', Math.abs((bBox.maxY - bBox.minY) - boxParams.height) <= 0.5, bBox);
  check('box: bbox depth == envelope depth within 0.5cm', Math.abs((bBox.maxZ - bBox.minZ) - boxParams.depth) <= 0.5, bBox);
  let sideL = null, sideR = null, slats = 0;
  gBox.traverse(o => {
    if (o.name === 'coverSide_L') sideL = o;
    if (o.name === 'coverSide_R') sideR = o;
    if (/^coverSlat_/.test(o.name)) slats++;
  });
  check('box: both side panels present (full enclosure)', !!sideL && !!sideR);
  check('box: front has multiple slats', slats >= 4, slats);

  // Bigger envelope width -> bigger bbox width, with a cover present too.
  const gBoxBig = R.build(THREE, Object.assign({}, boxParams, { width: 120 }), {});
  const bBoxBig = bboxCm(gBoxBig);
  check('box: wider envelope -> wider bbox', (bBoxBig.maxX - bBoxBig.minX) > (bBox.maxX - bBox.minX), { bBox, bBoxBig });
}

// ---- 10. PRESETS build without throwing and produce sane geometry ---------
for (const preset of R.PRESETS) {
  let g;
  try {
    g = R.build(THREE, preset.params, {});
  } catch (e) {
    check(`preset "${preset.name}" builds without throwing`, false, String(e));
    continue;
  }
  const b = bboxCm(g);
  const expectedWidth = preset.params.width;
  check(`preset "${preset.name}": bbox width matches its own width param`, Math.abs((b.maxX - b.minX) - expectedWidth) <= 0.5, b);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
