#!/usr/bin/env node
/**
 * Standing desk builder: the generic furniture contract (bbox vs DEFAULTS
 * within 0.5cm, frame convention, finish/keep tags, low < full triangles --
 * the same checks scripts/test-furniture-core.mjs runs against every
 * registered type) plus the desk-specific behaviour a screenshot cannot pin:
 * the sit-stand height clamp and the visible telescoping legs. No framework,
 * no install - `node scripts/test-standing-desk.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   1. THE GENERIC CONTRACT: build(THREE, DEFAULTS) returns a group whose
 *      bbox matches DEFAULTS width/depth/height within 0.5cm, x centred,
 *      bottom at y=0, back at z=0; every part's finish is in the palette and
 *      readable via partFinish/partKeep; kept finishes are marked keep;
 *      'low' has no more triangles than 'full'.
 *   2. A `topHeight` outside [minHeight, maxHeight] is clamped into range
 *      rather than honoured -- the acceptance criterion for the height
 *      slider. An absent topHeight defaults to the midpoint.
 *   3. The legs are two distinct columns (not a single centred pedestal),
 *      each a front-to-back foot bar spanning the desk's full depth -- the
 *      "flat T-foot legs" look this spec targets -- and visibly telescope
 *      as topHeight moves from minHeight to maxHeight.
 *   4. opts.detail: 'low' drops the control panel specifically (not just
 *      "fewer triangles" in the abstract).
 *
 * The builder is exercised with the real vendored three.js module, so this
 * runs the same geometry code the spec page does.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const { build, buildStandingDesk, clampHeight, TYPE, DEFAULTS } = await imp('src/furniture/standing-desk.js');
const Fin = await imp('src/furniture/finishes.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const TOL_CM = 0.5; // furniture contract: bbox within +/-0.5 cm

function bboxCm(group) {
  group.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(group);
  return { minX: b.min.x * 100, maxX: b.max.x * 100, minY: b.min.y * 100, maxY: b.max.y * 100, minZ: b.min.z * 100, maxZ: b.max.z * 100 };
}
function triangles(group) {
  let n = 0;
  group.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const count = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    n += count / 3;
  });
  return n;
}
function meshParts(group) {
  const parts = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => parts.push({ mesh: o, material: m }));
  });
  return parts;
}

// ---- 0. contract exports ---------------------------------------------------
{
  check('TYPE is the expected string', TYPE === 'standing-desk', TYPE);
  check('DEFAULTS is frozen', Object.isFrozen(DEFAULTS));
  check('DEFAULTS has numeric width/depth/height', ['width', 'depth', 'height'].every(k => typeof DEFAULTS[k] === 'number'), DEFAULTS);
  check('build is a function', typeof build === 'function');
  check('buildStandingDesk alias delegates to build', typeof buildStandingDesk === 'function');
}

// ---- 1. THE GENERIC FURNITURE CONTRACT, at DEFAULTS (as test-furniture-core does) ----
{
  const p = Object.assign({}, DEFAULTS);
  const full = build(THREE, p, { detail: 'full' });
  const low = build(THREE, p, { detail: 'low' });
  check('build() returns a THREE.Group', !!full && full.isGroup === true);
  const b = bboxCm(full);
  check('width == DEFAULTS.width within 0.5cm', Math.abs((b.maxX - b.minX) - p.width) <= TOL_CM, { bbox: b, width: p.width });
  check('centred on x', Math.abs((b.maxX + b.minX) / 2) <= TOL_CM, b);
  check('bottom at y = 0', Math.abs(b.minY) <= TOL_CM, b);
  check('height == DEFAULTS.height within 0.5cm', Math.abs(b.maxY - b.minY - p.height) <= TOL_CM, { bbox: b, height: p.height });
  check('back at z = 0', Math.abs(b.minZ) <= TOL_CM, b);
  check('depth == DEFAULTS.depth within 0.5cm, toward +z', Math.abs(b.maxZ - b.minZ - p.depth) <= TOL_CM, { bbox: b, depth: p.depth });

  const parts = meshParts(full);
  check('has meshes', parts.length > 0);
  const named = x => (x.mesh.name || x.mesh.type);
  const badFinish = parts.map(x => ({ x, r: Fin.partFinish(x.mesh, x.material) })).filter(o => o.r.error);
  check('every part has a palette userData.finish (mesh or material)', badFinish.length === 0,
    badFinish.map(o => named(o.x) + ': ' + o.r.error));
  const badKeep = parts.map(x => ({ x, r: Fin.partKeep(x.mesh, x.material) })).filter(o => o.r.error);
  check('mesh and material keep flags agree where both are set', badKeep.length === 0,
    badKeep.map(o => named(o.x) + ': ' + o.r.error));
  const unkept = parts.filter(x => {
    const f = Fin.partFinish(x.mesh, x.material).finish;
    return f && Fin.isKeptFinish(f) && Fin.partKeep(x.mesh, x.material).keep !== true;
  });
  check('glass/mirror/emissive parts are marked keep (mesh or material)', unkept.length === 0,
    unkept.map(x => named(x) + ':' + Fin.partFinish(x.mesh, x.material).finish));

  const tf = triangles(full), tl = triangles(low);
  check('detail low has no more triangles than full', tl <= tf, { full: tf, low: tl });
}

// ---- 2. topHeight clamps into [minHeight, maxHeight] -----------------------
{
  const low = build(THREE, { width: 120, depth: 80, topHeight: 40, minHeight: 72, maxHeight: 120 });
  check('topHeight below range clamps to minHeight', low.userData.clampedHeight === 72, low.userData.clampedHeight);
  const high = build(THREE, { width: 120, depth: 80, topHeight: 500, minHeight: 72, maxHeight: 120 });
  check('topHeight above range clamps to maxHeight', high.userData.clampedHeight === 120, high.userData.clampedHeight);
  check('clampHeight() matches the builder for the same inputs',
    clampHeight(40, 72, 120) === 72 && clampHeight(500, 72, 120) === 120);
}

// ---- 3. absent topHeight defaults to the range midpoint -------------------
{
  const mid = clampHeight(undefined, 72, 120);
  check('absent topHeight defaults to the midpoint', mid === 96, mid);
  const group = build(THREE, { width: 120, depth: 80, minHeight: 72, maxHeight: 120 });
  check('builder defaults an absent topHeight the same way', group.userData.clampedHeight === 96, group.userData.clampedHeight);
  const allDefaults = build(THREE, {});
  check('DEFAULTS.topHeight is what an empty params object resolves to', allDefaults.userData.clampedHeight === DEFAULTS.topHeight, allDefaults.userData.clampedHeight);
}

// ---- 4. two distinct legs, each a full-depth foot bar, telescoping -------
{
  const group = build(THREE, { width: 120, depth: 80, topHeight: 95, minHeight: 72, maxHeight: 120 });
  const feet = [];
  group.traverse(o => { if (o.name === 'legFoot') feet.push(o); });
  check('exactly two foot bars', feet.length === 2, feet.length);
  if (feet.length === 2) {
    const [a, b] = feet;
    check('feet sit on opposite sides of centre', Math.sign(a.position.x) !== Math.sign(b.position.x), [a.position.x, b.position.x]);
    const footGeoDepth = a.geometry.parameters.depth;
    check('foot bar spans the full desk depth (front-to-back)', near(footGeoDepth, 0.80, 1e-3), footGeoDepth);
  }
  const uppers = [];
  group.traverse(o => { if (o.name === 'legColumnUpper') uppers.push(o); });
  check('exactly two telescoping upper stages', uppers.length === 2, uppers.length);

  const atMin = build(THREE, { width: 120, depth: 80, topHeight: 72, minHeight: 72, maxHeight: 120 });
  const atMax = build(THREE, { width: 120, depth: 80, topHeight: 120, minHeight: 72, maxHeight: 120 });
  function upperExtents(g) {
    let bottom = null, top = null, h = null;
    g.traverse(o => {
      if (o.name === 'legColumnUpper') {
        h = o.geometry.parameters.height;
        bottom = o.position.y - h / 2;
        top = o.position.y + h / 2;
      }
    });
    return { bottom, top, h };
  }
  const min = upperExtents(atMin), max = upperExtents(atMax);
  check('upper stage bottom (overlap into the sleeve) stays fixed', near(min.bottom, max.bottom, 1e-6), { min, max });
  check('upper stage top rises with topHeight', max.top > min.top, { min, max });
  check('upper stage extension (height) grows with desk topHeight', max.h > min.h, { min, max });
}

// ---- 5. low detail drops the control panel specifically -------------------
{
  const low = build(THREE, { width: 120, depth: 80, topHeight: 95, minHeight: 72, maxHeight: 120 }, { detail: 'low' });
  const lowHasPanel = [];
  low.traverse(o => { if (o.name === 'controlPanel' || o.name === 'controlPanelDisplay') lowHasPanel.push(o.name); });
  check('low detail drops the control panel entirely', lowHasPanel.length === 0, lowHasPanel);
  const lowBbox = bboxCm(low);
  check('low detail still respects the frame contract (bottom y=0, back z=0)',
    Math.abs(lowBbox.minY) <= TOL_CM && Math.abs(lowBbox.minZ) <= TOL_CM, lowBbox);
}

// ---- 6. controlSide places the panel left/right with a 4cm edge gap -------
{
  function panelX(group) {
    let x = null;
    group.traverse(o => { if (o.name === 'controlPanel') x = o.position.x; });
    return x;
  }
  function displayX(group) {
    let x = null;
    group.traverse(o => { if (o.name === 'controlPanelDisplay') x = o.position.x; });
    return x;
  }
  const W = 120, base = { width: W, depth: 80, topHeight: 95, minHeight: 72, maxHeight: 120 };

  const dflt = build(THREE, Object.assign({}, base));
  check('default controlSide is right (panel at x>0, front-facing terms)', panelX(dflt) > 0, panelX(dflt));

  const right = build(THREE, Object.assign({}, base, { controlSide: 'right' }));
  check('controlSide "right" puts the panel at x>0', panelX(right) > 0, panelX(right));

  const left = build(THREE, Object.assign({}, base, { controlSide: 'left' }));
  check('controlSide "left" puts the panel at x<0', panelX(left) < 0, panelX(left));

  check('display follows the panel to the right', near(displayX(right), panelX(right), 1e-6), { panel: panelX(right), display: displayX(right) });
  check('display follows the panel to the left', near(displayX(left), panelX(left), 1e-6), { panel: panelX(left), display: displayX(left) });

  // Everything below in metres, matching the builder's own coordinate system
  // (positions come back in metres; W here is cm, so convert once).
  const Wm = W * 0.01;
  const panelWm = Math.min(0.12, Wm * 0.1);
  const rightOuterEdgeGapCm = (Wm / 2 - (panelX(right) + panelWm / 2)) * 100;
  const leftOuterEdgeGapCm = (Wm / 2 - (Math.abs(panelX(left)) + panelWm / 2)) * 100;
  check('right panel outer edge is 4cm in from the desk side edge', near(rightOuterEdgeGapCm, 4, 1e-3), rightOuterEdgeGapCm);
  check('left panel outer edge is 4cm in from the desk side edge', near(leftOuterEdgeGapCm, 4, 1e-3), leftOuterEdgeGapCm);

  const badValue = build(THREE, Object.assign({}, base, { controlSide: 'up' }));
  check('unknown controlSide falls back to right', panelX(badValue) > 0, panelX(badValue));
}

// ---- 7. optional LED strip under the desktop edge --------------------------
{
  const { LED_STRIP_H, normaliseLedSides } = await imp('src/furniture/standing-desk.js');
  const strips = g => { const out = {}; g.traverse(o => { if (o.userData && o.userData.ledStrip) out[o.name] = o; }); return out; };
  const boxOf = o => { o.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(o); return b; };
  const base = { width: 120, depth: 80, topHeight: 95, minHeight: 72, maxHeight: 120 };

  check('DEFAULTS.ledStrip is off (opt-in)', DEFAULTS.ledStrip === false, DEFAULTS.ledStrip);
  check('no strip without ledStrip', Object.keys(strips(build(THREE, base))).length === 0);

  const g = build(THREE, Object.assign({}, base, { ledStrip: true, ledColor: '#00ff66' }));
  const s = strips(g);
  check('default strip is left + front + right, and nothing else',
    Object.keys(s).sort().join() === 'ledStripFront,ledStripLeft,ledStripRight', Object.keys(s));
  const W = 1.2, D = 0.8, H = 0.95;
  if (s.ledStripLeft && s.ledStripFront && s.ledStripRight) {
    const L = boxOf(s.ledStripLeft), F = boxOf(s.ledStripFront), R = boxOf(s.ledStripRight);
    check('left run is flush with the left edge', near(L.min.x, -W / 2, 1e-4), L.min.x);
    check('right run is flush with the right edge', near(R.max.x, W / 2, 1e-4), R.max.x);
    check('front run is flush with the front edge', near(F.max.z, D, 1e-4), F.max.z);
    check('front run spans the full width', near(F.min.x, -W / 2, 1e-4) && near(F.max.x, W / 2, 1e-4), [F.min.x, F.max.x]);
    check('left run reaches back to the back edge', near(L.min.z, 0, 1e-4), L.min.z);
    check('right run reaches back to the back edge', near(R.min.z, 0, 1e-4), R.min.z);
    check('left run meets the front run (one continuous line)', near(L.max.z, F.min.z, 1e-4), [L.max.z, F.min.z]);
    check('right run meets the front run', near(R.max.z, F.min.z, 1e-4), [R.max.z, F.min.z]);
    [L, F, R].forEach((b, i) => {
      check('run ' + i + ' top touches the underside of the desktop', near(b.max.y, H, 1e-4), b.max.y);
      check('run ' + i + ' hangs LED_STRIP_H below it', near(b.max.y - b.min.y, LED_STRIP_H, 1e-4), b.max.y - b.min.y);
    });
    const m = s.ledStripFront.material;
    const pf = Fin.partFinish(s.ledStripFront, m);
    check('strip is the emissive finish', pf.finish === 'emissive', pf);
    check('strip is kept out of the opaque merge', Fin.partKeep(s.ledStripFront, m).keep === true);
    check('strip glows in ledColor', m.emissive.getHexString() === '00ff66' && m.color.getHexString() === '00ff66',
      [m.color.getHexString(), m.emissive.getHexString()]);
    check('strip casts no shadow', !s.ledStripFront.castShadow);
  }
  let lights = 0;
  g.traverse(o => { if (o.isLight) lights++; });
  check('the strip adds no real light', lights === 0, lights);

  const plain = bboxCm(build(THREE, base)), lit = bboxCm(g);
  check('the strip does not change the item envelope',
    ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'].every(k => Math.abs(plain[k] - lit[k]) <= 1e-3), { plain, lit });

  // Follows topHeight: at sit and at stand the strip sits under the top.
  for (const th of [72, 120]) {
    const gg = build(THREE, Object.assign({}, base, { topHeight: th, ledStrip: true }));
    const f = strips(gg).ledStripFront;
    check('strip follows topHeight ' + th, f && near(boxOf(f).max.y, th / 100, 1e-4), f && boxOf(f).max.y);
  }

  const low = strips(build(THREE, Object.assign({}, base, { ledStrip: true }), { detail: 'low' }));
  check('low detail keeps the strip (the part a light binding drives)', Object.keys(low).length === 3, Object.keys(low));

  const frontOnly = strips(build(THREE, Object.assign({}, base, { ledStrip: true, ledSides: ['front'] })));
  check('ledSides ["front"] draws only the front run', Object.keys(frontOnly).join() === 'ledStripFront', Object.keys(frontOnly));
  if (frontOnly.ledStripFront) {
    check('a lone front run still spans the full width', near(boxOf(frontOnly.ledStripFront).max.x - boxOf(frontOnly.ledStripFront).min.x, W, 1e-4));
  }
  const sidesOnly = strips(build(THREE, Object.assign({}, base, { ledStrip: true, ledSides: 'left,right' })));
  check('without a front run the sides reach the front edge',
    sidesOnly.ledStripLeft && near(boxOf(sidesOnly.ledStripLeft).max.z, D, 1e-4), sidesOnly.ledStripLeft && boxOf(sidesOnly.ledStripLeft).max.z);
  const warn = console.warn; console.warn = () => {};
  check('unknown sides are dropped, all-unknown falls back to the default',
    normaliseLedSides(['front', 'top']).join() === 'front' && normaliseLedSides(['up']).join() === 'left,front,right',
    [normaliseLedSides(['front', 'top']), normaliseLedSides(['up'])]);
  console.warn = warn;
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
if (failures > 0) process.exit(1);
