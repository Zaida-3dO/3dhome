/**
 * finishes.js - the closed finish palette every furniture builder draws from.
 *
 * Every material a builder makes comes from makeFinish(). That is what lets the
 * renderer merge a room's furniture into a handful of draws: opaque parts are
 * bucketed by finish and carry their colour as a vertex attribute, so all the
 * matte parts in a room share ONE material. A builder that invents its own
 * material (a roughness of 0.6, a texture map) defeats that and is a bug.
 *
 * The finish is stamped on `material.userData.finish` so the merge can bucket
 * without guessing from the material's numbers.
 *
 * Pure ESM with THREE injected -- no `import 'three'` -- so it loads from Node
 * tests, the live scene and the spec pages alike.
 */

/** The palette. Values are MeshStandardMaterial parameters. */
export const FINISH_PARAMS = Object.freeze({
  // Fabric, wood, painted and plastic surfaces.
  matte: Object.freeze({ roughness: 0.8, metalness: 0 }),
  gloss: Object.freeze({ roughness: 0.25, metalness: 0 }),
  metal: Object.freeze({ roughness: 0.35, metalness: 0.9 }),
  glass: Object.freeze({ roughness: 0.05, metalness: 0, transparent: true, opacity: 0.25, depthWrite: false }),
  // There is no environment map in the live scene, so a "mirror" is a very
  // smooth, fully metallic light grey rather than a reflection.
  mirror: Object.freeze({ roughness: 0.02, metalness: 1 }),
  // Screens and lamp globes: glows in its own colour, adds no light.
  emissive: Object.freeze({ roughness: 0.8, metalness: 0 })
});

export const FINISHES = Object.freeze(Object.keys(FINISH_PARAMS));

/**
 * Finishes the merge must keep as their own draw (with a real material)
 * rather than folding into a vertex-coloured bucket: anything transparent,
 * reflective or glowing. A builder does not need to set `userData.keep` on
 * these itself -- isKeptFinish() is what the merge asks -- but may.
 */
export const KEEP_FINISHES = Object.freeze(['glass', 'mirror', 'emissive']);

export function isKeptFinish(finish) {
  return KEEP_FINISHES.indexOf(finish) !== -1;
}

const MIRROR_COLOR = 0xd8dadc;

/** '#rrggbb' | 0xrrggbb -> 0xrrggbb, or the fallback. */
function toColorInt(color, fallback) {
  if (typeof color === 'number' && isFinite(color)) return color;
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) return parseInt(color.slice(1), 16);
  return fallback;
}

/**
 * A material from the palette.
 *
 * An unknown finish is NOT an exception: it arrives from profile data
 * (`params.finish`), and one mistyped value must not cost the house its
 * furniture. It falls back to `matte`, says so on the console, and stamps the
 * finish it actually used.
 *
 * @param {Object} THREE   the three.js namespace
 * @param {string} finish  one of FINISHES
 * @param {string|number} [color]  '#rrggbb' or 0xrrggbb; default light grey
 * @returns {THREE.MeshStandardMaterial}
 */
export function makeFinish(THREE, finish, color) {
  let f = finish;
  if (!Object.prototype.hasOwnProperty.call(FINISH_PARAMS, f)) {
    console.warn('[furniture] unknown finish ' + JSON.stringify(finish) + ' -- using "matte"');
    f = 'matte';
  }
  const c = f === 'mirror' ? MIRROR_COLOR : toColorInt(color, 0xcccccc);
  const opts = Object.assign({ color: c }, FINISH_PARAMS[f]);
  if (f === 'emissive') opts.emissive = c;
  const mat = new THREE.MeshStandardMaterial(opts);
  mat.userData.finish = f;
  return mat;
}
