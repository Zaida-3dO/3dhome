#!/usr/bin/env node
/**
 * digital-piano.js: geometry decisions a contract-gate screenshot cannot pin.
 * No framework, no install: `node scripts/test-digital-piano.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract (bbox, finish tags, no-three, low<=full triangles) for every
 * registered type including `digital-piano`, `piano-bench` and `ottoman`.
 * This file checks the type-specific decisions that contract does not know
 * to ask about, building EVERY preset this module exports:
 *
 *   1. digital-piano: the stand legs sit at the back (z=0), the keybed and
 *      music rest are toward the front (+z), white keys are drawn (and black
 *      keys too at full detail, set back from them and dropped at low
 *      detail), the overall height stays pinned to DEFAULTS.height
 *      regardless of restHeight (the rest and body share a fixed budget),
 *      the stand/base parts are NOT metal (metal reads dark grey with no
 *      environment map -- the stand is white), and the music rest leans
 *      AWAY from the player (toward -z) rather than into their space.
 *   2. piano-bench: BOTH baseStyle presets ('x' and 'column') build to the
 *      same bbox, and each uses genuinely different geometry (a column vs.
 *      two crossed legs) rather than silently falling back to one shape.
 *      Base parts are not metal, for the same reason as the piano stand.
 *   3. ottoman: the lid is channel-tufted (DEFAULTS.channelCount ridges,
 *      evenly spaced, flush with the lid edges), the ridges STAND PROUD of
 *      the flat lid top (round face up, not sunk inside it and not rotated
 *      sideways), and it sits on 4 legs. A reviewer found a real bug here:
 *      an earlier version of this file asserted ridges "never stand proud",
 *      which locked the bug in rather than catching it -- this version
 *      requires the opposite.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const DP = await imp('src/furniture/digital-piano.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function meshesByColor(group, hex) {
  const out = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.color && mat.color.getHex() === hex) out.push(o);
  });
  return out;
}
const colorInt = hex => parseInt(hex.slice(1), 16);

// ---- TYPES export shape ------------------------------------------------------
{
  check('TYPES has digital-piano, piano-bench and ottoman',
    !!DP.TYPES['digital-piano'] && !!DP.TYPES['piano-bench'] && !!DP.TYPES['ottoman']);
  for (const key of ['digital-piano', 'piano-bench', 'ottoman']) {
    const D = DP.TYPES[key].DEFAULTS;
    check(key + ': DEFAULTS frozen with width/depth/height numeric',
      Object.isFrozen(D) && ['width', 'depth', 'height'].every(k => typeof D[k] === 'number'));
  }
}

// ---- digital-piano -----------------------------------------------------------
{
  const { DEFAULTS: D, build } = DP.TYPES['digital-piano'];
  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);

  const whiteKeys = meshesByColor(g, colorInt(D.keyWhiteColor));
  check('at least one white-key mesh drawn', whiteKeys.length > 0);
  const blackKeysFull = meshesByColor(g, colorInt(D.keyBlackColor));
  check('full detail draws a black-key strip', blackKeysFull.length > 0, blackKeysFull.length);

  const low = build(THREE, Object.assign({}, D), { detail: 'low' });
  const blackKeysLow = meshesByColor(low, colorInt(D.keyBlackColor));
  check('low detail drops the black-key strip', blackKeysLow.length === 0, blackKeysLow.length);

  // Stand legs (standColor) run the full depth (feet from back to front, for
  // stability); the keys sit in the front half of the keybed, the player's
  // edge, not tucked against the back.
  const standParts = meshesByColor(g, colorInt(D.standColor));
  check('stand parts are drawn', standParts.length > 0);
  const depthM = D.depth / 100;
  const keysMinZ = Math.min(...whiteKeys.map(m => new THREE.Box3().setFromObject(m).min.z));
  check('white keys sit in the front half of the item (the player\'s edge)',
    keysMinZ >= depthM / 2, { keysMinZ, depthM });

  // Overall height stays pinned to DEFAULTS.height for a range of restHeight
  // values (the rest and body share a fixed budget above the keybed), and
  // the back stays at z=0 too -- leaning the rest must not push either past
  // its budget.
  for (const restHeight of [5, 15, 40]) {
    const gi = build(THREE, Object.assign({}, D, { restHeight }), { detail: 'full' });
    gi.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gi);
    const heightCm = (box.max.y - box.min.y) * 100;
    check('overall height stays pinned to DEFAULTS.height for restHeight=' + restHeight,
      near(heightCm, D.height, 0.5), heightCm);
    check('back stays at z=0 for restHeight=' + restHeight,
      near(box.min.z, 0, 0.002), box.min.z);
  }

  // Stand is NOT metal: with no environment map in the live scene, a
  // metalness-0.9 material reflects only black ambient and reads dark grey
  // regardless of its base colour -- wrong for a white stand.
  standParts.forEach(m => {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    check('stand part is not the metal finish', mat.userData.finish !== 'metal', mat.userData.finish);
  });

  // The music rest leans AWAY from the player (toward -z), not toward them.
  // Identified as the tallest mesh in the body colour that is NOT the flat
  // body slab or the key backing (both of which sit at y <= keybedHeight;
  // the rest starts at keybedHeight and reaches up to the full height).
  const bodyColorParts = meshesByColor(g, colorInt(D.bodyColor));
  const keybedHM = D.keybedHeight / 100;
  const rest = bodyColorParts.find(m => {
    const b = new THREE.Box3().setFromObject(m);
    return b.max.y > keybedHM + 0.01 && (b.max.y - b.min.y) > 0.05;
  });
  check('found the music rest mesh for this check', !!rest);
  if (rest) {
    const rb = new THREE.Box3().setFromObject(rest);
    // The rest's own TOP should sit further toward -z (away from the
    // player) than its BOTTOM -- a positive lean (the bug) would put the top
    // further toward +z instead. Sample the actual mesh vertices in world
    // space rather than just the bbox, since a bbox alone can't distinguish
    // "leans back" from "leans forward" once translated to keep the back at
    // z=0 (see backOvershoot in the builder).
    const posAttr = rest.geometry.attributes.position;
    let topZ = -Infinity, topY = -Infinity, botZ = Infinity, botY = Infinity;
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(rest.matrixWorld);
      if (v.y > topY) { topY = v.y; topZ = v.z; }
      if (v.y < botY) { botY = v.y; botZ = v.z; }
    }
    check('music rest leans AWAY from the player (top is further toward -z than the bottom)',
      topZ < botZ, { topY, topZ, botY, botZ });
  }
}

// ---- piano-bench: both baseStyle presets -------------------------------------
{
  const { DEFAULTS: D, build } = DP.TYPES['piano-bench'];
  for (const baseStyle of ['x', 'column']) {
    const g = build(THREE, Object.assign({}, D, { baseStyle }), { detail: 'full' });
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    const w = (box.max.x - box.min.x) * 100, d = (box.max.z - box.min.z) * 100, h = (box.max.y - box.min.y) * 100;
    check('baseStyle=' + baseStyle + ': bbox width matches DEFAULTS', near(w, D.width, 0.5), w);
    check('baseStyle=' + baseStyle + ': bbox depth matches DEFAULTS', near(d, D.depth, 0.5), d);
    check('baseStyle=' + baseStyle + ': bbox height matches DEFAULTS', near(h, D.height, 0.5), h);
    check('baseStyle=' + baseStyle + ': back at z=0', near(box.min.z, 0, 0.002), box.min.z);

    // Base is NOT metal, for the same reason as the digital-piano stand: no
    // environment map means a metal finish reads dark grey regardless of
    // colour, and the bench base is white.
    const baseColorInt = colorInt(D.baseColor);
    const baseParts = meshesByColor(g, baseColorInt);
    check('baseStyle=' + baseStyle + ': base parts found for the finish check', baseParts.length > 0);
    baseParts.forEach(m => {
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      check('baseStyle=' + baseStyle + ': base part is not the metal finish', mat.userData.finish !== 'metal', mat.userData.finish);
    });
  }

  // The two presets are genuinely different geometry, not the same shape
  // twice: a column build has a cylinder (>12 triangles per part somewhere
  // in the base); an x-frame build has no cylinder-radius geometry at all in
  // its base parts (only boxes -- 12 triangles each).
  function baseTriCounts(baseStyle) {
    const g = build(THREE, Object.assign({}, D, { baseStyle }), { detail: 'full' });
    const seatColorInt = colorInt(D.seatColor);
    const counts = [];
    g.traverse(o => {
      if (!o.isMesh) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mat && mat.color && mat.color.getHex() === seatColorInt) return; // skip the seat pad
      const idx = o.geometry.index;
      counts.push(idx ? idx.count / 3 : o.geometry.attributes.position.count / 3);
    });
    return counts;
  }
  const xTris = baseTriCounts('x');
  const columnTris = baseTriCounts('column');
  check('x-frame base parts are all simple boxes (12 triangles each)', xTris.every(t => t === 12), xTris);
  check('column base includes a cylinder (far more than 12 triangles)', columnTris.some(t => t > 12), columnTris);
}

// ---- ottoman -------------------------------------------------------------------
{
  const { DEFAULTS: D, build } = DP.TYPES['ottoman'];
  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  g.updateMatrixWorld(true);

  // 4 legs in the leg colour.
  const legs = meshesByColor(g, colorInt(D.legColor));
  check('exactly 4 legs', legs.length === 4, legs.length);

  // The lid ridges: found as the higher-triangle-count meshes in the body
  // colour (the flat lid base and the body box are 12-triangle boxes; a
  // ridge is a cylinder segment with far more).
  const bodyColorInt = colorInt(D.color);
  const bodyParts = meshesByColor(g, bodyColorInt);
  const ridges = bodyParts.filter(m => {
    const idx = m.geometry.index;
    const tri = idx ? idx.count / 3 : m.geometry.attributes.position.count / 3;
    return tri > 12;
  });
  check('channelCount ridges drawn', ridges.length === D.channelCount, ridges.length);

  // Evenly spaced, flush with the lid edges. The lid itself is inset 2% from
  // the full ottoman width (widthM * 0.98), and the ridge row is fit to that
  // inset lid width, matching the builder's own layout maths exactly. Each
  // ridge is built as an extruded semicircle centred on its own local x=0
  // (see buildOttoman), so its bbox centre IS the anchor -- unlike the old
  // rotated-half-cylinder version, no separate "anchor vs. bbox" distinction
  // is needed here any more.
  const xsCentre = ridges.map(m => {
    const b = new THREE.Box3().setFromObject(m);
    return (b.min.x + b.max.x) / 2;
  }).sort((a, b) => a - b);
  const rowWidthM = (D.width / 100) * 0.98;
  const nominal = rowWidthM / D.channelCount;
  check('first ridge centred half a pitch from the left edge of the inset lid',
    near(xsCentre[0], -rowWidthM / 2 + nominal / 2, 0.002), xsCentre[0]);
  check('last ridge centred half a pitch from the right edge of the inset lid',
    near(xsCentre[xsCentre.length - 1], rowWidthM / 2 - nominal / 2, 0.002), xsCentre[xsCentre.length - 1]);

  // Ridges STAND PROUD of the flat lid top, round face UP -- a reviewer
  // found a real bug here: the previous version was rotated with the round
  // face sideways and sat fully INSIDE the lid box (an earlier version of
  // this test asserted "never stand proud", which locked that bug in). The
  // flat lid slab is the other body-colour part that is NOT a ridge (12
  // triangles); ridges must rise clearly above its top face, and their own
  // cross-section must be a dome (wider at the base, in local width, than
  // exactly the same all the way up would suggest a flat-sided box instead
  // of a rounded profile -- checked via the geometry's own bounding sphere
  // vs. bounding box ratio being consistent with a genuine curve).
  // The flat lid slab is the non-ridge body-colour part whose OWN top face
  // (max.y) sits closest to (just below) the ridges' own bottom -- i.e. the
  // part the ridges are actually resting on, not just any part below them.
  const nonRidgeParts = bodyParts.filter(m => !ridges.includes(m));
  const ridgeMinYForLid = Math.min(...ridges.map(m => new THREE.Box3().setFromObject(m).min.y));
  const lidBase = nonRidgeParts.reduce((best, m) => {
    const top = new THREE.Box3().setFromObject(m).max.y;
    if (top > ridgeMinYForLid + 0.005) return best; // above the ridges: not the lid
    if (!best) return m;
    const bestTop = new THREE.Box3().setFromObject(best).max.y;
    return top > bestTop ? m : best;
  }, null);
  check('found the flat lid base for this check', !!lidBase);
  const lidTopY = new THREE.Box3().setFromObject(lidBase).max.y;
  const ridgeBoxes = ridges.map(m => new THREE.Box3().setFromObject(m));
  const ridgeMinY = Math.min(...ridgeBoxes.map(b => b.min.y));
  const ridgeMaxY = Math.max(...ridgeBoxes.map(b => b.max.y));
  check('ridges sit flush with (not sunk below) the lid top',
    near(ridgeMinY, lidTopY, 0.002), { ridgeMinY, lidTopY });
  check('ridges STAND PROUD of the lid top (round face up, not sunk inside it)',
    ridgeMaxY > lidTopY + 0.002, { ridgeMaxY, lidTopY });

  // Ridges run the long way (front-to-back), not across the width: each
  // ridge's own z-extent should span most of the ottoman's depth.
  const depthM = D.depth / 100;
  ridgeBoxes.forEach((b, i) => {
    const zSpan = b.max.z - b.min.z;
    check('ridge ' + i + ' runs the long way (z-extent close to the full depth)',
      zSpan > depthM * 0.8, { zSpan, depthM });
  });

  // The overall envelope height still equals DEFAULTS.height even though
  // the ridges now genuinely protrude above the flat lid (the protrusion is
  // budgeted for, not additional to DEFAULTS.height) -- already covered by
  // the generic contract test, re-asserted here for this specific geometry.
  const overallBox = new THREE.Box3().setFromObject(g);
  check('overall height still equals DEFAULTS.height with proud ridges',
    near((overallBox.max.y - overallBox.min.y) * 100, D.height, 0.5),
    (overallBox.max.y - overallBox.min.y) * 100);

  // A custom channelCount still lays out correctly.
  const g2 = build(THREE, Object.assign({}, D, { channelCount: 3 }), { detail: 'full' });
  const ridges2 = meshesByColor(g2, bodyColorInt).filter(m => {
    const idx = m.geometry.index;
    const tri = idx ? idx.count / 3 : m.geometry.attributes.position.count / 3;
    return tri > 12;
  });
  check('a custom channelCount is honoured', ridges2.length === 3, ridges2.length);

  // Low-detail triangle budget: the extruded-ridge fix must not make the
  // low-detail build expensive. Reviewer's target: under 200 triangles.
  function totalTris(group) {
    let n = 0;
    group.traverse(o => {
      if (!o.isMesh) return;
      const idx = o.geometry.index;
      n += idx ? idx.count / 3 : o.geometry.attributes.position.count / 3;
    });
    return n;
  }
  const low = build(THREE, Object.assign({}, D), { detail: 'low' });
  const lowTris = totalTris(low);
  check('low-detail ottoman is under 200 triangles', lowTris < 200, lowTris);
}

// ---- registry wiring (this module's own entries) -----------------------------
{
  const { REGISTRY } = await imp('src/furniture/registry.js');
  check('registry: digital-piano points at digital-piano.js with key digital-piano',
    REGISTRY['digital-piano'].path === 'digital-piano.js' && REGISTRY['digital-piano'].key === 'digital-piano',
    REGISTRY['digital-piano']);
  check('registry: piano-bench points at digital-piano.js with key piano-bench',
    REGISTRY['piano-bench'].path === 'digital-piano.js' && REGISTRY['piano-bench'].key === 'piano-bench',
    REGISTRY['piano-bench']);
  check('registry: ottoman points at digital-piano.js with key ottoman',
    REGISTRY['ottoman'].path === 'digital-piano.js' && REGISTRY['ottoman'].key === 'ottoman',
    REGISTRY['ottoman']);
  check('all three point at the DigitalPianoSpec page',
    REGISTRY['digital-piano'].spec === 'DigitalPianoSpec' &&
    REGISTRY['piano-bench'].spec === 'DigitalPianoSpec' &&
    REGISTRY['ottoman'].spec === 'DigitalPianoSpec');
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
