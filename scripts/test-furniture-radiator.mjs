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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const R = await imp('src/furniture/radiator.js');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'houses/schema.json'), 'utf8'));

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
    R.DEFAULTS.depth === 12 && R.DEFAULTS.thickness === 10 && R.DEFAULTS.cover === 'none', R.DEFAULTS);
  check('wallGapOf(12, 10) === 2', R.wallGapOf(12, 10) === 2);
  check('build is a function', typeof R.build === 'function');
  check('buildRadiator alias === build', R.buildRadiator === R.build);
  check('PRESETS has 5 generic, publishable entries', Array.isArray(R.PRESETS) && R.PRESETS.length === 5 &&
    R.PRESETS.every(p => typeof p.name === 'string' && !/[A-Z][a-z]+ [A-Z]/.test(p.name)), R.PRESETS);

  // FIX 2bc314c9 (option a): params.elevation was DEAD -- nothing in the
  // loader/placer/validator ever read it, so its documented default of 17
  // was never applied. Removed rather than wired up, since every other
  // furniture type uses only the item-level `elevation` field. Assert both
  // sides of the removal: DEFAULTS carries no elevation key, and the
  // schema's own furnitureParams_radiator block carries no elevation
  // property either -- if either one silently grew it back, this fails.
  check('DEFAULTS has no elevation key (removed -- dead param, use the item-level field)',
    !Object.prototype.hasOwnProperty.call(R.DEFAULTS, 'elevation'), R.DEFAULTS);
  const radiatorSchema = schema.$defs && schema.$defs.furnitureParams_radiator;
  check('schema furnitureParams_radiator exists', !!radiatorSchema);
  if (radiatorSchema) {
    check('schema furnitureParams_radiator has no elevation property (removed -- dead param, use the item-level field)',
      !radiatorSchema.properties || !Object.prototype.hasOwnProperty.call(radiatorSchema.properties, 'elevation'),
      radiatorSchema.properties && Object.keys(radiatorSchema.properties));
  }
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

  // INFO (round-4 nit, d9fb9d55 item 8): when the derived wallGap is under
  // 0.4cm, the bracket must NEVER extend past the panel's own back face —
  // a fixed 0.4cm minimum bracket depth used to overshoot a tight gap and
  // pierce the panel. Force depth == thickness (wallGap == 0) to exercise
  // the tightest case.
  function bracketZRange(params) {
    const g = R.build(THREE, params, {});
    g.updateMatrixWorld(true);
    let bracket = null;
    g.traverse(o => { if (o.name === 'radiatorBracket_L') bracket = o; });
    const b = new THREE.Box3().setFromObject(bracket);
    return { min: b.min.z / CM, max: b.max.z / CM };
  }
  const tightGapParams = { width: 80, height: 60, depth: 12, bodyDepth: 12, thickness: 12 }; // wallGap = 0
  const tightBracket = bracketZRange(tightGapParams);
  const tightPanel = panelZRange(tightGapParams);
  check('bracket never extends past the panel\'s own back face, even at wallGap = 0',
    tightBracket.max <= tightPanel.min + 0.01, { tightBracket, tightPanel });
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
  let fascia = null, shelfPanel = null;
  gShelf.traverse(o => { if (o.name === 'coverFascia') fascia = o; if (o.name === 'radiatorPanel') shelfPanel = o; });
  check('shelf has a downward fascia lip', !!fascia);
  check('shelf is NOT a full enclosure (no side/slat meshes)', (() => {
    let found = false;
    gShelf.traverse(o => { if (/^coverSide|^coverSlat/.test(o.name)) found = true; });
    return !found;
  })());
  // The fascia lip must hang measurably IN FRONT of the body's own front
  // face, never buried behind it — otherwise the lip is invisible (the
  // exact "shelf has lost its lip" regression from round 3).
  if (fascia && shelfPanel) {
    const fasciaBox = new THREE.Box3().setFromObject(fascia);
    const panelBox = new THREE.Box3().setFromObject(shelfPanel);
    check('shelf: fascia lip front face sits measurably AHEAD of the body\'s own front face',
      (fasciaBox.max.z - panelBox.max.z) / CM > 0.5,
      { fasciaFrontCm: fasciaBox.max.z / CM, panelFrontCm: panelBox.max.z / CM });
  }

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

