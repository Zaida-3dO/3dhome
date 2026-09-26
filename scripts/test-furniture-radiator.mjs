#!/usr/bin/env node
/**
 * Radiator furniture module: the shared src/furniture/* builder contract
 * (as scripts/test-furniture-core.mjs enforces it), applied to
 * src/furniture/radiator.js. No framework, no install -
 * `node scripts/test-furniture-radiator.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. build() is a PURE function of its inputs — width/height/depth land
 *      in the bbox to within 0.5cm (the contract's tolerance), x centred,
 *      bottom at y=0, back at z=0, front at z=depth.
 *   2. DEFAULTS carries numeric width/depth/height and is frozen, per the
 *      drift test every registered builder is checked against.
 *   3. CONTRACT RULING: width/height/depth are ALWAYS the OUTER ENVELOPE,
 *      including any cover — scripts/validate-house.py's footprint/
 *      overlap/ceiling checks and src/furniture/place.js both read these
 *      three params with no idea a "body vs cover" split exists, so a
 *      smaller number here than what actually gets built would validate a
 *      placement that then collides with a wall or another item in the
 *      live scene. bodyWidth/bodyHeight/bodyDepth (each independently
 *      optional, defaulting to a snug fit against the envelope) describe
 *      the RADIATOR BODY itself; a value bigger than its envelope
 *      counterpart is clamped DOWN. `thickness` is the body's own slab
 *      depth; wallGap = bodyDepth - thickness is DERIVED, never authored.
 *   4. The smart TRV valve lands in the requested corner for all four
 *      VALVE_CORNERS, and the lockshield always lands diagonally opposite
 *      — asserted against a HARD-CODED per-corner expectation, not against
 *      cornerPoint() itself (fix 6c92144b: a sign bug in that helper must
 *      not be able to agree with itself on both sides of the check).
 *   5. An invalid/unset valveCorner falls back to the documented default.
 *   6. opts.detail: 'low' drops the valve assemblies (and their status LED)
 *      and has fewer-or-equal triangles than 'full', never more.
 *   7. Merge fidelity: every mesh carries `userData.finish` from the shared
 *      palette, no material uses a texture map, and the smart valve's
 *      status LED is genuinely emissive and flagged `userData.keep`.
 *   8. COVER ('none'|'shelf'|'box'): the bbox is ALWAYS width/height/depth
 *      (the envelope), the shelf spans exactly the envelope's width/depth,
 *      and 'box' additionally encloses the sides at the envelope's size.
 *      A box cover ALWAYS clears the body by a real margin
 *      (COVER_CLEARANCE_CM) so its slats/backing can never land level with
 *      or behind the fins, however tight `depth`/`bodyDepth` are.
 *   9. FIX 444c3a1e, round 2: a 'box' cover has a solid backing panel
 *      clearly ahead of the fins, so nothing rendered directly behind the
 *      slats' own Z is visible through the airflow gaps — checked by
 *      casting rays through the actual slat gaps and asserting every hit
 *      is the backing, never a fin or the radiator panel, over EVERY box
 *      preset (not just one hand-picked case).
 *  10. Every PRESET builds without throwing and its bbox matches its own
 *      width/height/depth exactly, at BOTH 'full' and 'low' detail.
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
/** Every gap ray through a box cover's slats: returns { gapSamples, gapHitsFinOrPanel, gapHitsBacking }. */
function raycastSlatGaps(THREE, group, params) {
  const merged = Object.assign({}, R.DEFAULTS, params);
  const envW = merged.width * CM, envD = merged.depth * CM;
  const midY = (merged.height * CM) / 2;
  const panelThick = 0.012, slatGap = 0.006;
  const usableW = envW - panelThick * 2;
  const slatCount = Math.max(6, Math.round(merged.width / 6));
  const slatW = Math.max(0.01, (usableW - slatGap * (slatCount - 1)) / slatCount);
  const raycaster = new THREE.Raycaster();
  let gapSamples = 0, gapHitsFinOrPanel = 0, gapHitsBacking = 0;
  group.updateMatrixWorld(true);
  for (let i = 0; i < slatCount - 1; i++) {
    const gapCenterX = -usableW / 2 + slatW + slatGap / 2 + i * (slatW + slatGap);
    const origin = new THREE.Vector3(gapCenterX, midY, envD + 0.05);
    raycaster.set(origin, new THREE.Vector3(0, 0, -1));
    const hits = raycaster.intersectObject(group, true);
    if (!hits.length) continue;
    gapSamples++;
    const hitName = hits[0].object.name;
    if (/^radiatorFin_/.test(hitName) || hitName === 'radiatorPanel') gapHitsFinOrPanel++;
    if (hitName === 'coverBacking') gapHitsBacking++;
  }
  return { gapSamples, gapHitsFinOrPanel, gapHitsBacking };
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

// ---- 2. width/height/depth scale independently (no cover: body == envelope)
{
  const small = R.build(THREE, { width: 60, height: 40, depth: 10, thickness: 8 }, {});
  const big = R.build(THREE, { width: 95, height: 70, depth: 14, thickness: 12 }, {});
  const sB = bboxCm(small), bB = bboxCm(big);
  check('bigger width config -> bigger bbox width', (bB.maxX - bB.minX) > (sB.maxX - sB.minX), { sB, bB });
  check('bigger height config -> bigger bbox height', (bB.maxY - bB.minY) > (sB.maxY - sB.minY), { sB, bB });
  check('bigger depth config -> bigger bbox depth', (bB.maxZ - bB.minZ) > (sB.maxZ - sB.minZ), { sB, bB });
}

// ---- 3. CONTRACT: width/height/depth are the ENVELOPE, bodyWidth/Height/
// Depth are the body (clamped down, never bigger than the envelope), and
// wallGap = bodyDepth - thickness is derived.
{
  // With no cover and no body* overrides, body == envelope exactly (this is
  // the "no cover" contract requirement: DEFAULTS behaviour is unchanged).
  const gNoCover = R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10 }, {});
  let panelNoCover = null;
  gNoCover.traverse(o => { if (o.name === 'radiatorPanel') panelNoCover = o; });
  gNoCover.updateMatrixWorld(true);
  const pnc = new THREE.Box3().setFromObject(panelNoCover);
  check('no cover: body panel width == envelope width (no cover, no override)',
    near((pnc.max.x - pnc.min.x) / CM, 80, 0.5), (pnc.max.x - pnc.min.x) / CM);
  check('no cover: body panel height == envelope height (no cover, no override)',
    near((pnc.max.y - pnc.min.y) / CM, 60, 0.5), (pnc.max.y - pnc.min.y) / CM);

  // The CONTRACT VIOLATION this fixes: a hallway radiator (body 50x60x12)
  // inside a 75x92x19 cover must validate/place as 75x92x19 -- the bbox
  // must be the ENVELOPE regardless of the smaller body.
  const hallway = { width: 75, height: 92, depth: 19, cover: 'box', bodyWidth: 50, bodyHeight: 60, bodyDepth: 12, thickness: 10 };
  const gHallway = R.build(THREE, hallway, {});
  const bHallway = bboxCm(gHallway);
  check('hallway case: bbox width == envelope width (75), NOT the body (50)',
    Math.abs((bHallway.maxX - bHallway.minX) - 75) <= 0.5, bHallway);
  check('hallway case: bbox height == envelope height (92), NOT the body (60)',
    Math.abs((bHallway.maxY - bHallway.minY) - 92) <= 0.5, bHallway);
  check('hallway case: bbox depth == envelope depth (19), NOT the body (12)',
    Math.abs((bHallway.maxZ - bHallway.minZ) - 19) <= 0.5, bHallway);
  // The body itself is still modelled at its own (smaller) size.
  let hallwayPanel = null;
  gHallway.traverse(o => { if (o.name === 'radiatorPanel') hallwayPanel = o; });
  gHallway.updateMatrixWorld(true);
  const hpBox = new THREE.Box3().setFromObject(hallwayPanel);
  check('hallway case: the body panel itself stays at its OWN width (50)',
    Math.abs((hpBox.max.x - hpBox.min.x) / CM - 50) <= 0.5, (hpBox.max.x - hpBox.min.x) / CM);

  // A shelf preset built exactly against `height` (no bodyHeight override,
  // implying "shelf sits ON TOP of a body that fits inside"): the bbox
  // height must equal the ENVELOPE height, never taller (this is the exact
  // "62 tall against a 60 height" bug the ruling calls out).
  const shelfCase = { width: 90, height: 62, depth: 12, cover: 'shelf' };
  const gShelfCase = R.build(THREE, shelfCase, {});
  const bShelfCase = bboxCm(gShelfCase);
  check('shelf: bbox height == the declared envelope height (62) EXACTLY, never taller',
    Math.abs((bShelfCase.maxY - bShelfCase.minY) - 62) <= 0.5, bShelfCase);

  // bodyWidth/bodyHeight/bodyDepth bigger than the envelope are clamped DOWN.
  const gOversizedBody = R.build(THREE, { width: 80, height: 60, depth: 12, bodyWidth: 200, bodyHeight: 200, bodyDepth: 200 }, {});
  const bOversizedBody = bboxCm(gOversizedBody);
  check('an oversized bodyWidth/Height/Depth is clamped DOWN to the envelope, never bigger',
    Math.abs((bOversizedBody.maxX - bOversizedBody.minX) - 80) <= 0.5 &&
    Math.abs((bOversizedBody.maxY - bOversizedBody.minY) - 60) <= 0.5 &&
    Math.abs((bOversizedBody.maxZ - bOversizedBody.minZ) - 12) <= 0.5, bOversizedBody);

  // wallGap is derived from bodyDepth (not the envelope depth) and
  // thickness; bracket bridges exactly 0..wallGap.
  function panelZRange(params) {
    const g = R.build(THREE, params, {});
    g.updateMatrixWorld(true);
    let panel = null;
    g.traverse(o => { if (o.name === 'radiatorPanel') panel = o; });
    const b = new THREE.Box3().setFromObject(panel);
    return { min: b.min.z / CM, max: b.max.z / CM };
  }
  const base = panelZRange({ width: 80, height: 60, depth: 12, bodyDepth: 12, thickness: 10 }); // wallGap = 2
  const moreBodyDepth = panelZRange({ width: 80, height: 60, depth: 20, bodyDepth: 16, thickness: 10 }); // wallGap = 6
  const lessThickness = panelZRange({ width: 80, height: 60, depth: 20, bodyDepth: 12, thickness: 6 }); // wallGap = 6

  check('base: panel back at wallGap = 2cm', near(base.min, 2, 0.05), base);
  check('increasing bodyDepth alone (same thickness) moves the back further out (bigger wallGap)',
    moreBodyDepth.min > base.min, { base, moreBodyDepth });
  check('decreasing thickness alone (same bodyDepth) ALSO grows wallGap the same way as increasing bodyDepth',
    near(lessThickness.min, moreBodyDepth.min, 0.05), { lessThickness, moreBodyDepth });
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

