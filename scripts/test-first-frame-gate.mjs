/**
 * Cold-start: no shader program may be compiled INSIDE a frame.
 *
 * The live app logged "[Violation] 'requestAnimationFrame' handler took
 * 1950ms" and "... 1038ms" on every cold load. Measured on the real house
 * (fresh browser, no GPU shader cache), three separate causes, each of which
 * put a synchronous shader compile/link into one rAF handler:
 *
 *   1. The render loop drew its first frame BEFORE renderer.compileAsync()
 *      had finished, so three blocked on the in-flight program links -- the
 *      precompile was running, and the frame waited for it anyway (~3.0 s).
 *   2. A wallpapered wall's material had no `map` until its photo loaded;
 *      gaining one changes the program, which the precompile had never seen,
 *      so the first frame after the image arrived compiled it (~1 s).
 *   3. The shadow pass's depth program is not built by compileAsync() at all.
 *      A stand-in precompiles it -- but the stand-in's material must OUTLIVE
 *      the precompile: freeing it frees the program, and the first frame
 *      rebuilt it. (And its side must be the one the casters really need.)
 *
 * None of this is observable without a GPU, so this is a source-level guard
 * on each of the three fixes, in src/home3d-scene.js. It fails if a fix is
 * removed or reordered; the measurements themselves are in the PR.
 *
 * No framework, no install: `node scripts/test-first-frame-gate.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8').replace(/\r\n/g, '\n');
// Comments stripped so an explanatory comment can never satisfy a check.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + detail : '')); }
}

// 1. The loop draws nothing until the precompile has settled.
{
  // `loop(rafTs)` since task 230713da (the rAF timestamp times the fps cap).
  const start = code.search(/\(function loop\((rafTs)?\) \{/);
  const render = code.indexOf('ren.render(scene, cam);', start);
  const body = start >= 0 && render > start ? code.slice(start, render) : '';
  check('render loop found', body.length > 0);
  // Either `if (!readyFired) return;` or a block that ends in `return;`
  // (adaptive quality counts these idle ticks first, task 230713da).
  const gate = body.search(/if\s*\(\s*!readyFired\s*\)\s*(return\s*;|\{[^{}]*(\{[^{}]*\}[^{}]*)*return\s*;\s*\})/);
  check('loop returns early while !readyFired, before ren.render()', gate >= 0);
  const firstRequest = body.search(/requestAnimationFrame\(loop\)/);
  check('...and after re-arming requestAnimationFrame (the loop must keep ticking)',
    firstRequest >= 0 && gate > firstRequest);
  // readyFired is only ever set by fireReady(), which runs once the
  // precompile promise settles (or immediately with no compileAsync).
  const sets = code.match(/readyFired\s*=\s*true/g) || [];
  check('readyFired is set in exactly one place (fireReady)', sets.length === 1, String(sets.length));
  check('fireReady() runs after the precompile settles', /precompileDone\s*=\s*Promise\.all\(jobs\)[\s\S]{0,1200}?fireReady\(\);/.test(code));
}

// 2. Wallpaper materials are built with a map from the start.
{
  const m = code.match(/const wallpaperMat = new THREE\.MeshStandardMaterial\(\{([\s\S]*?)\}\);/);
  check('wallpaper material found', !!m);
  check('wallpaper material is constructed WITH a map (placeholder)', !!m && /\bmap\s*:/.test(m[1]), m && m[1]);
}

// 3. The shadow depth program is precompiled, with the side the casters use,
//    and its stand-in materials survive until dispose().
{
  check('depth precompile is one of the precompile jobs (when shadows are on)',
    /if\s*\(\s*wantShadows\s*\)\s*jobs\.push\([^;]*precompileShadowDepth\(\)/.test(code));
  const fn = code.match(/function precompileShadowDepth\(\) \{([\s\S]*?)\n    \}\n/);
  check('precompileShadowDepth found', !!fn);
  const body = fn ? fn[1] : '';
  check('stand-in side is DERIVED from the scene casters, not hard-coded',
    /shadowDepthSides\(scene\)/.test(body) && !/side\s*:\s*THREE\.(Back|Front|Double)Side/.test(body));
  const free = body.match(/const free = \(\) => \{([^}]*)\}/);
  check('the precompile\'s cleanup does NOT dispose the stand-in materials',
    !!free && !/dispose/.test(free[1].replace(/rt\.dispose\(\)|geo\.dispose\(\)/g, '')), free && free[1]);
  check('the stand-in materials are kept', /shadowDepthProbeMats\.push\(\.\.\.mats\)/.test(body));
  check('...and freed by dispose()', /shadowDepthProbeMats\.forEach\(m => m\.dispose\(\)\)/.test(code));
  const sides = code.match(/const SHADOW_SIDE = \{([^}]*)\}/);
  check('shadow side map flips Front<->Back and keeps Double (three\'s own rule)',
    !!sides && /\[THREE\.FrontSide\]\s*:\s*THREE\.BackSide/.test(sides[1]) &&
    /\[THREE\.BackSide\]\s*:\s*THREE\.FrontSide/.test(sides[1]) &&
    /\[THREE\.DoubleSide\]\s*:\s*THREE\.DoubleSide/.test(sides[1]), sides && sides[1]);
}

if (failures) {
  console.error(failures + ' failed, ' + passes + ' passed');
  process.exit(1);
}
console.log('ok -- ' + passes + ' passed, 0 failed');