// ---- 9a. MEDIUM (round 3): the body must sit STRICTLY INSIDE the cover's
// own inner volume — never coplanar with, let alone through, the shelf
// underside, the side panels, or the fascia/backing plane. Round 2 asked
// for exactly this ("bodyHeight should default to height - 2 when there is
// a cover") and it was never actually enforced in bodyEnvelope(); this is
// the sweep the round-3 review asked for: every cover preset, plus a width
// sweep with the snug (all-default) body, at both 'full' and 'low' detail.
{
  function panelWorldBox(g) {
    g.updateMatrixWorld(true);
    let panel = null;
    g.traverse(o => { if (o.name === 'radiatorPanel') panel = o; });
    return panel && new THREE.Box3().setFromObject(panel);
  }

  // Every cover preset, at both detail levels: the body panel's own world
  // bbox must sit strictly inside (a) the shelf's underside, in Y and (b),
  // for a box, inside the side panels in X and behind the backing in Z.
  const coverPresets = R.PRESETS.filter(p => p.params.cover !== 'none');
  check('at least one preset actually exercises a cover (sanity)', coverPresets.length > 0, coverPresets.length);
  for (const preset of coverPresets) {
    for (const detail of ['full', 'low']) {
      const g = R.build(THREE, preset.params, { detail });
      const panelBox = panelWorldBox(g);
      check(`${preset.name} (${detail}): body panel exists`, !!panelBox);
      if (!panelBox) continue;

      let shelfMesh = null, sideL = null, sideR = null, backing = null;
      g.traverse(o => {
        if (o.name === 'coverShelf') shelfMesh = o;
        if (o.name === 'coverSide_L') sideL = o;
        if (o.name === 'coverSide_R') sideR = o;
        if (o.name === 'coverBacking') backing = o;
      });
      if (shelfMesh) {
        const shelfBox = new THREE.Box3().setFromObject(shelfMesh);
        check(`${preset.name} (${detail}): body top is STRICTLY below the shelf underside (no coplanar/through)`,
          panelBox.max.y < shelfBox.min.y - 1e-6, { panelTop: panelBox.max.y, shelfBottom: shelfBox.min.y });
      }
      if (sideL && sideR) {
        const slBox = new THREE.Box3().setFromObject(sideL);
        const srBox = new THREE.Box3().setFromObject(sideR);
        check(`${preset.name} (${detail}): body is STRICTLY inside both side panels in X`,
          panelBox.min.x > slBox.max.x + 1e-6 && panelBox.max.x < srBox.min.x - 1e-6,
          { panelMin: panelBox.min.x, panelMax: panelBox.max.x, sideLMax: slBox.max.x, sideRMin: srBox.min.x });
      }
      if (backing) {
        const bkBox = new THREE.Box3().setFromObject(backing);
        check(`${preset.name} (${detail}): body front is STRICTLY behind the backing's own back face`,
          panelBox.max.z < bkBox.min.z - 1e-6, { panelFront: panelBox.max.z, backingBack: bkBox.min.z });
      }
    }
  }

  // A width sweep with the SNUG (all-default body) case for both cover
  // kinds — the exact regression named in the round-3 review: with no
  // explicit bodyWidth/bodyHeight, the body must still land inside.
  for (const cover of ['shelf', 'box']) {
    for (const width of [40, 60, 80, 100, 140]) {
      const params = { width, height: 62, depth: cover === 'box' ? 16 : 12, cover };
      const g = R.build(THREE, params, {});
      const panelBox = panelWorldBox(g);
      let shelfMesh = null, sideL = null, sideR = null;
      g.traverse(o => {
        if (o.name === 'coverShelf') shelfMesh = o;
        if (o.name === 'coverSide_L') sideL = o;
        if (o.name === 'coverSide_R') sideR = o;
      });
      if (shelfMesh) {
        const shelfBox = new THREE.Box3().setFromObject(shelfMesh);
        check(`snug ${cover} width=${width}: body strictly below the shelf`, panelBox.max.y < shelfBox.min.y - 1e-6,
          { panelTop: panelBox.max.y, shelfBottom: shelfBox.min.y });
      }
      if (sideL && sideR) {
        const slBox = new THREE.Box3().setFromObject(sideL);
        const srBox = new THREE.Box3().setFromObject(sideR);
        check(`snug ${cover} width=${width}: body strictly inside the side panels`,
          panelBox.min.x > slBox.max.x + 1e-6 && panelBox.max.x < srBox.min.x - 1e-6);
      }
    }
  }

  // At DEFAULTS (no cover params passed at all) plus cover:'shelf'/'box':
  // the exact "shelf built 62 tall against a 60 height" style regression.
  for (const cover of ['shelf', 'box']) {
    const g = R.build(THREE, { cover }, {});
    const panelBox = panelWorldBox(g);
    let shelfMesh = null;
    g.traverse(o => { if (o.name === 'coverShelf') shelfMesh = o; });
    const shelfBox = new THREE.Box3().setFromObject(shelfMesh);
    check(`DEFAULTS + cover:'${cover}': body strictly below the shelf, no explicit body params needed`,
      panelBox.max.y < shelfBox.min.y - 1e-6, { panelTop: panelBox.max.y, shelfBottom: shelfBox.min.y });
  }
}

