#!/usr/bin/env node
/**
 * Wall decor (framed sign + wall sconce, both kinds): builder-contract tests.
 * No framework, no install - `node scripts/test-wall-decor.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. Builder contract compliance (plan artifact 029b34e0 on item 78f2b614,
 *      as amended by the furniture-data-layer drift test on branch
 *      feat/furniture-data-layer): DEFAULTS (and wall-sconce's
 *      UP_DOWN_DEFAULTS) are frozen and carry numeric width/height/depth;
 *      y=0 is the lowest point; the assembly's back sits at z=0; and the
 *      bbox matches DEFAULTS width/height/depth within 0.5 cm -- the same
 *      tolerance scripts/test-furniture-core.mjs (branch
 *      feat/furniture-data-layer) checks every registered builder against.
 *      Also: the bbox scales with the params that are supposed to drive it
 *      (width/height for the sign; armLength/dropLength/globeDiameter for the
 *      swing-arm sconce) -- a screenshot at default params cannot catch a
 *      param that silently stopped doing anything.
 *   2. The finish/merge contract (plan review finding #3): every mesh not
 *      explicitly kept carries userData.finish from the closed palette
 *      {matte, gloss, metal, glass, mirror, emissive}, and the parts that
 *      MUST stay their own draw call (the sign's text panel; the swing-arm
 *      sconce's glass globe and bulb; the up-down sconce's two lenses and its
 *      up/down beam-cone hints) carry userData.keep = true. Losing a keep
 *      flag is invisible in a screenshot -- the merged result still LOOKS
 *      like a sign or a lamp until the globe stops being see-through or a
 *      lens stops glowing at night.
 *   3. detail: 'low' produces no more triangles than 'full', so the low
 *      quality tier actually buys something, for BOTH sconce kinds.
 *   4. wall-sign builds correctly with NO global `document` at all (the shape
 *      Node's furniture-core drift test runs it in): its text panel still
 *      has the right geometry/position and keeps its userData.keep tag, just
 *      without a CanvasTexture. Separately, WITH a stubbed canvas, it is
 *      still the only textured mesh in the assembly.
 *   5. wall-sconce's `kind` selects the right variant ('swing-arm-globe' by
 *      default, 'up-down' via UP_DOWN_DEFAULTS/params.kind), never throws on
 *      an unrecognised kind, and adds no THREE light in either kind (the glow
 *      is emissive-only; real HA light binding is out of scope).
 *
 * THREE is loaded from the vendored ESM build so this exercises the same
 * geometry code the app and the spec page run, not a copy of it.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);

const THREE = await imp('vendor/three-r160/three.module.min.js');
// The ONE reader of finish/keep tags (src/furniture/finishes.js, added by
// PR1a/#30): a builder may tag the mesh OR its material, and the merge and
// this test both read through partFinish/partKeep so the rule cannot drift
// between what is tested and what is drawn. See finishes.js's own header.
const Fin = await imp('src/furniture/finishes.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

function bbox(group) {
  return new THREE.Box3().setFromObject(group);
}
function bboxCm(group) {
  const b = bbox(group);
  return {
    minX: b.min.x * 100, maxX: b.max.x * 100, minY: b.min.y * 100, maxY: b.max.y * 100,
    minZ: b.min.z * 100, maxZ: b.max.z * 100
  };
}
function triCount(group) {
  let tris = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    if (geo.index) tris += geo.index.count / 3;
    else tris += geo.attributes.position.count / 3;
  });
  return tris;
}
function meshesByName(group) {
  const m = {};
  group.traverse(o => { if (o.isMesh) m[o.name] = o; });
  return m;
}
function checkFinishAndKeep(tag, group, keptNames, mergeableNames) {
  let allTagged = true, untagged = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    const r = Fin.partFinish(o, o.material);
    if (r.error) { allTagged = false; untagged.push((o.name || o.type) + ': ' + r.error); }
  });
  check(tag + ': every mesh carries a finish from the closed palette', allTagged, untagged);
  const meshes = meshesByName(group);
  keptNames.forEach(n => {
    const m = meshes[n];
    check(tag + ': ' + n + ' is kept out of the merge', !!m && Fin.partKeep(m, m.material).keep === true, m && m.userData);
  });
  mergeableNames.forEach(n => {
    const m = meshes[n];
    check(tag + ': ' + n + ' is NOT kept (mergeable)', !!m && Fin.partKeep(m, m.material).keep !== true, m && m.userData);
  });
}
/** Bbox vs DEFAULTS width/height/depth, within 0.5 cm -- the same tolerance
 * the furniture-core drift test (feat/furniture-data-layer) uses. */
