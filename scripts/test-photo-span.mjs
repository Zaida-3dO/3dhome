#!/usr/bin/env node
/**
 * The page-only image previews: src/photo-span.js (SmallItemsSpec's
 * photo-frame preview) and RugSpec's ?texture= failure warning.
 * No framework, no install: `node scripts/test-photo-span.mjs`.
 *
 * Each check names the source mutation that makes it fail:
 *
 *   1. spanPanels: ONE image covers the panels' combined area, centred and
 *      cropped (never stretched); each panel shows its own slice, left to
 *      right, the gaps between panels hiding theirs.
 *   2. applyPhotoSpan on the REAL photo-frame builder, every preset the
 *      spec page offers: every picture panel gets its own slice, they tile
 *      the image left to right, the frame bars keep their plain material.
 *   3. SmallItemsSpec (static, text-level -- a browser is the real proof):
 *      the control is offered for the photo-frame TYPE (so every preset),
 *      reads the file with URL.createObjectURL, never sends or stores it,
 *      and keeps it out of the params Copy JSON reads.
 *   4. RugSpec (static, text-level): a failed ?texture= load raises the
 *      visible warning, not only a console line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const P = await imp('src/photo-span.js');
const SI = await imp('src/furniture/small-items.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- 1. spanPanels ---------------------------------------------------------------
// Mutations: drop the cover crop (fx = fy = 1) -> the aspect cases fail;
// u0 = 0 (crop from the left, not centred) -> "centred" fails; offset from
// p.minX without subtracting x0 -> the multi-panel cases fail.
{
  const one = P.spanPanels([{ minX: 0, maxX: 2, minY: 0, maxY: 1 }], 2);
  check('1 panel, same aspect: the whole image, unscaled', near(one[0].repeat[0], 1) && near(one[0].repeat[1], 1) && near(one[0].offset[0], 0) && near(one[0].offset[1], 0), one);

  const wide = P.spanPanels([{ minX: -1, maxX: 1, minY: 5, maxY: 7 }], 2);   // square area, 2:1 image
  check('a wider image is cropped at the sides, centred (shows the middle half)',
    near(wide[0].repeat[0], 0.5) && near(wide[0].offset[0], 0.25) && near(wide[0].repeat[1], 1) && near(wide[0].offset[1], 0), wide);

  const tall = P.spanPanels([{ minX: 0, maxX: 3, minY: 0, maxY: 1 }], 1);    // 3:1 area, square image
  check('a taller image is cropped top and bottom, centred (shows the middle third)',
    near(tall[0].repeat[0], 1) && near(tall[0].offset[0], 0) && near(tall[0].repeat[1], 1 / 3) && near(tall[0].offset[1], 1 / 3), tall);

  // 4 panels 30 wide with 2 gaps between, 40 tall: area 126 x 40.
  const panels = [0, 1, 2, 3].map(i => ({ minX: i * 32, maxX: i * 32 + 30, minY: 0, maxY: 40 }));
  const img = 126 / 40;                                   // same aspect as the area: no crop
  const s4 = P.spanPanels(panels, img);
  check('4 panels: one slice each, in order', s4.length === 4 && s4.every((s, i) => i === 0 || s.offset[0] > s4[i - 1].offset[0]));
  check('4 panels: the first starts at the image left edge, the last ends at its right edge',
    near(s4[0].offset[0], 0) && near(s4[3].offset[0] + s4[3].repeat[0], 1), s4);
  check('4 panels: each gap hides exactly its own slice of the image (2/126)',
    s4.every((s, i) => i === 0 || near(s.offset[0] - (s4[i - 1].offset[0] + s4[i - 1].repeat[0]), 2 / 126)), s4.map(s => s.offset[0]));
  check('4 panels: every slice is 30/126 of the image wide and the full height',
    s4.every(s => near(s.repeat[0], 30 / 126) && near(s.repeat[1], 1) && near(s.offset[1], 0)));
  const s4w = P.spanPanels(panels, 2 * img);              // twice as wide: shows the middle half across all four
  check('4 panels, wider image: the span as a whole is the centred middle half',
    near(s4w[0].offset[0], 0.25) && near(s4w[3].offset[0] + s4w[3].repeat[0], 0.75), s4w);
  check('a bad aspect (0, NaN) means no crop', near(P.spanPanels(panels, 0)[0].repeat[1], 1) && near(P.spanPanels(panels, NaN)[3].offset[0] + P.spanPanels(panels, NaN)[3].repeat[0], 1));
  check('no panels, no spans', P.spanPanels([], 1).length === 0);
}

// ---- 2. applyPhotoSpan on the real builder, every spec-page preset ------------------
// Mutations: slice from the panel's index instead of its position -> "left
// to right" fails when the traversal is not in x order; share one texture (no clone) -> "own slice" fails; match meshes by
// finish instead of the preview texture -> the frame bars get slices.
{
  const html = fs.readFileSync(path.join(root, 'specs/SmallItemsSpec.html'), 'utf8');
  const block = html.slice(html.indexOf("'photo-frame': {", html.indexOf('const PRESETS')));
  const presets = {};
  const body = block.slice(block.indexOf('{') + 1, block.search(/\n\s*\},?\r?\n/));
  for (const m of body.matchAll(/'([^']+)':\s*(\{[^}]*\})/g)) {
    presets[m[1]] = Function('return (' + m[2] + ')')();
  }
  check('the spec page offers >= 4 photo-frame presets (parsed from PRESETS)', Object.keys(presets).length >= 4, Object.keys(presets));
  const D = SI.TYPES['photo-frame'].DEFAULTS;
  for (const [name, delta] of Object.entries(presets)) {
    for (const detail of ['full', 'low']) {
      const params = Object.assign({}, D, delta);
      const tex = new THREE.Texture();
      const g = SI.TYPES['photo-frame'].build(THREE, Object.assign({}, params, { image: 'page-preview', textureLoader: () => tex }), { detail });
      const r = P.applyPhotoSpan(THREE, g, tex, 3 / 2);
      const pics = [];
      g.traverse(o => { if (o.isMesh && o.material.map && o.material.map.source === tex.source) pics.push(o); });
      const n = Math.max(1, Math.round(params.panels));
      const tag = name + ' (' + detail + ')';
      check(tag + ': every panel shows the image (' + n + ')', r.panels === n && pics.length === n, [r.panels, pics.length]);
      check(tag + ': each panel has its own slice (no shared texture or material)',
        new Set(pics.map(o => o.material.map)).size === n && new Set(pics.map(o => o.material)).size === n && pics.every(o => o.material.map !== tex));
      const xs = pics.map(o => new THREE.Box3().setFromObject(o).min.x);
      const byX = pics.slice().sort((a, b) => new THREE.Box3().setFromObject(a).min.x - new THREE.Box3().setFromObject(b).min.x);
      check(tag + ': the slices run left to right across the panels',
        byX.every((o, i) => i === 0 || o.material.map.offset.x > byX[i - 1].material.map.offset.x), xs);
      const u0 = byX[0].material.map.offset.x, u1 = byX[n - 1].material.map.offset.x + byX[n - 1].material.map.repeat.x;
      check(tag + ': together they span a centred, uncropped-or-cover-cropped width of the image',
        near(u0, 1 - u1, 1e-9) && u1 <= 1 + 1e-9 && u0 >= -1e-9, [u0, u1]);
      let bars = 0;
      g.traverse(o => { if (o.isMesh && !pics.includes(o) && o.material.map) bars++; });
      check(tag + ': the frame bars keep their plain material', bars === 0, bars);
      check(tag + ': the slices and their materials are handed back for disposal', r.disposables.length === 2 * n);
    }
  }
}

// ---- 3. SmallItemsSpec: page-only, every preset -------------------------------------
// Static checks: a grep cannot prove behaviour, the browser pass does; these
// catch the regressions a diff would slip in. Mutations: gate the control
// on a preset name -> "offered for the type" fails; add fetch()/storage ->
// "never sent or stored" fails; pass photo params through `params` ->
// "Copy JSON" fails.
{
  const html = fs.readFileSync(path.join(root, 'specs/SmallItemsSpec.html'), 'utf8');
  const code = html.replace(/<!--[\s\S]*?-->/g, '');
  check('the preview control is offered for the photo-frame TYPE (every preset)', /\{type === 'photo-frame' && \(\s*<div id="photoPreview">/.test(code));
  // ...and the preview reaches every build of the TYPE, whatever the preset.
  // Mutations: `photo: type === 'photo-frame' && activePreset === ... ?` ->
  // fails; drop the spanPhoto call in buildItem -> fails.
  check('every photo-frame build gets the preview (t.photo keyed on the type alone)',
    /photo: type === 'photo-frame' \? photo : null/.test(code), null);
  check('buildItem spans the preview over the panels after building', /if \(t\.photo\) spanPhoto\(THREE, built, t\.photo\);/.test(code) &&
    /function spanPhoto\(THREE, built, photo\) \{\s*photoSlices = window\.PhotoSpan\.applyPhotoSpan\(THREE, built, photo\.tex, photo\.aspect\)\.disposables;/.test(code));
  // The per-panel clones are freed on the next rebuild -- from a page-level
  // list, since ThreeView empties ctx before each rebuild (a list on ctx was
  // never freed). Mutation: keep them on ctx again -> fails.
  check('the per-panel slices live in a page-level list freed before each rebuild',
    /let photoSlices = \[\];/.test(code) && /disposePhotoSlices\(\);\s*if \(t\.photo\)/.test(code) && !/ctx\.photoSlices/.test(code));
  check('a file input for images', /<input id="photoFile" type="file" accept="image\/\*"/.test(code));
  check('the file is read in the browser (URL.createObjectURL) and its URL revoked on replace/clear',
    /URL\.createObjectURL\(file\)/.test(code) && /URL\.revokeObjectURL\(prev\.url\)/.test(code));
  const banned = ['fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'indexedDB', 'sendBeacon', 'FormData', 'WebSocket'];
  check('never sent or stored: the page uses no network or storage API', banned.every(b => code.indexOf(b) === -1), banned.filter(b => code.indexOf(b) !== -1));
  check('Copy JSON reads params, and only the build-params copy carries the preview',
    /diffFromDefaults\(type, params\)/.test(code) && (code.match(/textureLoader/g) || []).length === 1 &&
    /if \(t\.photo\) params = Object\.assign\(\{\}, params, \{ image: 'page-preview', textureLoader: \(\) => t\.photo\.tex \}\)/.test(code));
  check('a page-drawn test pattern, so the span can be checked without a file', /function testPatternCanvas\(\)/.test(code) && /onClick=\{useTestPattern\}/.test(code));
  check('the page imports the span module', /import \* as PhotoSpan from '\.\.\/src\/photo-span\.js'/.test(code));
}

// ---- 4. RugSpec: a failed ?texture= is visible ---------------------------------------
// Mutation: drop the dispatch in the TextureLoader error callback (back to a
// console.warn only) -> fails.
{
  const html = fs.readFileSync(path.join(root, 'specs/RugSpec.html'), 'utf8');
  const cb = html.slice(html.indexOf('new THREE.TextureLoader().load(TEXTURE_URL'), html.indexOf('/** Where the ?texture= image comes from'));
  check('the load error callback raises rug-texture-failed', /window\.dispatchEvent\(new Event\('rug-texture-failed'\)\)/.test(cb) && /textureFailed = true/.test(cb));
  check('the App renders a visible warning on it', /window\.addEventListener\('rug-texture-failed'/.test(html) && /<div className="warn" id="textureWarning" role="alert">/.test(html) && /<TextureWarning \/>/.test(html));
  check('the warning names CORS (Access-Control-Allow-Origin)', /Access-Control-Allow-Origin/.test(html.slice(html.indexOf('function TextureWarning'))));
}

// ---- no DOM in the module -------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(root, 'src/photo-span.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const bannedSrc = ['document', 'window', 'navigator', 'Image(', 'import '];
  check('photo-span.js names no DOM global and imports nothing (THREE is injected)', bannedSrc.every(b => src.indexOf(b) === -1), bannedSrc.filter(b => src.indexOf(b) !== -1));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