// ---- 9b. LOW (round 3): guard the two round-2 fixes that mutation testing
// found were NOT actually covered — a fascia setback of 0 must be
// detectable, and a shelf sized to the body (instead of the envelope) must
// be detectable.
{
  // The fascia lip's own front face must sit measurably behind the
  // envelope's own front face (z=depth) — if the "setback" were ever
  // reverted to 0, this specific check is what must fail.
  const params = { width: 80, height: 62, depth: 12, cover: 'shelf' };
  const g = R.build(THREE, params, {});
  g.updateMatrixWorld(true);
  let fascia = null;
  g.traverse(o => { if (o.name === 'coverFascia') fascia = o; });
  const fBox = new THREE.Box3().setFromObject(fascia);
  const envFrontZ = params.depth * CM;
  check('fascia front face sits measurably BEHIND the envelope front face (setback > 0, catches setback=0)',
    (envFrontZ - fBox.max.z) > 0.001, { fasciaFrontCm: fBox.max.z / CM, envelopeFrontCm: envFrontZ / CM });

  // The shelf must span the ENVELOPE's own width, not the body's — on a
  // preset where body width is explicitly smaller than the envelope, a
  // shelf sized to the body (a regression) would be narrower than this.
  const hallway = { width: 75, height: 92, depth: 19, cover: 'box', bodyWidth: 50, bodyHeight: 60, bodyDepth: 12, thickness: 10 };
  const gHall = R.build(THREE, hallway, {});
  gHall.updateMatrixWorld(true);
  let hallShelf = null;
  gHall.traverse(o => { if (o.name === 'coverShelf') hallShelf = o; });
  const hsBox = new THREE.Box3().setFromObject(hallShelf);
  check('shelf spans the ENVELOPE width (75), not the smaller body width (50) — catches "shelf sized to body"',
    Math.abs((hsBox.max.x - hsBox.min.x) / CM - 75) <= 0.5 && (hsBox.max.x - hsBox.min.x) / CM > 60,
    { shelfWidthCm: (hsBox.max.x - hsBox.min.x) / CM });
}

