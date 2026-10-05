#!/usr/bin/env node
/**
 * Edit mode is never loaded by a view-mode boot, and a draft is never read
 * where it must not apply. Static checks of index.html and src/ -- this repo
 * has no headless browser, so the wiring is checked as source (the
 * behaviour of the pure parts is in scripts/test-profile-draft.mjs).
 * `node scripts/test-edit-mode-boot.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. Nothing imports src/edit-mode.js STATICALLY -- not index.html, not any
 *      module under src/ (a static import anywhere in the boot graph would
 *      load it on every view-mode page, the wall tablet included).
 *   2. index.html has exactly one dynamic import() of it, inside
 *      loadEditMode(), and loadEditMode() is called from exactly two places:
 *      toggleEditMode() (the Settings button) and the banner for a draft this
 *      device is rendering. toggleEditMode() is called only from that button.
 *   3. The Settings row and the draft banner are both behind editAllowed,
 *      which is draftAllowed({ isPreview, isEmbed, isFramed }).
 *   4. At boot the page reads a draft ONLY through bootDraft() (which refuses
 *      in the preview tile, the HA popup and iframes), passing those flags.
 *   5. edit-mode.js stays a leaf: it imports the pure draft/export modules,
 *      never the scene or the HA client.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail).slice(0, 400) : '')); }
}
const count = (s, re) => (s.match(re) || []).length;

/** The source of `function name(...) { ... }` (brace-matched), or ''. */
function fnBody(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return '';
  let i = src.indexOf('{', at), depth = 0;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(at, k + 1);
  }
  return '';
}

const STATIC_IMPORT = /(?:^|\n)\s*import\s+(?:[^'"()]*?\bfrom\s*)?['"][^'"]*edit-mode\.js[^'"]*['"]/;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"][^'"]*edit-mode\.js[^'"]*['"]\s*\)/g;

console.log('1. no static import of edit-mode.js anywhere');
const html = read('index.html');
check('index.html', !STATIC_IMPORT.test(html));
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.m?js$/.test(e.name)) out.push(rel);
  }
  return out;
}
const srcFiles = walk('src');
const offenders = srcFiles.filter(f => f !== 'src/edit-mode.js' && (STATIC_IMPORT.test(read(f)) || DYNAMIC_IMPORT.test(read(f))));
check('no module under src/ imports it (' + srcFiles.length + ' files)', offenders.length === 0, offenders);
// The regex must be able to see an import at all, or the checks above pass vacuously.
check('the static-import pattern matches a real one', STATIC_IMPORT.test("\nimport { enterEditMode } from './src/edit-mode.js?v=1';"));

