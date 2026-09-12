#!/usr/bin/env node
/**
 * Asserts the `window.THREE` compatibility export in index.html.
 *
 * WHY THIS TEST EXISTS, AND WHY IT IS NOT PARANOIA.
 *
 * index.html is an ES module. Module imports are scoped to the module, so
 * loading three.js with `import * as THREE from 'three'` does NOT create a
 * `window.THREE` global -- where the old `<script src="vendor/three.js">` tag
 * did, as a side effect.
 *
 * `loadExtraOverlays()` injects CLASSIC scripts named by a house profile's
 * `extraOverlays` field. A classic script cannot import anything, so the only
 * way it can reach three.js is off the global. Remove the assignment and every
 * existing extra overlay dies with `THREE is not defined`.
 *
 * THE FAILURE IS INVISIBLE TO EVERY OTHER CHECK. The demo house declares no
 * extraOverlays, so on a stock checkout the whole path is a no-op: CI passes,
 * a visual review passes, the app renders perfectly. The overlays that break
 * live in a PRIVATE house profile that this repo cannot contain. That is
 * precisely the shape of regression a static assertion is for.
 *
 * This is a source-level check by necessity -- the runtime path needs a house
 * profile that declares an overlay, which a public repo has no business
 * shipping a real example of. houses/_smoke/ carries a synthetic one for the
 * browser-side half; see docs/testing.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};

// 1. The assignment exists at all.
const assignIdx = html.search(/^\s*window\.THREE\s*=\s*THREE\s*;/m);
check('window.THREE = THREE is present in index.html', assignIdx !== -1);

// 2. It runs BEFORE loadExtraOverlays() is called. Ordering is the whole point:
//    an assignment after the call would be present but useless, and would still
//    satisfy a naive grep-for-the-string test.
const callIdx = html.search(/^\s*await\s+loadExtraOverlays\s*\(\s*\)\s*;/m);
check('loadExtraOverlays() is called', callIdx !== -1);
check(
  'window.THREE is assigned BEFORE loadExtraOverlays() runs',
  assignIdx !== -1 && callIdx !== -1 && assignIdx < callIdx,
  assignIdx !== -1 && callIdx !== -1 ? `(assign@${assignIdx} < call@${callIdx})` : ''
);

// 3. THREE is actually imported as a namespace, so the identifier being
//    assigned is the real module object rather than something left over.
check(
  "index.html imports * as THREE from 'three'",
  /^\s*import\s+\*\s+as\s+THREE\s+from\s+['"]three['"]\s*;/m.test(html)
);

// 4. The import map that resolves the bare 'three' specifier is present and
//    parses, and points at a vendored file that exists on disk. A map naming a
//    missing file fails at runtime with a module-resolution error and a blank
//    page -- no console stack worth reading.
const mapMatch = html.match(/<script\s+type="importmap"\s*>([\s\S]*?)<\/script>/);
check('an import map is declared', !!mapMatch);
if (mapMatch) {
  let map = null;
  try { map = JSON.parse(mapMatch[1]); } catch (e) { /* reported below */ }
  check('the import map is valid JSON', !!map);
  const spec = map && map.imports && map.imports.three;
  check("the import map maps the bare specifier 'three'", !!spec, spec || '');
  if (spec) {
    const rel = spec.split('?')[0].replace(/^\.\//, '');
    check(`the mapped file exists on disk`, fs.existsSync(path.join(root, rel)), rel);
    check('the mapped URL is cache-busted with ?v=__VERSION__', spec.includes('?v=__VERSION__'));
  }

  // 5. The map must precede the module script that uses the specifier. The HTML
  //    spec requires it, and getting it wrong is a blank page.
  const firstModule = html.search(/<script\s+type="module"\s*>/);
  check(
    'the import map precedes the first module script',
    firstModule !== -1 && html.indexOf(mapMatch[0]) < firstModule
  );
}

// 6. The loading overlay must still come first in <body> -- it is the thing
//    that paints during the initial parse, before three.js is even requested.
const bodyIdx = html.search(/<body[^>]*>/);
const overlayIdx = html.indexOf('id="home3d-loading"');
check(
  'the cold-start loading overlay precedes the import map',
  overlayIdx !== -1 && mapMatch && overlayIdx > bodyIdx && overlayIdx < html.indexOf(mapMatch[0])
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