// ---- 9c. LOW (follow-up d9fb9d55, nit 3): three more round-4 fixes that
// mutation testing showed survived with 187/187 still passing — each of
// these asserts a real geometric relationship that the named mutation would
// break, rather than re-deriving the mutated value from the same formula.
{
  // (i) The valve assemblies' depth ceiling must be the box BACKING's inner
  // face, not the outer envelope (ENV_D) — reverting that fix would let a
  // valve on a box cover pierce the backing. Assert the valve's outermost
  // point (the tail's far face, its own position plus radius) sits at or
  // before the backing's own inner face.
  {
    const params = { width: 80, height: 62, depth: 16, cover: 'box', valveCorner: 'bottom-right' };
    const g = R.build(THREE, params, { detail: 'full' });
    g.updateMatrixWorld(true);
    let smartValve = null, backing = null;
    g.traverse(o => {
      if (o.name === 'radiatorValveSmart') smartValve = o;
      if (o.name === 'coverBacking') backing = o;
    });
    check('box cover: smart valve group present (sanity)', !!smartValve);
    check('box cover: backing present (sanity)', !!backing);
    if (smartValve && backing) {
      const backingBox = new THREE.Box3().setFromObject(backing);
      let valveMaxZ = -Infinity;
      smartValve.traverse(o => {
        if (!o.isMesh) return;
        const b = new THREE.Box3().setFromObject(o);
        if (b.max.z > valveMaxZ) valveMaxZ = b.max.z;
      });
      check('box cover: valve assembly max Z is AT OR BEFORE the backing panel\'s own inner (back) face — never pierces it',
        valveMaxZ <= backingBox.min.z + 1e-6, { valveMaxZ, backingInnerFace: backingBox.min.z });
    }
  }

  // (ii) The "explicit body params are clamped the same way the snug
  // default is" requirement (round 3) must hold even for an EXPLICIT,
  // oversized bodyHeight on a cover — not just the snug/omitted case
  // already covered by the width sweep above. Reverting the clamp to skip
  // when bodyHeight is explicit would let this specific case pierce the
  // shelf.
  {
    const params = { width: 80, height: 62, depth: 12, cover: 'shelf', bodyHeight: 200 };
    const g = R.build(THREE, params, {});
    g.updateMatrixWorld(true);
    let panel = null, shelfMesh = null;
    g.traverse(o => { if (o.name === 'radiatorPanel') panel = o; if (o.name === 'coverShelf') shelfMesh = o; });
    const panelBox = new THREE.Box3().setFromObject(panel);
    const shelfBox = new THREE.Box3().setFromObject(shelfMesh);
    check('an EXPLICIT oversized bodyHeight (200) on a shelf cover is clamped identically to the snug default — body stays strictly below the shelf',
      panelBox.max.y < shelfBox.min.y - 1e-6, { panelTop: panelBox.max.y, shelfBottom: shelfBox.min.y });
  }

  // (iii) The shelf's FASCIA_CLEARANCE_CM must be its full, correctly-
  // derived value (1.5 + FASCIA_SETBACK_CM = 1.9), not a shrunk value like
  // 1.1 that would let the body's front face creep past the lip's own back
  // face. Assert the actual geometric relationship (panel front strictly
  // behind the lip's own back face) rather than re-deriving the constant.
  {
    const params = { width: 80, height: 62, depth: 12, cover: 'shelf' };
    const g = R.build(THREE, params, {});
    g.updateMatrixWorld(true);
    let panel = null, fascia = null;
    g.traverse(o => { if (o.name === 'radiatorPanel') panel = o; if (o.name === 'coverFascia') fascia = o; });
    const panelBox = new THREE.Box3().setFromObject(panel);
    const fasciaBox = new THREE.Box3().setFromObject(fascia);
    check('shelf: body panel front face sits STRICTLY BEHIND the fascia lip\'s own back face (catches a shrunk clearance constant)',
      panelBox.max.z < fasciaBox.min.z - 1e-6, { panelFront: panelBox.max.z, fasciaBack: fasciaBox.min.z });
  }
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