function checkBboxMatchesDefaults(tag, group, defaults) {
  const b = bboxCm(group);
  check(tag + ': width == DEFAULTS within 0.5 cm', Math.abs((b.maxX - b.minX) - defaults.width) <= 0.5,
    { bbox: b, width: defaults.width });
  check(tag + ': centred on x', Math.abs((b.maxX + b.minX) / 2) <= 0.5, b);
  check(tag + ': bottom at y = 0', Math.abs(b.minY) <= 0.5, b);
  check(tag + ': height == DEFAULTS within 0.5 cm', Math.abs(b.maxY - b.minY - defaults.height) <= 0.5,
    { bbox: b, height: defaults.height });
  check(tag + ': back at z = 0', Math.abs(b.minZ) <= 0.5, b);
  check(tag + ': depth == DEFAULTS within 0.5 cm', Math.abs(b.maxZ - b.minZ - defaults.depth) <= 0.5,
    { bbox: b, depth: defaults.depth });
}

// ============================================================
// wall-sign
// ============================================================
{
  const Sign = await imp('src/furniture/wall-sign.js');

  check('TYPE is wall-sign', Sign.TYPE === 'wall-sign', Sign.TYPE);
  check('DEFAULTS is frozen', Object.isFrozen(Sign.DEFAULTS));
  check('DEFAULTS has numeric width/height/depth',
    ['width', 'height', 'depth'].every(k => typeof Sign.DEFAULTS[k] === 'number'), Sign.DEFAULTS);

  // No global `document` at all here -- this is the shape the furniture-core
  // drift test (feat/furniture-data-layer) runs every builder in: plain Node,
  // no DOM/canvas polyfill. The text panel must still build, with the right
  // geometry and its keep flag, just without a CanvasTexture.
  check('no global document in this process (sanity)', typeof document === 'undefined');
  const g = Sign.build(THREE, {});
  checkBboxMatchesDefaults('sign (no DOM)', g, Sign.DEFAULTS);
  const meshesNoDom = meshesByName(g);
  check('sign (no DOM): text panel still present and kept',
    !!meshesNoDom.signTextPanel && meshesNoDom.signTextPanel.userData.keep === true);
  check('sign (no DOM): text panel has no texture map (no canvas available)',
    meshesNoDom.signTextPanel.material.map == null);
  checkFinishAndKeep('sign (no DOM)', g, ['signTextPanel'], ['signFrameTop', 'signBacker']);

  // bbox scales with width/height params
  const gBig = Sign.build(THREE, { width: 200, height: 80 });
  const boxBig = bbox(gBig);
  check('sign: width param drives bbox width', near(boxBig.max.x - boxBig.min.x, 2.00, 0.01),
    boxBig.max.x - boxBig.min.x);
  check('sign: height param drives bbox height', near(boxBig.max.y - boxBig.min.y, 0.80, 0.01),
    boxBig.max.y - boxBig.min.y);

  // low detail -> no more triangles than full
  const trisFull = triCount(Sign.build(THREE, {}, { detail: 'full' }));
  const trisLow = triCount(Sign.build(THREE, {}, { detail: 'low' }));
  check('sign: detail low has no more triangles than full', trisLow <= trisFull, { trisFull, trisLow });

  // stock retail sign phrase, not real-house wording (privacy)
  check('sign: default line1 is the stock phrase', Sign.DEFAULTS.line1 === 'GIVE IT TO GOD');
  check('sign: default line2 is the stock phrase', Sign.DEFAULTS.line2 === 'and go to sleep');

  // two-level depth: outer frame (depth, default 3cm) projects forward past
  // the inner panel/body (panelDepth, default 1.5cm) by their difference.
  check('sign: DEFAULTS.depth is 3 (outer frame)', Sign.DEFAULTS.depth === 3, Sign.DEFAULTS.depth);
  check('sign: DEFAULTS.panelDepth is 1.5 (inner body)', Sign.DEFAULTS.panelDepth === 1.5, Sign.DEFAULTS.panelDepth);
  check('sign: DEFAULTS.frameThickness is 2 (member width)', Sign.DEFAULTS.frameThickness === 2, Sign.DEFAULTS.frameThickness);

  const meshesDepth = meshesByName(g);
  const frameFrontZCm = new THREE.Box3().setFromObject(meshesDepth.signFrameTop).max.z * 100;
  const panelFrontZCm = meshesDepth.signTextPanel.position.z * 100;
  const bodyFrontZCm = new THREE.Box3().setFromObject(meshesDepth.signBacker).max.z * 100;
  check('sign: frame front sits at depth (3cm)', near(frameFrontZCm, 3, 0.05), frameFrontZCm);
  check('sign: panel/text front sits at panelDepth (1.5cm)', near(panelFrontZCm, 1.5, 0.05), panelFrontZCm);
  check('sign: panel body front matches panelDepth (1.5cm)', near(bodyFrontZCm, 1.5, 0.05), bodyFrontZCm);
  check('sign: frame projects forward past the panel by depth - panelDepth (1.5cm)',
    near(frameFrontZCm - panelFrontZCm, 1.5, 0.05), { frameFrontZCm, panelFrontZCm });
  check('sign: panel/backer front face is not hidden behind or past the frame front',
    panelFrontZCm < frameFrontZCm, { panelFrontZCm, frameFrontZCm });

  // frame colour is black, panel stays white-washed
  check('sign: default frameColor is black', Sign.DEFAULTS.frameColor.toLowerCase() === '#151515', Sign.DEFAULTS.frameColor);
  check('sign: default panelColor is still white-washed', Sign.DEFAULTS.panelColor === '#f2ede2', Sign.DEFAULTS.panelColor);

  // WITH a stubbed canvas (the createCanvas injection point, or a global
  // `document`): the text panel becomes the one textured mesh.
  const stubCreateCanvas = (w, h) => ({
    width: w, height: h,
    getContext() {
      return { fillStyle: '', font: '', textAlign: '', textBaseline: '', fillRect() {}, fillText() {} };
    }
  });
  const gTextured = Sign.build(THREE, {}, { detail: 'full', createCanvas: stubCreateCanvas });
  let texturedCount = 0;
  gTextured.traverse(o => { if (o.isMesh && o.material && o.material.map) texturedCount++; });
  check('sign (with canvas): exactly one textured mesh (the text panel)', texturedCount === 1, texturedCount);
  const meshesTextured = meshesByName(gTextured);
  check('sign (with canvas): the textured mesh IS the text panel', meshesTextured.signTextPanel.material.map != null);
  checkBboxMatchesDefaults('sign (with canvas)', gTextured, Sign.DEFAULTS);
}

