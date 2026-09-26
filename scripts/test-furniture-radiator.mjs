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
 *   8. COVER ('none'|'shelf'|'box'): width/height/depth ALWAYS describe the
 *      radiator BODY; coverWidth/coverHeight/coverDepth (each independently
 *      optional, defaulting to a snug fit around the body) describe the
 *      cover's own, possibly LARGER, outer envelope. When a cover is
 *      present, the bbox-matches-params rule is checked against the cover's
 *      envelope, not the body's — the shelf spans exactly the cover's
 *      width/depth, and 'box' additionally encloses the sides at the
 *      cover's own size.
 *   9. FIX 444c3a1e: a 'box' cover has a solid backing panel directly
 *      behind its slats, so nothing rendered directly behind the slats'
 *      own Z (the fins, specifically) is visible through the airflow gaps
 *      — checked by casting rays through the actual slat gaps and asserting
 *      every hit is the backing, never a fin.
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
  check('PRESETS has 5 generic, publishable entries', Array.isArray(R.PRESETS) && R.PRESETS.length === 5 &&
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
  const midlineY = height * CM / 2;
  // FIX 6c92144b (test-oracle gap): the expected X SIGN is hard-coded here
  // per corner name, NOT derived from cornerPoint() itself — asserting a
  // module's output against that same module's own helper is a tautology
  // that cannot catch a bug in the helper's sign logic (e.g. 'left' and
  // 'right' swapped), since the same bug would then agree with itself on
  // both sides of the check.
  const expectedXSign = corner.endsWith('left') ? -1 : 1;

  check(`${corner}: smart valve X on the requested side`,
    Math.sign(sPos.x) === expectedXSign, { sPos, expectedXSign });
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

// ---- 9. COVER: width/height/depth are ALWAYS the body's; coverWidth/
// coverHeight/coverDepth (independently optional) are the cover's own,
// possibly larger, envelope — the bbox follows the cover when one exists.
{
  // 'none' -> no cover meshes at all, bbox matches the body directly.
  const gNone = R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10, cover: 'none' }, {});
  let hasCoverNone = false;
  gNone.traverse(o => { if (/^cover/.test(o.name)) hasCoverNone = true; });
  check('cover "none" adds no cover meshes', !hasCoverNone);

  // 'shelf' with NO coverWidth/coverHeight/coverDepth specified -> snug fit:
  // bbox width/depth match the BODY's width/depth, height gets +SHELF_T_CM.
  const shelfSnug = { width: 90, height: 70, depth: 12, thickness: 10, cover: 'shelf' };
  const gShelfSnug = R.build(THREE, shelfSnug, {});
  const bShelfSnug = bboxCm(gShelfSnug);
  check('shelf (snug): bbox width == body width within 0.5cm', Math.abs((bShelfSnug.maxX - bShelfSnug.minX) - shelfSnug.width) <= 0.5, bShelfSnug);
  check('shelf (snug): bbox height == body height + 2cm shelf within 0.5cm', Math.abs((bShelfSnug.maxY - bShelfSnug.minY) - (shelfSnug.height + 2)) <= 0.5, bShelfSnug);
  check('shelf (snug): bbox depth == body depth within 0.5cm', Math.abs((bShelfSnug.maxZ - bShelfSnug.minZ) - shelfSnug.depth) <= 0.5, bShelfSnug);
  let shelfMesh = null;
  gShelfSnug.traverse(o => { if (o.name === 'coverShelf') shelfMesh = o; });
  check('shelf mesh present', !!shelfMesh);
  if (shelfMesh) {
    gShelfSnug.updateMatrixWorld(true);
    const sb = new THREE.Box3().setFromObject(shelfMesh);
    check('shelf spans exactly the cover envelope width (within 0.5cm)', Math.abs((sb.max.x - sb.min.x) / CM - shelfSnug.width) <= 0.5, {
      shelfWidthCm: (sb.max.x - sb.min.x) / CM, expected: shelfSnug.width,
    });
  }
  let fascia = null;
  gShelfSnug.traverse(o => { if (o.name === 'coverFascia') fascia = o; });
  check('shelf has a downward fascia lip', !!fascia);
  check('shelf is NOT a full enclosure (no side/slat meshes)', (() => {
    let found = false;
    gShelfSnug.traverse(o => { if (/^coverSide|^coverSlat/.test(o.name)) found = true; });
    return !found;
  })());

  // 'box' with NO cover* overrides -> snug fit, bbox follows the body.
  const boxSnug = { width: 80, height: 65, depth: 12, thickness: 10, cover: 'box' };
  const gBoxSnug = R.build(THREE, boxSnug, {});
  const bBoxSnug = bboxCm(gBoxSnug);
  check('box (snug): bbox width == body width within 0.5cm', Math.abs((bBoxSnug.maxX - bBoxSnug.minX) - boxSnug.width) <= 0.5, bBoxSnug);
  check('box (snug): bbox height == body height + 2cm shelf within 0.5cm', Math.abs((bBoxSnug.maxY - bBoxSnug.minY) - (boxSnug.height + 2)) <= 0.5, bBoxSnug);
  check('box (snug): bbox depth == body depth within 0.5cm', Math.abs((bBoxSnug.maxZ - bBoxSnug.minZ) - boxSnug.depth) <= 0.5, bBoxSnug);
  let sideL = null, sideR = null, slats = 0;
  gBoxSnug.traverse(o => {
    if (o.name === 'coverSide_L') sideL = o;
    if (o.name === 'coverSide_R') sideR = o;
    if (/^coverSlat_/.test(o.name)) slats++;
  });
  check('box: both side panels present (full enclosure)', !!sideL && !!sideR);
  check('box: front has multiple slats', slats >= 4, slats);

  // ---- 9a. box cover LARGER than the radiator body (a real hallway cover):
  // a 50x60 radiator, depth 12 (wallGap 2), inside a 75w x 92h x 19-deep
  // slatted box. The bbox must follow the COVER's dimensions, not the
  // body's.
  const bigCoverParams = { width: 50, height: 60, depth: 12, thickness: 10, cover: 'box', coverWidth: 75, coverHeight: 92, coverDepth: 19 };
  const gBigCover = R.build(THREE, bigCoverParams, {});
  const bBigCover = bboxCm(gBigCover);
  check('larger cover: bbox width == coverWidth (75) within 0.5cm', Math.abs((bBigCover.maxX - bBigCover.minX) - 75) <= 0.5, bBigCover);
  check('larger cover: bbox height == coverHeight (92) within 0.5cm', Math.abs((bBigCover.maxY - bBigCover.minY) - 92) <= 0.5, bBigCover);
  check('larger cover: bbox depth == coverDepth (19) within 0.5cm', Math.abs((bBigCover.maxZ - bBigCover.minZ) - 19) <= 0.5, bBigCover);
  check('larger cover: bbox width is BIGGER than the body width (75 > 50)', (bBigCover.maxX - bBigCover.minX) > bigCoverParams.width + 5, bBigCover);
  // The radiator body itself is still modelled at its own (smaller) size,
  // centred inside the larger cover.
  let bigCoverPanel = null;
  gBigCover.traverse(o => { if (o.name === 'radiatorPanel') bigCoverPanel = o; });
  gBigCover.updateMatrixWorld(true);
  const bigCoverPanelBox = new THREE.Box3().setFromObject(bigCoverPanel);
  check('larger cover: the body panel itself stays at its OWN width (50), not the cover\'s',
    Math.abs((bigCoverPanelBox.max.x - bigCoverPanelBox.min.x) / CM - bigCoverParams.width) <= 0.5,
    { panelWidthCm: (bigCoverPanelBox.max.x - bigCoverPanelBox.min.x) / CM, expected: bigCoverParams.width });

  // Bigger envelope width -> bigger bbox width, with a cover present too.
  const gBoxBig = R.build(THREE, Object.assign({}, boxSnug, { coverWidth: 120 }), {});
  const bBoxBig = bboxCm(gBoxBig);
  check('box: wider coverWidth -> wider bbox', (bBoxBig.maxX - bBoxBig.minX) > (bBoxSnug.maxX - bBoxSnug.minX), { bBoxSnug, bBoxBig });

  // A cover value smaller than the body is clamped UP to the body's own
  // size (a cover cannot clip through its own radiator).
  const gClamped = R.build(THREE, Object.assign({}, boxSnug, { coverWidth: 10 }), {});
  const bClamped = bboxCm(gClamped);
  check('an undersized coverWidth is clamped up to the body width, never smaller',
    (bClamped.maxX - bClamped.minX) >= boxSnug.width - 0.5, bClamped);

  // ---- 9b. FIX 444c3a1e — nothing behind the slats is visible through the
  // airflow gaps: raycast straight through the middle of each gap (and each
  // slat) from in front of the cover, toward the wall, and check that the
  // FIRST thing hit behind the slat plane is the backing panel, never a fin.
  {
    const g = R.build(THREE, bigCoverParams, { detail: 'full' });
    g.updateMatrixWorld(true);
    let backing = null;
    const fins = [];
    g.traverse(o => {
      if (o.name === 'coverBacking') backing = o;
      if (/^radiatorFin_/.test(o.name)) fins.push(o);
    });
    check('backing panel present on a box cover', !!backing);
    check('radiator has fins to hide (sanity)', fins.length > 0, fins.length);

    // Sample straight down the gaps BETWEEN slats (not through a slat
    // itself) at mid-height, casting from just outside the cover face
    // (z beyond coverDepth) backward toward the wall (-z direction).
    const cov = R.coverEnvelope(Object.assign({}, R.DEFAULTS, bigCoverParams));
    const envW = cov.width * CM, envD = cov.depth * CM;
    const midY = (cov.height * CM) / 2;
    const raycaster = new THREE.Raycaster();
    const panelThick = 0.012, slatGap = 0.006;
    const usableW = envW - panelThick * 2;
    const slatCount = Math.max(6, Math.round(cov.width / 6));
    const slatW = Math.max(0.01, (usableW - slatGap * (slatCount - 1)) / slatCount);
    let gapSamples = 0, gapHitsFin = 0, gapHitsBacking = 0;
    for (let i = 0; i < slatCount - 1; i++) {
      const gapCenterX = -usableW / 2 + slatW + slatGap / 2 + i * (slatW + slatGap);
      const origin = new THREE.Vector3(gapCenterX, midY, envD + 0.05);
      raycaster.set(origin, new THREE.Vector3(0, 0, -1));
      const hits = raycaster.intersectObject(g, true);
      if (!hits.length) continue;
      gapSamples++;
      const hitName = hits[0].object.name;
      if (/^radiatorFin_/.test(hitName)) gapHitsFin++;
      if (hitName === 'coverBacking') gapHitsBacking++;
    }
    check('at least one gap sample actually hit something', gapSamples > 0, gapSamples);
    check('FIX 444c3a1e: no ray through a slat gap hits a fin', gapHitsFin === 0, { gapSamples, gapHitsFin });
    check('FIX 444c3a1e: every gap ray that hits anything hits the backing panel', gapHitsBacking === gapSamples, { gapSamples, gapHitsBacking });
  }
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
  const merged = Object.assign({}, R.DEFAULTS, preset.params);
  const expectedWidth = merged.cover !== 'none' ? R.coverEnvelope(merged).width : merged.width;
  check(`preset "${preset.name}": bbox width matches its own (cover-aware) width`, Math.abs((b.maxX - b.minX) - expectedWidth) <= 0.5, { b, expectedWidth });
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
