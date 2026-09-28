#!/usr/bin/env node
/**
 * The live house's finishes are not near-black.
 * No framework, no install: `node scripts/test-live-finishes.mjs`.
 *
 * The live scene has no environment map, so a metallic surface has nothing
 * to reflect and draws only its diffuse share, (1 - metalness) x colour.
 * At the palette's metalness 0.9 a light-grey handle or radiator fin came
 * out near-black; `mirror` had the same bug (PR #61). finishes.js's
 * NO_ENV_FINISH_PARAMS gives both a live look, and this file pins it:
 *
 *   1. For every opaque palette finish, the live diffuse share of a light
 *      grey (#c3c6c9, the kitchen steel) is at least MIN_DIFFUSE_SHARE of
 *      what the same colour gets as `matte`. At metalness 0.9 that share is
 *      0.1; the floor is 0.6.
 *   2. The merged palette texture (what the live renderer actually samples)
 *      carries those live params in its metal and mirror texels.
 *   3. Every metal part of every registered builder, at DEFAULTS, lands in
 *      the OPAQUE palette bucket -- the one that reads the texture. A metal
 *      part that went to a kept bucket would be drawn with its builder's own
 *      material (metalness 0.9) and the override would silently not apply.
 *   4. makeFinish() still makes the true palette metal (metalness 0.9): it is
 *      what merge.js's isPaletteMaterial compares a part against. Spec pages
 *      convert it to the live look themselves (src/render-rig.js
 *      applyLiveFinishes, pinned by scripts/test-render-rig.mjs).
 *
 * MUTATION: set NO_ENV_FINISH_PARAMS.metal.metalness back to 0.9 (or delete
 * the entry) and checks 1 and 2 fail.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const Fin = await imp('src/furniture/finishes.js');
const M = await imp('src/furniture/merge.js');
const { REGISTRY } = await imp('src/furniture/registry.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

const MIN_DIFFUSE_SHARE = 0.6;
const OPAQUE_LIVE = ['matte', 'gloss', 'satin', 'metal', 'mirror'];

// 1. Diffuse share per finish (relative to matte, which is fully diffuse).
OPAQUE_LIVE.forEach(f => {
  const p = Fin.liveFinishParams(f);
  const share = 1 - (typeof p.metalness === 'number' ? p.metalness : 0);
  check(f + ': live diffuse share >= ' + MIN_DIFFUSE_SHARE + ' (not near-black without an env map)',
    share >= MIN_DIFFUSE_SHARE, { finish: f, metalness: p.metalness, share });
});
{
  // The concrete complaint: a light-grey metal must read light, not black.
  const c = new THREE.Color('#c3c6c9');        // linear on construction
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const live = lum * (1 - Fin.liveFinishParams('metal').metalness);
  check('light-grey metal: live diffuse luminance >= 0.3 (linear)', live >= 0.3, { lum, live });
}

// 2. The palette texture the live renderer samples.
{
  const tex = M.makePaletteTexture(THREE);
  const d = tex.image.data;
  ['metal', 'mirror'].forEach(f => {
    const i = M.PALETTE_FINISHES.indexOf(f);
    const p = Fin.liveFinishParams(f);
    check(f + ' texel metalness (B) is the live value', Math.abs(d[i * 4 + 2] / 255 - p.metalness) < 1 / 255, [d[i * 4 + 2], p.metalness]);
    check(f + ' texel metalness (B) <= ' + (1 - MIN_DIFFUSE_SHARE), d[i * 4 + 2] / 255 <= 1 - MIN_DIFFUSE_SHARE + 1e-9, d[i * 4 + 2]);
  });
  tex.dispose();
}

// 3. Every metal part of every registered builder reads the texture.
{
  let metalParts = 0;
  for (const type of Object.keys(REGISTRY)) {
    const e = REGISTRY[type];
    let mod;
    try { mod = await imp('src/furniture/' + e.path); } catch (err) { continue; } // an unmerged module
    const impl = mod.TYPES ? mod.TYPES[e.key || type] : mod;
    if (!impl || typeof impl.build !== 'function') continue;
    let g;
    try { g = impl.build(THREE, Object.assign({}, impl.DEFAULTS), { detail: 'full' }); } catch (err) { continue; }
    const { parts } = M.flattenGroup(THREE, g, {});
    parts.filter(p => p.finish === 'metal').forEach(p => {
      metalParts++;
      check(type + ': metal part lands in the palette bucket (live override applies)', M.bucketClass(p) === 'opaque',
        { type, cls: M.bucketClass(p) });
    });
  }
  check('some registered builder has metal parts (the check above is not vacuous)', metalParts > 0, metalParts);
}

// 4. makeFinish keeps the palette metal (the reference merge.js compares against).
{
  const m = Fin.makeFinish(THREE, 'metal', '#c3c6c9');
  check('makeFinish(metal) is still the palette metal', m.metalness === Fin.FINISH_PARAMS.metal.metalness && m.metalness >= 0.9, m.metalness);
  m.dispose();
}

console.log(`test-live-finishes: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