console.log('2. one dynamic import, reached from two places');
const loadFn = fnBody(html, 'loadEditMode');
check('exactly one import() of edit-mode.js in index.html', count(html, DYNAMIC_IMPORT) === 1);
check('... and it is inside loadEditMode()', count(loadFn, DYNAMIC_IMPORT) === 1, loadFn.slice(0, 120));
check('... stamped like every other import (?v=__VERSION__)', /import\(\s*'\.\/src\/edit-mode\.js\?v=__VERSION__'\s*\)/.test(loadFn));
// Code lines only (comments mention it), minus the definition.
const code = html.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const calls = count(code, /\bloadEditMode\(\)/g) - 1;
const toggleFn = fnBody(html, 'toggleEditMode');
const draftBlock = (html.match(/if \(editAllowed && \(draftApplied \|\| draftBroken\)\) \{[\s\S]*?\n\s*\}\n/) || [''])[0];
check('loadEditMode() is called exactly twice', calls === 2, calls);
check('... once from toggleEditMode()', count(toggleFn, /\bloadEditMode\(\)/g) === 1);
check('... once for a draft this device renders, behind editAllowed', count(draftBlock, /\bloadEditMode\(\)/g) === 1, draftBlock.slice(0, 120));
check('toggleEditMode() refuses when edit is not allowed', /if \(!editAllowed\) return;/.test(toggleFn));
const toggleCalls = html.match(/[^\n]*\btoggleEditMode\(\)[^\n]*/g).filter(l => !/function toggleEditMode/.test(l));
check('toggleEditMode() is called only by the Settings button', toggleCalls.length === 1 && /panelEditMode\.addEventListener\('click'/.test(toggleCalls[0]), toggleCalls);

console.log('3. offered only where a draft may apply');
check('editFlags carries all three contexts', /const editFlags = \{ isPreview, isEmbed, isFramed \};/.test(html));
check('editAllowed = draftAllowed(editFlags)', /const editAllowed = draftAllowed\(editFlags\);/.test(html));
check('isFramed: any iframe (a cross-origin parent counts)', /const isFramed = \(\(\) => \{ try \{ return window\.self !== window\.top; \} catch \(e\) \{ return true; \} \}\)\(\);/.test(html));
check('the Settings row is behind editAllowed', /if \(editAllowed\) \{\s*const editingNow[\s\S]{0,400}panel-edit-mode/.test(html));

console.log('4. drafts are read at boot only through bootDraft');
check('bootDraft(pageStorage, cfg.house, editFlags)', count(html, /bootDraft\(pageStorage, cfg\.house, editFlags\)/g) === 1);
check('index.html never calls readDraft directly', !/readDraft\(/.test(html));
check('the draft geometry is compiled only when bootDraft returned one', /if \(draftBoot && HouseLoader\.isValidHouseId\(cfg\.house\)\)/.test(html));

console.log('5. edit-mode.js is a leaf');
const em = read('src/edit-mode.js');
const imports = [...em.matchAll(/\bfrom\s*'([^']+)'/g)].map(m => m[1]);
check('imports only the pure draft / export / edit-ops / control-descriptor modules', JSON.stringify(imports.sort()) ===
  JSON.stringify(['./edit-ops.js', './furniture/controls.js', './profile-draft.js', './profile-export.js']), imports);
const ops = read('src/edit-ops.js');
const opsImports = [...ops.matchAll(/\bfrom\s*'([^']+)'/g)].map(m => m[1]);
check('edit-ops.js imports only the pure polygon helper', JSON.stringify(opsImports) === JSON.stringify(['./footstep-walk.js']), opsImports);

console.log('6. Discard is reachable even when a draft crashes the boot');
const escapeLine = 'if (draftBoot) mountDraftEscape(document, pageStorage, cfg.house);';
const escAt = html.indexOf(escapeLine);
check('the escape is mounted exactly once, for any draft bootDraft returned', count(html, /mountDraftEscape\(/g) === 1 && escAt > 0);
check('... right after bootDraft, before the draft is compiled', escAt > html.indexOf('const draftBoot = bootDraft(') &&
  escAt < html.indexOf('HouseLoader.compile(draftBoot.geometry'));
check('... before the scene is created (where a bad draft crashes)', escAt < html.indexOf('const home = Home3DScene.create('));
check('... imported statically with bootDraft (no lazy import to fail first)', /import \{ bootDraft, draftAllowed, mountDraftEscape \} from '\.\/src\/profile-draft\.js\?v=__VERSION__';/.test(html));
check('the draft banner takes it away when it mounts', /function renderBanner\(\) \{\s*(\/\/[^\n]*\n\s*)*removeDraftEscape\(document\);/.test(em));

console.log('7. a furniture tap in edit mode is edit mode\'s');
const tp = read('src/tap-popovers.js');
const onClick = (tp.match(/const onClick = e => \{[\s\S]*?const res = pickAt/) || [''])[0];
check('tap-popovers asks tapClaimed() before it picks', /o\.tapClaimed\(\)\) return;/.test(onClick), onClick.slice(0, 200));
check('the page answers it from edit mode only', /tapClaimed: \(\) => !!\(editApi && editApi\.isActive\(\) && editApi\.tapClaimed\(\)\)/.test(html));

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