// ============================================================
// wall-sconce: swing-arm-globe (default kind)
// ============================================================
{
  const Sconce = await imp('src/furniture/wall-sconce.js');

  check('TYPE is wall-sconce', Sconce.TYPE === 'wall-sconce', Sconce.TYPE);
  check('DEFAULTS is frozen', Object.isFrozen(Sconce.DEFAULTS));
  check('DEFAULTS has numeric width/height/depth',
    ['width', 'height', 'depth'].every(k => typeof Sconce.DEFAULTS[k] === 'number'), Sconce.DEFAULTS);
  check('DEFAULTS kind is swing-arm-globe', Sconce.DEFAULTS.kind === 'swing-arm-globe');
  check('UP_DOWN_DEFAULTS is frozen', Object.isFrozen(Sconce.UP_DOWN_DEFAULTS));
  check('UP_DOWN_DEFAULTS has numeric width/height/depth',
    ['width', 'height', 'depth'].every(k => typeof Sconce.UP_DOWN_DEFAULTS[k] === 'number'), Sconce.UP_DOWN_DEFAULTS);
  check('UP_DOWN_DEFAULTS kind is up-down', Sconce.UP_DOWN_DEFAULTS.kind === 'up-down');

  const g = Sconce.build(THREE, {});
  checkBboxMatchesDefaults('swing-arm-globe', g, Sconce.DEFAULTS);

  // bbox height scales with armLength + dropLength (both raise the wall plate)
  const gShort = Sconce.build(THREE, { armLength: 22, dropLength: 18 });
  const gLong = Sconce.build(THREE, { armLength: 40, dropLength: 30 });
  const hShort = bbox(gShort).max.y;
  const hLong = bbox(gLong).max.y;
  check('swing-arm-globe: longer arm/drop raises the overall height', hLong > hShort, { hShort, hLong });

  // globe diameter drives the globe's own extent
  const meshes = meshesByName(g);
  const globeBox = new THREE.Box3().setFromObject(meshes.sconceGlobe);
  const globeDiaDefault = globeBox.max.y - globeBox.min.y;
  check('swing-arm-globe: default globe diameter ~0.15 m', near(globeDiaDefault, 0.15, 0.005), globeDiaDefault);

  const gBigGlobe = Sconce.build(THREE, { globeDiameter: 30 });
  const meshesBig = meshesByName(gBigGlobe);
  const globeBoxBig = new THREE.Box3().setFromObject(meshesBig.sconceGlobe);
  const globeDiaBig = globeBoxBig.max.y - globeBoxBig.min.y;
  check('swing-arm-globe: globeDiameter param drives the globe bbox', near(globeDiaBig, 0.30, 0.01), globeDiaBig);

  checkFinishAndKeep('swing-arm-globe', g, ['sconceGlobe', 'sconceBulb'], ['sconceWallPlate', 'sconceArm']);
  check('swing-arm-globe: glass globe finish is glass', meshes.sconceGlobe.userData.finish === 'glass');
  check('swing-arm-globe: bulb finish is emissive', meshes.sconceBulb.userData.finish === 'emissive');

  // on/off toggles the bulb's emissive glow only -- no THREE light is added
  const gOff = Sconce.build(THREE, { on: false });
  const meshesOff = meshesByName(gOff);
  check('swing-arm-globe: on=true bulb is emissive', meshes.sconceBulb.material.emissiveIntensity > 0);
  check('swing-arm-globe: on=false bulb emissive is off', meshesOff.sconceBulb.material.emissiveIntensity === 0);
  let hasLight = false;
  g.traverse(o => { if (o.isLight) hasLight = true; });
  check('swing-arm-globe: builder adds no THREE light (glow is emissive-only)', !hasLight);

  // low detail -> no more triangles than full
  const trisFull = triCount(Sconce.build(THREE, {}, { detail: 'full' }));
  const trisLow = triCount(Sconce.build(THREE, {}, { detail: 'low' }));
  check('swing-arm-globe: detail low has no more triangles than full', trisLow <= trisFull, { trisFull, trisLow });

  // unrecognised kind falls back rather than throwing
  let threwOnBadKind = false;
  try { Sconce.build(THREE, { kind: 'chandelier' }); } catch (e) { threwOnBadKind = true; }
  check('unrecognised kind falls back to swing-arm-globe rather than throwing', !threwOnBadKind);
}

