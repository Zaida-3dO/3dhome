/**
 * box.js - a plain box. The smallest builder that meets the furniture
 * contract, used as the test and demo stub and as a real type for minor
 * clutter (a storage crate, a speaker nobody has modelled yet).
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0 and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 * See docs/house-profile.md, "Furniture".
 */
import { makeFinish, isKeptFinish } from './finishes.js';

export const TYPE = 'box';

// Kept equal to houses/schema.json $defs/furnitureParams_box by
// scripts/test-furniture-defaults.mjs.
export const DEFAULTS = Object.freeze({
  width: 40,
  depth: 40,
  height: 40,
  color: '#b8ad9c',
  finish: 'matte'
});

/**
 * @param {Object} THREE
 * @param {Object} [params]  overrides for DEFAULTS
 * @param {{detail?: 'full'|'low'}} [opts]  a box has no detail to drop
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) { // eslint-disable-line no-unused-vars
  const p = Object.assign({}, DEFAULTS, params || {});
  const w = p.width / 100, d = p.depth / 100, h = p.height / 100;
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(0, h / 2, d / 2);
  const mesh = new THREE.Mesh(geo, makeFinish(THREE, p.finish, p.color));
  if (isKeptFinish(mesh.material.userData.finish)) mesh.userData.keep = true;
  const group = new THREE.Group();
  group.name = 'furniture:box';
  group.add(mesh);
  return group;
}

export const buildBox = build;
