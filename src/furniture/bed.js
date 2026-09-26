/**
 * bed.js - single-type module: `bed`.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0, and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 * See docs/house-profile.md, "Furniture", and PR7 of
 * plan-furniture-system-r2.md.
 *
 * Upholstered bed with a tall channel-tufted (vertical fluted) headboard in
 * grey velvet, a base, a mattress and pillows, plus an optional duvet -- no
 * real measurements, no house-specific placement; this module is a generic,
 * publishable bed shape only. `width`/`depth` describe the base/mattress
 * footprint; `height` is the OVERALL envelope (driven by the headboard,
 * which is normally the tallest part), per the furniture contract's bbox
 * check. `headboardHeight` may be taller or shorter than the base+mattress
 * stack; DEFAULTS.height is always max(headboardHeight, base+mattress top).
 */
import { makeFinish, isKeptFinish } from './finishes.js';

export const TYPE = 'bed';

/** Defaults, in cm. A queen-ish double: ~161 x 220, headboard ~120 tall. */
export const DEFAULTS = Object.freeze({
  width: 161,
  depth: 220,
  height: 120,           // == headboardHeight at the default pose
  headboardHeight: 120,  // floor to the top of the headboard
  baseHeight: 32,        // floor to the top of the base (divan/box base)
  mattressHeight: 28,
  channelCount: 7,        // vertical flutes across the headboard width
  channelDepth: 3.5,      // how far each flute stands proud, cm
  headboardColor: '#8d8f92',   // grey velvet
  baseColor: '#3a3a3d',
  mattressColor: '#f2efe8',
  pillowColor: '#f7f5f0',
  duvet: true,
  duvetColor: '#e7e3da',
  finish: 'matte'
});

const CM = 0.01;

/** Merge params over DEFAULTS, keeping unknown keys out. */
function resolveParams(params) {
  return Object.assign({}, DEFAULTS, params || {});
}

/**
 * A single vertical channel-tufted flute: a half-round bolster running the
 * full height of the headboard, so an even row of them reads as continuous
 * vertical channel tufting.
 */
function buildChannel(THREE, radius, height, seg) {
  // Half-cylinder (open flat side glued to the headboard backing), capped at
  // top and bottom so it never reads hollow from a 3/4 view.
  const geo = new THREE.CylinderGeometry(radius, radius, height, seg, 1, false, 0, Math.PI);
  return geo;
}