// ---- 9. COVER: bbox is ALWAYS width/height/depth (the envelope); shelf
// spans the envelope; box encloses the sides at the envelope's size.
{
  // 'none' -> no cover meshes at all.
  const gNone = R.build(THREE, { width: 80, height: 60, depth: 12, thickness: 10, cover: 'none' }, {});
  let hasCoverNone = false;
  gNone.traverse(o => { if (/^cover/.test(o.name)) hasCoverNone = true; });
  check('cover "none" adds no cover meshes', !hasCoverNone);

  // 'shelf': bbox matches the DECLARED width/height/depth exactly (no body*
  // overrides -> a snug-fitting body inside).
  const shelfParams = { width: 90, height: 72, depth: 12, cover: 'shelf' };
  const gShelf = R.build(THREE, shelfParams, {});
  const bShelf = bboxCm(gShelf);
  check('shelf: bbox width == declared width within 0.5cm', Math.abs((bShelf.maxX - bShelf.minX) - shelfParams.width) <= 0.5, bShelf);
  check('shelf: bbox height == declared height within 0.5cm', Math.abs((bShelf.maxY - bShelf.minY) - shelfParams.height) <= 0.5, bShelf);
  check('shelf: bbox depth == declared depth within 0.5cm', Math.abs((bShelf.maxZ - bShelf.minZ) - shelfParams.depth) <= 0.5, bShelf);
  let shelfMesh = null;
  gShelf.traverse(o => { if (o.name === 'coverShelf') shelfMesh = o; });
  check('shelf mesh present', !!shelfMesh);
  if (shelfMesh) {
    gShelf.updateMatrixWorld(true);
    const sb = new THREE.Box3().setFromObject(shelfMesh);
    check('shelf spans exactly the declared width (within 0.5cm)', Math.abs((sb.max.x - sb.min.x) / CM - shelfParams.width) <= 0.5, {
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

  // 'box': full enclosure, bbox still matches the declared envelope, sides
  // present.
  const boxParams = { width: 80, height: 66, depth: 16, cover: 'box' };
  const gBox = R.build(THREE, boxParams, {});
  const bBox = bboxCm(gBox);
  check('box: bbox width == declared width within 0.5cm', Math.abs((bBox.maxX - bBox.minX) - boxParams.width) <= 0.5, bBox);
  check('box: bbox height == declared height within 0.5cm', Math.abs((bBox.maxY - bBox.minY) - boxParams.height) <= 0.5, bBox);
  check('box: bbox depth == declared depth within 0.5cm', Math.abs((bBox.maxZ - bBox.minZ) - boxParams.depth) <= 0.5, bBox);
  let sideL = null, sideR = null, slats = 0;
  gBox.traverse(o => {
    if (o.name === 'coverSide_L') sideL = o;
    if (o.name === 'coverSide_R') sideR = o;
    if (/^coverSlat_/.test(o.name)) slats++;
  });
  check('box: both side panels present (full enclosure)', !!sideL && !!sideR);
  check('box: front has multiple slats', slats >= 4, slats);

  // Bigger declared width -> bigger bbox width, with a cover present too.
  const gBoxBig = R.build(THREE, Object.assign({}, boxParams, { width: 120 }), {});
  const bBoxBig = bboxCm(gBoxBig);
  check('box: wider declared width -> wider bbox', (bBoxBig.maxX - bBoxBig.minX) > (bBox.maxX - bBox.minX), { bBox, bBoxBig });

  // A box's interior ALWAYS clears the body by a real margin (>=~3cm),
  // even when depth/bodyDepth would otherwise leave the body flush with
  // the slats/backing.
  const tight = { width: 80, height: 60, depth: 12, bodyDepth: 12, thickness: 10, cover: 'box' }; // depth == bodyDepth: no room unless clamped
  const gTight = R.build(THREE, tight, {});
  gTight.updateMatrixWorld(true);
  let tightPanel = null, tightBacking = null;
  gTight.traverse(o => { if (o.name === 'radiatorPanel') tightPanel = o; if (o.name === 'coverBacking') tightBacking = o; });
  const tpBox = new THREE.Box3().setFromObject(tightPanel);
  const tbBox = new THREE.Box3().setFromObject(tightBacking);
  check('a box cover clears the body by a real margin even when depth == bodyDepth was requested',
    (tbBox.min.z - tpBox.max.z) / CM >= 2.5, { panelFrontCm: tpBox.max.z / CM, backingBackCm: tbBox.min.z / CM });
}

// ---- 10. FIX 444c3a1e, round 2 — no fin/panel visible through ANY box
// cover's slat gaps (not just one hand-picked case): raycast every box
// preset AND a synthetic snug-fit case.
{
  const boxCases = [
    { name: '80 wide, full slatted cover (default depths)', params: { width: 80, height: 62, depth: 16, cover: 'box' } },
    { name: 'snug body == envelope depth (no bodyDepth override)', params: { width: 80, height: 60, depth: 12, cover: 'box' } },
    { name: 'hallway: 50 body in 75x92x19 cover', params: { width: 75, height: 92, depth: 19, cover: 'box', bodyWidth: 50, bodyHeight: 60, bodyDepth: 12, thickness: 10 } },
  ].concat(R.PRESETS.filter(p => p.params.cover === 'box').map(p => ({ name: 'preset: ' + p.name, params: p.params })));

  for (const { name, params } of boxCases) {
    const g = R.build(THREE, params, { detail: 'full' });
    let backing = null, fins = 0;
    g.traverse(o => { if (o.name === 'coverBacking') backing = o; if (/^radiatorFin_/.test(o.name)) fins++; });
    check(`${name}: backing panel present`, !!backing);
    check(`${name}: radiator has fins to hide (sanity)`, fins > 0, fins);

    const { gapSamples, gapHitsFinOrPanel, gapHitsBacking } = raycastSlatGaps(THREE, g, params);
    check(`${name}: at least one gap sample hit something`, gapSamples > 0, gapSamples);
    check(`${name}: no ray through a slat gap hits a fin or the radiator panel`, gapHitsFinOrPanel === 0, { gapSamples, gapHitsFinOrPanel });
    check(`${name}: every gap ray that hits anything hits the backing panel`, gapHitsBacking === gapSamples, { gapSamples, gapHitsBacking });
  }
}

// ---- 11. PRESETS build without throwing, bbox matches their OWN
// width/height/depth EXACTLY, at both 'full' and 'low' detail.
for (const preset of R.PRESETS) {
  for (const detail of ['full', 'low']) {
    let g;
    try {
      g = R.build(THREE, preset.params, { detail });
    } catch (e) {
      check(`preset "${preset.name}" (${detail}) builds without throwing`, false, String(e));
      continue;
    }
    const b = bboxCm(g);
    const merged = Object.assign({}, R.DEFAULTS, preset.params);
    check(`preset "${preset.name}" (${detail}): bbox width matches its own width param`, Math.abs((b.maxX - b.minX) - merged.width) <= 0.5, { b, expected: merged.width });
    check(`preset "${preset.name}" (${detail}): bbox height matches its own height param`, Math.abs((b.maxY - b.minY) - merged.height) <= 0.5, { b, expected: merged.height });
    check(`preset "${preset.name}" (${detail}): bbox depth matches its own depth param`, Math.abs((b.maxZ - b.minZ) - merged.depth) <= 0.5, { b, expected: merged.depth });
  }
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
