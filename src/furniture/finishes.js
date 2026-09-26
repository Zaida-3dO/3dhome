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
  // Leather and faux-leather (PU): a soft sheen on the curves with no sharp
  // specular hotspot -- between matte (reads as fabric) and gloss (wet plastic).
  satin: Object.freeze({ roughness: 0.6, metalness: 0 }),
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

/**
 * THE ONE READER of a part's finish and keep tags. The builder contract lets
 * a builder tag EITHER the mesh (`mesh.userData.finish` / `.keep`) OR the
 * material (`material.userData.finish` / `.keep`, which makeFinish() stamps).
 * When both are set they must agree. The contract test and the renderer's
 * merge both read tags through these two functions and nothing else, so the
 * rule cannot drift between what is tested and what is drawn.
 *
 * @param {Object} mesh      a THREE.Mesh
 * @param {Object} [material]  one of its materials (default: its first)
 * @returns {{finish: ?string, error: ?string}}  finish is null when error is set
 */
export function partFinish(mesh, material) {
  const mat = material || (mesh && (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material));
  const onMesh = mesh && mesh.userData ? mesh.userData.finish : undefined;
  const onMat = mat && mat.userData ? mat.userData.finish : undefined;
  if (onMesh != null && onMat != null && onMesh !== onMat) {
    return { finish: null, error: 'mesh says ' + JSON.stringify(onMesh) + ' but its material says ' + JSON.stringify(onMat) };
  }
  const f = onMat != null ? onMat : onMesh;
  if (f == null) return { finish: null, error: 'no userData.finish on the mesh or its material' };
  if (FINISHES.indexOf(f) === -1) return { finish: null, error: 'finish ' + JSON.stringify(f) + ' is not in the palette' };
  return { finish: f, error: null };
}

/**
 * The part's keep flag, under the same either/or rule:
 * `{keep: true|false|undefined, error}`. `undefined` means neither is set.
 * The merge keeps a part when this says true OR its finish is a kept finish.
 */
export function partKeep(mesh, material) {
  const mat = material || (mesh && (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material));
  const onMesh = mesh && mesh.userData ? mesh.userData.keep : undefined;
  const onMat = mat && mat.userData ? mat.userData.keep : undefined;
  if (onMesh != null && onMat != null && !!onMesh !== !!onMat) {
    return { keep: undefined, error: 'mesh keep=' + onMesh + ' but its material keep=' + onMat };
  }
  const k = onMesh != null ? !!onMesh : (onMat != null ? !!onMat : undefined);
  return { keep: k, error: null };
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

/**
 * Procedural oak-grain roughness map: subtle, low-contrast vertical streaks.
 * Extracted from src/home3d-scene.js's makeOakGrainTexture (the bedroom's
 * hard-coded acoustic slat panel, ~L605-633) so a furniture builder that
 * wants the same grain (e.g. wall-panels.js's slat-panel, oak preset) draws
 * from the one generator rather than a second copy.
 *
 * NODE / NO-DOM BUILDS: same pattern as wall-sign.js's resolveCreateCanvas --
 * `document.createElement('canvas')` does not exist under plain Node, which
 * is where the builder-contract drift tests run. `createCanvas`, if passed,
 * is a `(w, h) => canvas` factory (a caller's own DOM/canvas polyfill); with
 * neither that nor a global `document`, this returns null and the caller
 * simply does not get a grain map (matte colour only) rather than throwing.
 *
 * This is deliberately NOT part of the closed finish palette above: a
 * roughness map is a real, if narrow, exception to "every material comes
 * from makeFinish() unmodified" (see the file header) -- there is no
 * grained finish key. A caller applies it on top of a makeFinish() material
 * and should mark that mesh `keep` so it opts out of any future
 * finish-bucket merge instead of silently losing the map to it.
 *
 * @param {Object} THREE
 * @param {(w: number, h: number) => Object} [createCanvas]  optional canvas
 *   factory for a headless/Node environment; falls back to global `document`
 * @returns {?THREE.CanvasTexture}  null if no canvas factory is available
 */
export function makeOakGrainRoughnessMap(THREE, createCanvas) {
  const w = 16, h = 256;
  const make = createCanvas || (typeof document !== 'undefined' && typeof document.createElement === 'function'
    ? (cw, ch) => { const c = document.createElement('canvas'); c.width = cw; c.height = ch; return c; }
    : null);
  if (!make) return null;
  const c = make(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d9d9d9';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    const x0 = Math.random() * w;
    const shade = 190 + Math.random() * 50; // subtle, low-contrast like wallRoughMap
    ctx.strokeStyle = `rgba(${shade},${shade},${shade},0.5)`;
    ctx.lineWidth = 0.4 + Math.random() * 0.6;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.bezierCurveTo(
      x0 + (Math.random() - 0.5) * 3, h * 0.33,
      x0 + (Math.random() - 0.5) * 3, h * 0.66,
      x0 + (Math.random() - 0.5) * 2, h
    );
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 5);
  return tex;
}