// ============================================================
// wall-sconce: up-down (rectangular wall light)
// ============================================================
{
  const Sconce = await imp('src/furniture/wall-sconce.js');
  const p = Sconce.UP_DOWN_DEFAULTS;

  const g = Sconce.build(THREE, p);
  checkBboxMatchesDefaults('up-down', g, p);

  const meshes = meshesByName(g);
  check('up-down: has a backplate, a body, two lenses and two beam hints',
    !!meshes.sconceBackplate && !!meshes.sconceBody && !!meshes.sconceLensTop &&
    !!meshes.sconceLensBottom && !!meshes.sconceBeamUp && !!meshes.sconceBeamDown,
    Object.keys(meshes));

  checkFinishAndKeep('up-down', g,
    ['sconceLensTop', 'sconceLensBottom', 'sconceBeamUp', 'sconceBeamDown'],
    ['sconceBackplate', 'sconceBody']);
  check('up-down: backplate/body finish is metal',
    meshes.sconceBackplate.userData.finish === 'metal' && meshes.sconceBody.userData.finish === 'metal');
  check('up-down: lenses/beams finish is emissive',
    meshes.sconceLensTop.userData.finish === 'emissive' && meshes.sconceBeamUp.userData.finish === 'emissive');

  // building via params.kind alone (not the whole UP_DOWN_DEFAULTS object)
  // also selects the up-down variant, merged onto its own defaults.
  const gByKind = Sconce.build(THREE, { kind: 'up-down' });
  checkBboxMatchesDefaults('up-down (kind only)', gByKind, p);

  // on/off toggles the lenses' emissive glow and the beam hints' opacity;
  // no THREE light is added.
  const gOff = Sconce.build(THREE, Object.assign({}, p, { on: false }));
  const meshesOff = meshesByName(gOff);
  check('up-down: on=true lenses are emissive', meshes.sconceLensTop.material.emissiveIntensity > 0);
  check('up-down: on=false lenses emissive is off', meshesOff.sconceLensTop.material.emissiveIntensity === 0);
  check('up-down: on=true beams have some opacity', meshes.sconceBeamUp.material.opacity > 0);
  check('up-down: on=false beams are fully transparent', meshesOff.sconceBeamUp.material.opacity === 0);
  let hasLight = false;
  g.traverse(o => { if (o.isLight) hasLight = true; });
  check('up-down: builder adds no THREE light (glow is emissive-only)', !hasLight);

  // low detail -> no more triangles than full
  const trisFull = triCount(Sconce.build(THREE, p, { detail: 'full' }));
  const trisLow = triCount(Sconce.build(THREE, p, { detail: 'low' }));
  check('up-down: detail low has no more triangles than full', trisLow <= trisFull, { trisFull, trisLow });

  // finish/keep tagging still holds at a scaled-up size
  const gBig = Sconce.build(THREE, Object.assign({}, p, { width: 20, height: 32, bodyHeight: 20 }));
  const b = bboxCm(gBig);
  check('up-down: width param drives bbox width', near(b.maxX - b.minX, 20, 0.5), b);
  check('up-down: height param drives bbox height', near(b.maxY - b.minY, 32, 0.5), b);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