/**
 * Build the bed.
 * @param {Object} THREE
 * @param {Object} [params]  overrides for DEFAULTS
 * @param {{detail?: 'full'|'low'}} [opts]  'low' drops the pillows, the duvet
 *   fold detail (a flatter single box) and halves the channel segment count
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const p = resolveParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';

  const widthM = p.width * CM;
  const depthM = p.depth * CM;
  const baseHM = p.baseHeight * CM;
  const mattHM = p.mattressHeight * CM;
  const headboardHM = p.headboardHeight * CM;

  const group = new THREE.Group();
  group.name = 'furniture:bed';

  const baseMat = makeFinish(THREE, p.finish, p.baseColor);
  const mattMat = makeFinish(THREE, 'matte', p.mattressColor);
  const headboardMat = makeFinish(THREE, p.finish, p.headboardColor);
  const pillowMat = makeFinish(THREE, 'matte', p.pillowColor);
  const duvetMat = makeFinish(THREE, 'matte', p.duvetColor);

  function addMesh(geo, mat, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }

  // ---- base (divan/box base), back at z=0, bottom at y=0 -------------------
  const baseGeo = new THREE.BoxGeometry(widthM, baseHM, depthM);
  addMesh(baseGeo, baseMat, 0, baseHM / 2, depthM / 2);

  // ---- mattress, sits on the base ------------------------------------------
  const mattGeo = new THREE.BoxGeometry(widthM * 0.98, mattHM, depthM * 0.98);
  addMesh(mattGeo, mattMat, 0, baseHM + mattHM / 2, depthM / 2);

  // ---- headboard: backing panel at z=0, channels standing proud of it ------
  // The headboard sits behind the base, its back face flush with the group's
  // own back (z=0) so the whole bed's back is a single plane, matching the
  // furniture contract regardless of which part is deepest.
  const backingDepthM = 0.06;
  const headboardGeo = new THREE.BoxGeometry(widthM, headboardHM, backingDepthM);
  addMesh(headboardGeo, headboardMat, 0, headboardHM / 2, backingDepthM / 2);

  // Vertical channel tufting: evenly spaced half-round flutes across the
  // width, redistributing the remainder into the gap so the row starts and
  // ends flush with the panel edges (same fitting approach as
  // wall-panels.js's slat-panel).
  const n = Math.max(1, Math.round(p.channelCount));
  const seg = full ? 12 : 6;
  const channelDepthM = p.channelDepth * CM;
  const nominalW = widthM / n;
  const radius = Math.min(channelDepthM, nominalW / 2 * 0.98);
  const channelGeo = buildChannel(THREE, radius, headboardHM * 0.96, seg);
  // CylinderGeometry is built along its own y axis by default; rotate its
  // flat face to point toward -z (back) so the round face stands proud at +z.
  channelGeo.rotateY(-Math.PI / 2);
  channelGeo.rotateZ(0);
  const startX = -widthM / 2 + nominalW / 2;
  for (let i = 0; i < n; i++) {
    const cx = startX + i * nominalW;
    const mesh = new THREE.Mesh(channelGeo, headboardMat);
    mesh.position.set(cx, headboardHM / 2, backingDepthM);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(headboardMat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
  }

  // ---- pillows (dropped at low detail) --------------------------------------
  if (full) {
    const pillowW = widthM * 0.42, pillowH = 0.16, pillowD = 0.22;
    const pillowGeo = new THREE.BoxGeometry(pillowW, pillowH, pillowD);
    const pillowY = baseHM + mattHM + pillowH / 2;
    const pillowZ = depthM - pillowD / 2 - 0.06;
    addMesh(pillowGeo, pillowMat, -widthM * 0.22, pillowY, pillowZ);
    addMesh(pillowGeo, pillowMat, widthM * 0.22, pillowY, pillowZ);
  }

  // ---- duvet (optional) ------------------------------------------------------
  if (p.duvet) {
    const duvetH = full ? 0.14 : 0.10;
    const duvetD = depthM * 0.62;
    const duvetGeo = new THREE.BoxGeometry(widthM * 0.97, duvetH, duvetD);
    const duvetY = baseHM + mattHM + duvetH / 2;
    const duvetZ = depthM - duvetD / 2 - 0.02;
    addMesh(duvetGeo, duvetMat, 0, duvetY, duvetZ);
  }

  // ---- overall bbox: bottom at y=0, back at z=0, x centred ------------------
  // Every part above is already authored on that frame directly (base/
  // mattress/duvet/pillows centred on x, back-most face at z=0 via the
  // headboard backing), so no post-hoc shift is required -- but normalise
  // anyway so a future part added off-frame cannot silently break the
  // contract without a visible bbox mismatch in the per-module test.
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const shiftX = -(box.min.x + box.max.x) / 2;
  const shiftY = -box.min.y;
  const shiftZ = -box.min.z;
  if (Math.abs(shiftX) > 1e-6 || Math.abs(shiftY) > 1e-6 || Math.abs(shiftZ) > 1e-6) {
    group.children.forEach(c => {
      c.position.x += shiftX;
      c.position.y += shiftY;
      c.position.z += shiftZ;
    });
    group.updateMatrixWorld(true);
  }

  group.userData = { type: TYPE, params: p, detail: full ? 'full' : 'low' };
  return group;
}

export const buildBed = build;

/** Only the params that differ from DEFAULTS -- the furniture JSON shape. */
export function toFurnitureJSON(params) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (params && params[k] !== undefined && params[k] !== DEFAULTS[k]) out[k] = params[k];
  }
  return { type: TYPE, params: out };
}
