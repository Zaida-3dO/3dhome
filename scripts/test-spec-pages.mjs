#!/usr/bin/env node
/**
 * Spec pages: one page per FAMILY, every furniture type on exactly one page,
 * and ONE way to pick objects and variants on every page.
 * No framework, no install: `node scripts/test-spec-pages.mjs`.
 *
 * The vocabulary (specs/tweaks-panel.jsx, "Spec picker"):
 *   OBJECT   a different thing -- different builder type, different controls,
 *            or a different noun (a wardrobe vs a chest of drawers).
 *   VARIANT  the same object with different values on its own controls.
 * Each spec page declares its objects once, as JSON in
 * <script type="application/json" id="spec-manifest">, and renders exactly one
 * <SpecPage>; an object with presets renders <SpecVariants>.
 *
 * What this checks:
 *   1. index.html SPEC_PAGES: every path is a real spec page (not a redirect
 *      stub), listed once, under a heading in SPEC_GROUP_ORDER.
 *   2. No orphan: every real specs/*.html page is in SPEC_PAGES.
 *   3. Redirect stubs (old URLs of folded pages) point at a real page and at
 *      an object id that page declares.
 *   4. Every page has a valid manifest (title, >=1 object, unique ids).
 *   5. Registry: a type with a `spec` is listed by THAT page's manifest and by
 *      no other; every type whose module exists (except the internal `box`)
 *      has a spec; every type a manifest lists is registered. An empty
 *      `types` list is allowed only for fixtures that are not furniture
 *      (doors, windows, curtains).
 *   6. The picker contract, statically, on every page: loads tweaks-panel.jsx,
 *      renders <SpecPage exactly once, uses <SpecVariants when it has
 *      presets, and carries NONE of the switchers the pages used before
 *      (Tweaks-panel Type/Kind/Preset radios and selects, preset <select>s,
 *      pill rows, preset buttons mapped out of a PRESETS table, tab rows).
 *      The checker is itself mutation-tested against a snippet of each banned
 *      shape, so the ban list cannot rot into matching nothing.
 *   7. The picker's pure core (URL resolution, active-variant matching, query
 *      building), extracted from tweaks-panel.jsx and run here -- including
 *      active-variant matching over the REAL preset tables, where an `{}`
 *      delta and a preset that is a subset of another used to light the
 *      wrong chip.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.log('FAIL: ' + name + (detail !== undefined ? '\n      ' + JSON.stringify(detail) : ''));
}

// ------------------------------------------------------------------ inputs
const { REGISTRY } = await imp('src/furniture/registry.js');
const indexHtml = read('index.html');

const pagesBlock = (indexHtml.match(/const SPEC_PAGES = \[([\s\S]*?)\n\s*\];/) || [])[1] || '';
const SPEC_PAGES = [...pagesBlock.matchAll(/\{\s*name:\s*'([^']*)',\s*path:\s*'([^']*)',\s*group:\s*'([^']*)'\s*\}/g)]
  .map(m => ({ name: m[1], path: m[2], group: m[3] }));
const orderBlock = (indexHtml.match(/const SPEC_GROUP_ORDER = \[([\s\S]*?)\];/) || [])[1] || '';
const SPEC_GROUP_ORDER = [...orderBlock.matchAll(/'([^']+)'/g)].map(m => m[1]);

const specFiles = fs.readdirSync(path.join(root, 'specs')).filter(f => f.endsWith('.html')).sort();
const pages = {}; // file -> { html, stub: target|null, manifest|null }
for (const f of specFiles) {
  const html = read('specs/' + f);
  const alias = html.match(/<meta name="spec-alias" content="([^"]+)">/);
  let manifest = null, manifestError = null;
  const m = html.match(/<script type="application\/json" id="spec-manifest">([\s\S]*?)<\/script>/);
  if (m) { try { manifest = JSON.parse(m[1]); } catch (e) { manifestError = e.message; } }
  pages[f] = { html, stub: alias ? alias[1] : null, manifest, manifestError };
}
const realPages = specFiles.filter(f => !pages[f].stub);

check('SPEC_PAGES parsed (sanity: the regex still matches index.html)', SPEC_PAGES.length >= 10, SPEC_PAGES.length);
check('SPEC_GROUP_ORDER parsed', SPEC_GROUP_ORDER.length >= 3, SPEC_GROUP_ORDER);

// ------------------------------------------------ 1-2. SPEC_PAGES <-> files
const listed = new Map();
for (const sp of SPEC_PAGES) {
  const f = sp.path.replace(/^specs\//, '');
  check('SPEC_PAGES "' + sp.name + '" points into specs/', sp.path.startsWith('specs/'), sp.path);
  check('SPEC_PAGES "' + sp.name + '" -> ' + sp.path + ' exists', !!pages[f]);
  check('SPEC_PAGES "' + sp.name + '" -> ' + sp.path + ' is a real page, not a redirect stub', pages[f] && !pages[f].stub);
  check('SPEC_PAGES lists ' + sp.path + ' once', !listed.has(f));
  listed.set(f, sp);
  check('SPEC_PAGES "' + sp.name + '" heading "' + sp.group + '" is in SPEC_GROUP_ORDER (else it lands in "Other")',
    SPEC_GROUP_ORDER.includes(sp.group));
}
for (const f of realPages) check('no orphan page: specs/' + f + ' is listed in SPEC_PAGES', listed.has(f));
for (const g of SPEC_GROUP_ORDER) check('heading "' + g + '" has at least one built-in page', SPEC_PAGES.some(sp => sp.group === g));

// ------------------------------------------------------------- 3. stubs
for (const f of specFiles.filter(f => pages[f].stub)) {
  const [target, query] = pages[f].stub.split('?');
  const obj = new URLSearchParams(query || '').get('object');
  const t = pages[target];
  check('stub ' + f + ' -> ' + target + ' is a real page', !!t && !t.stub);
  check('stub ' + f + ' names an object', !!obj);
  check('stub ' + f + ' -> object "' + obj + '" is declared on ' + target,
    !!(t && t.manifest && t.manifest.objects.some(o => o.id === obj)));
  check('stub ' + f + ' redirects by script too (keeps other params + hash)',
    /location\.replace\(/.test(pages[f].html) && pages[f].html.includes("q.set('object', '" + obj + "')"));
}

// ---------------------------------------------------------- 4. manifests
// Pages whose objects are not furniture registry types (building fixtures,
// and the rug, a procedural look that is not a furniture type yet).
const FIXTURE_PAGES = new Set(['DoorSpec.html', 'WindowSpec.html', 'CurtainSpec.html', 'RugSpec.html']);
for (const f of realPages) {
  const { manifest: mf, manifestError } = pages[f];
  check(f + ' has a parseable spec-manifest', !!mf, manifestError);
  if (!mf) continue;
  check(f + ' manifest has a title', typeof mf.title === 'string' && mf.title.length > 0);
  check(f + ' manifest declares at least one object', Array.isArray(mf.objects) && mf.objects.length > 0);
  const ids = (mf.objects || []).map(o => o.id);
  check(f + ' manifest object ids are unique', new Set(ids).size === ids.length, ids);
  for (const o of mf.objects || []) {
    check(f + ' object "' + o.id + '" has id, label and a types array',
      typeof o.id === 'string' && /^[a-z0-9-]+$/.test(o.id) && typeof o.label === 'string' && Array.isArray(o.types), o);
    if (Array.isArray(o.types) && o.types.length === 0) {
      check(f + ' object "' + o.id + '" lists no registry type -- allowed only on a fixture page', FIXTURE_PAGES.has(f));
    }
  }
}

// ------------------------------------------------------------ 5. registry
const typePages = new Map(); // type -> Set(files)
for (const f of realPages) {
  for (const o of ((pages[f].manifest || {}).objects || [])) {
    for (const t of o.types || []) {
      check(f + ' object "' + o.id + '" type "' + t + '" is registered', Object.prototype.hasOwnProperty.call(REGISTRY, t));
      if (!typePages.has(t)) typePages.set(t, new Set());
      typePages.get(t).add(f);
    }
  }
}
for (const [type, entry] of Object.entries(REGISTRY)) {
  const moduleExists = fs.existsSync(path.join(root, 'src/furniture', entry.path));
  if (type !== 'box' && moduleExists) {
    check('registry "' + type + '" (module exists) names a spec page', !!entry.spec, entry);
  }
  if (!entry.spec) continue;
  const f = entry.spec + '.html';
  check('registry "' + type + '" spec ' + f + ' is a real page', !!pages[f] && !pages[f].stub);
  const on = typePages.get(type) || new Set();
  check('registry "' + type + '" is listed by its own spec page ' + f, on.has(f), [...on]);
  check('registry "' + type + '" is listed by exactly one page', on.size === 1, [...on]);
}

// ------------------------------------------------ 6. the picker contract
// Every switcher shape the pages used before the shared picker, plus the
// generic "a presets/types table mapped into buttons or options" shape.
const BANNED = [
  [/<Tweak(Radio|Select|Button)\s+label="(Type|Kind|Preset|Item type|Panel type)"/, 'a Tweaks-panel Type/Kind/Preset control'],
  [/presetSelect/, 'the cabinet preset <select>'],
  [/<select[^>]*\bid="preset"/, 'a preset <select>'],
  [/className=["'{][^>]*\b(type-picker|preset-picker|type-btn|preset-btn)\b/, 'a pill row'],
  [/className="seg"/, 'a segmented object/kind switcher'],
  [/\bPresetButtons\b/, 'preset buttons'],
  [/onClick=\{\(\) => setTab\(/, 'a tab row'],
  [/onClick=\{\(\) => setTweak\('(itemType|panelType|kind|clockKind|slatPreset|preset|chairAlone)'/, 'a button that sets an object/variant key'],
  [/\b\w*(PRESET|ITEMS\b|TYPE_ORDER|VARIANT)\w*[^\n]*\.map\([^\n]*=>\s*\(?\s*\n?\s*<(button|TweakButton|option)\b/i, 'a presets/types/variants table rendered as buttons or options'],
];
function switcherViolations(src) {
  return BANNED.filter(([re]) => re.test(src)).map(([, why]) => why);
}
// Mutation cases: the checker must catch each shape it claims to ban.
const MUTANTS = [
  `<TweakRadio label="Type" value={t.itemType} options={[]} />`,
  `<TweakRadio label="Preset" value={t.slatPreset} />`,
  `<TweakSelect label="Kind" value={t.kind} options={['a']} />`,
  `<TweakSelect label="Preset" value={t.preset} options={['custom']} />`,
  `<select id="presetSelect" value={k}>`,
  `<select id="preset" value={t.preset} onChange={f}>`,
  `<div className="type-picker">`,
  `<div className="preset-picker">`,
  `<div className="seg">`,
  `<PresetButtons setTweak={setTweak} />`,
  `onClick={() => setTab(it.key)}`,
  `<button className="btn" onClick={() => setTweak('itemType', 'ottoman')}>Ottoman</button>`,
  `<button className="btn" onClick={() => setTweak('panelType', 'slat-panel')}>Slat</button>`,
  `{Object.keys(PRESETS).map(name => (\n  <button key={name} onClick={() => applyPreset(name)}>{name}</button>`,
  `{Object.entries(M.PRESETS).map(([id, p]) => (\n  <TweakButton key={id} label={p.label} />`,
  `{K.KITCHEN_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}`,
  `{ITEMS.map(it => <button key={it.key}>{it.label}</button>)}`,
  `{variants.map(v => <button key={v.id} onClick={() => pick(v.id)}>{v.label}</button>)}`,
  `{presetNames.map(pn => (\n  <button key={pn} onClick={() => selectPreset(pn)}>{pn}</button>`,
];
for (const src of MUTANTS) check('the switcher ban catches: ' + src.split('\n')[0].slice(0, 70), switcherViolations(src).length > 0);
check('the switcher ban does not flag the shared picker itself',
  switcherViolations(`<SpecVariants variants={variants} values={t} onSelect={applyPreset} />`).length === 0);

for (const f of realPages) {
  const html = pages[f].html;
  check(f + ' loads the shared harness (tweaks-panel.jsx)', /<script type="text\/babel" src="tweaks-panel\.jsx"><\/script>/.test(html));
  const n = (html.match(/<SpecPage\b/g) || []).length;
  check(f + ' renders <SpecPage exactly once', n === 1, n);
  check(f + ' has no alternative object/variant switcher', switcherViolations(html).length === 0, switcherViolations(html));
  const hasPresets = /\bPRESETS\b/.test(html) || /KITCHEN_PRESETS/.test(html) || /\.PRESETS\b/.test(html);
  if (hasPresets) check(f + ' has presets, so it offers them through <SpecVariants', /<SpecVariants\b/.test(html));
}

// ------------------------------------------------ 7. the picker's pure core
const tp = read('specs/tweaks-panel.jsx');
const core = (tp.match(/\/\* SPEC-PICKER-CORE-BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* SPEC-PICKER-CORE-END \*\//) || [])[1];
check('tweaks-panel.jsx has the SPEC-PICKER-CORE block', !!core);
const ctx = vm.createContext({ URLSearchParams });
vm.runInContext(core || '', ctx);
const { specActiveVariantId, specActiveVariantIds, specResolveObject, specSearchWith, specSame } = ctx;

// deep, key-order-free, colour-case-free equality
check('specSame: nested objects/arrays compare deeply, key order ignored',
  specSame({ a: [1, { b: 2, c: 3 }] }, { a: [1, { c: 3, b: 2 }] }));
check('specSame: a nested difference is a difference', !specSame({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }));
check('specSame: #RRGGBB colours compare case-insensitively', specSame('#3FC9B8', '#3fc9b8'));
check('specSame: other strings stay case-sensitive', !specSame('Oak', 'oak'));

// URL resolution
const ids = ['bed', 'ottoman'];
let r = specResolveObject(ids, '', 'bed', {});
check('resolve: no ?object= -> the default', r.objectId === 'bed' && !r.redirect && !r.warning, r);
r = specResolveObject(ids, '?object=ottoman', 'bed', {});
check('resolve: ?object=ottoman -> ottoman', r.objectId === 'ottoman' && !r.warning, r);
r = specResolveObject(ids, '?object=sofa', 'bed', {});
check('resolve: an unknown object falls back to the default, with a warning', r.objectId === 'bed' && !!r.warning && !r.redirect, r);
r = specResolveObject(['digital-piano'], '?object=ottoman&x=1', 'digital-piano', { ottoman: 'BedSpec.html' });
check('resolve: a moved object redirects to its new page, keeping other params',
  r.redirect === 'BedSpec.html?object=ottoman&x=1', r);
r = specResolveObject(ids, '', 'nope', {});
check('resolve: a default the page does not have -> the first object', r.objectId === 'bed', r);

// query building
check('search: sets object before variant, keeps other params first',
  specSearchWith('?variant=v&house=demo', { object: 'o' }) === '?house=demo&object=o&variant=v', specSearchWith('?variant=v&house=demo', { object: 'o' }));
check('search: null removes a key', specSearchWith('?object=o&variant=v', { variant: null }) === '?object=o');
check('search: removing the last key gives the empty string', specSearchWith('?variant=v', { variant: null }) === '');

// active-variant matching: the rules
const V = [
  { id: 'plain', params: { a: 1, b: 2 } },
  { id: 'plus', params: { a: 1, b: 2, c: 3 } },
  { id: 'other', params: { a: 9, b: 2 } },
];
check('active: exact match wins', specActiveVariantId(V, { a: 9, b: 2 }) === 'other');
check('active: when one preset is a subset of another, the MORE specific one wins',
  specActiveVariantId(V, { a: 1, b: 2, c: 3 }) === 'plus');
check('active: the subset preset is still found when the extra key differs',
  specActiveVariantId(V, { a: 1, b: 2, c: 4 }) === 'plain');
check('active: no match -> null (Custom)', specActiveVariantId(V, { a: 5, b: 5 }) === null);
check('active: two presets with identical values both light',
  JSON.stringify(specActiveVariantIds([{ id: 'x', params: { a: 1 } }, { id: 'y', params: { a: 1 } }], { a: 1 })) === '["x","y"]');
check('active: an empty-params variant never matches (it would match everything)',
  specActiveVariantId([{ id: 'empty', params: {} }], { a: 1 }) === null);

// ...and over the REAL preset tables: every variant, given its own resolved
// values, lights itself; nudging one of its values lights something else.
function pageConst(file, name) {
  const src = pages[file].html;
  const i = src.indexOf('const ' + name + ' = ');
  if (i < 0) return undefined;
  let j = src.indexOf('=', i) + 1;
  while (/\s/.test(src[j])) j++;
  const open = src[j], close = open === '{' ? '}' : ']';
  let depth = 0, k = j, str = null;
  for (; k < src.length; k++) {
    const c = src[k];
    if (str) { if (c === '\\') k++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') { str = c; continue; }
    if (src.startsWith('//', k)) { k = src.indexOf('\n', k); continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) break;
  }
  return vm.runInNewContext('(' + src.slice(j, k + 1) + ')');
}
function nudge(v) {
  if (typeof v === 'number') return v + 7;
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'string') return /^#[0-9a-f]{6}$/i.test(v) ? '#012345' : v + '-x';
  return { nudged: true };
}
function tableCheck(label, variants, resolve) {
  check(label + ': has variants to test', variants.length > 0);
  for (const v of variants) {
    const values = resolve(v);
    const lit = specActiveVariantIds(variants, values);
    check(label + ': "' + v.id + '" lights itself', lit.includes(v.id), lit);
    // lighting anything ELSE too is only right when that preset has the very
    // same values (a duplicate in the table)
    check(label + ': "' + v.id + '" lights no preset with different values',
      lit.every(id => specSame(variants.find(x => x.id === id).params, v.params)), lit);
    const k = Object.keys(v.params)[0];
    const moved = Object.assign({}, values, { [k]: nudge(values[k]) });
    check(label + ': "' + v.id + '" with ' + k + ' moved no longer lights "' + v.id + '"',
      !specActiveVariantIds(variants, moved).includes(v.id));
  }
}

// Small items: presets are DELTAS over each type's DEFAULTS, including `{}`
// deltas and the Floor-standing / Floor-standing (white satin) subset pair.
const SI = await imp('src/furniture/small-items.js');
const SI_PRESETS = pageConst('SmallItemsSpec.html', 'PRESETS');
check('SmallItemsSpec PRESETS extracted', !!SI_PRESETS && Object.keys(SI_PRESETS).length >= 10);
for (const type of Object.keys(SI_PRESETS || {})) {
  const variants = Object.keys(SI_PRESETS[type]).map(n => ({ id: n,
    params: Object.assign({}, SI.TYPES[type].DEFAULTS, SI_PRESETS[type][n]) }));
  tableCheck('small items ' + type, variants, v => Object.assign({}, v.params));
}
// Radiator: partial by design (a preset leaves colour/elevation alone).
const RAD = await imp('src/furniture/radiator.js');
tableCheck('radiator', RAD.PRESETS.map(p => ({ id: p.name, params: p.params })),
  v => Object.assign({}, RAD.DEFAULTS, { elevation: 12, color: '#ffffff' }, v.params));
// 365c4c72 (3): cross-check against the PAGE'S OWN variants builder rather
// than only the hand-rebuilt list above. RadiatorSpec.html's radiatorVariants()
// is a standalone top-level function (unlike every other page's variants,
// which are inline expressions inside App() closing over component-local
// state/functions -- rendering those faithfully needs a real browser, which
// this repo does not have; see test-spec-module-scope.mjs's own doc comment
// on the same limitation). Cheap here because it is pure and only needs
// `window.FurnitureRadiator` to be set to the real module: extract its
// source text verbatim and eval it, so a change to how the PAGE composes its
// variants (not just to radiator.js's own data) is caught too.
{
  const radSrc = pages['RadiatorSpec.html'].html;
  const idFnSrc = (radSrc.match(/const radiatorVariantId = [^\n]+/) || [])[0];
  const fnSrc = (radSrc.match(/function radiatorVariants\(\)\s*\{[\s\S]*?\n\}/) || [])[0];
  check('RadiatorSpec.html: radiatorVariantId + radiatorVariants() extracted', !!idFnSrc && !!fnSrc, { idFnSrc, fnSrc });
  if (idFnSrc && fnSrc) {
    const radCtx = vm.createContext({ window: { FurnitureRadiator: RAD } });
    const pageVariants = vm.runInContext(idFnSrc + '\n' + fnSrc + '\n;radiatorVariants()', radCtx);
    const expected = RAD.PRESETS.map(p => ({ id: p.name.split(':')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), params: p.params }));
    const pageVariantsNoLabel = pageVariants.map(v => ({ id: v.id, params: v.params }));
    check('RadiatorSpec.html: radiatorVariants() matches the hand-built table this test cross-checks against (same ids, same params)',
      JSON.stringify(pageVariantsNoLabel) === JSON.stringify(expected), { pageVariants: pageVariantsNoLabel, expected });
    tableCheck('radiator (page\'s own radiatorVariants())', pageVariants,
      v => Object.assign({}, RAD.DEFAULTS, { elevation: 12, color: '#ffffff' }, v.params));
  }
}
// The other real-table pages below (gaming chair, plant, cabinet, dining,
// clock, kitchen) build their variants INLINE inside App(), closing over
// component-local state/functions (initialState, applyPreset, JSX-scoped
// consts) -- extracting them faithfully would mean actually rendering the
// component, which needs a real or headless browser (Playwright/Puppeteer).
// That is not part of this repo's toolchain (no package.json, no
// node_modules, no bundler) and is judged out of scope to add for this one
// widening, so those tables stay hand-rebuilt below as before -- reported
// here rather than silently left as-is.
// Not a check() -- there is no pass/fail condition here, only a note that
// these six pages' own variants builders are not cross-checked (see the
// comment above). A `check(..., true)` here would always pass and inflate
// the pass count with a tautology; log it instead.
console.log('SKIP spec-variants real-table cross-check: gaming chair/plant/cabinet/dining/clock/kitchen variants stay hand-rebuilt (extracting their own inline builders would require a real/headless browser render, which this repo does not have)');
// Gaming chair colourways.
const GC = await imp('src/furniture/gaming-chair.js');
tableCheck('gaming chair', Object.keys(GC.PRESETS).map(id => ({ id, params: { primaryColor: GC.PRESETS[id].primaryColor } })),
  v => Object.assign({}, GC.DEFAULTS, v.params));
// Plant presets (full sets per kind).
const PL = await imp('src/furniture/plant.js');
for (const kind of PL.KINDS) {
  // the page passes FULLY resolved params (DEFAULTS + preset)
  tableCheck('plant ' + kind, Object.keys(PL.PRESETS).filter(n => PL.PRESETS[n].kind === kind)
    .map(n => ({ id: n, params: Object.assign({}, PL.DEFAULTS, PL.PRESETS[n]) })), v => Object.assign({}, v.params));
}
// Cabinet presets: nested fronts grids -- deep equality matters here.
// (the cabinet page adds its mirror-cabinet presets after the literal, via
// window.cabinetModuleReady.then(...) reading src/furniture/cabinet.js's own
// MIRROR_CABINET_PRESETS (item 365c4c72 (5)) -- so run its whole presets
// section, with `window.CabinetFurniture` set to the real module, rather
// than lifting the PRESETS literal alone)
const CAB_MODULE = await imp('src/furniture/cabinet.js');
const cabSrc = pages['CabinetSpec.html'].html;
const cabSection = cabSrc.slice(cabSrc.indexOf('const PRESETS = {'), cabSrc.indexOf('const TWEAK_DEFAULTS'))
  // The real page assigns the mirror-cabinet presets inside a
  // `window.cabinetModuleReady.then(() => { ... })` callback (deferred until
  // the module import resolves); here the module is already available
  // synchronously, so the callback is invoked immediately in place.
  .replace(/window\.cabinetModuleReady\.then\(\(\) => \{([\s\S]*?)\}\);/, '(() => {$1})();');
const { PRESETS: CAB, CABINET_OBJECTS: CAB_OBJ } =
  vm.runInNewContext(cabSection + '\n;({ PRESETS, CABINET_OBJECTS })', { window: { CabinetFurniture: CAB_MODULE } });
check('CabinetSpec PRESETS + CABINET_OBJECTS extracted', !!CAB && !!CAB_OBJ);
const cabKeys = Object.values(CAB_OBJ || {}).flat();
check('every cabinet preset belongs to exactly one object', cabKeys.length === Object.keys(CAB || {}).length &&
  new Set(cabKeys).size === cabKeys.length && cabKeys.every(k => CAB[k]), cabKeys);
for (const [obj, keys] of Object.entries(CAB_OBJ || {})) {
  tableCheck('cabinet ' + obj, keys.map(k => ({ id: k, params: CAB[k].params })), v => JSON.parse(JSON.stringify(v.params)));
}
// 365c4c72 (5): neither CabinetSpec.html nor BathroomFittingsSpec.html
// defines its own copy of mirrorCabinetParams()/the mirror-cabinet presets
// any more -- both must read src/furniture/cabinet.js's export. Mutation
// case: re-inline either page's own `function mirrorCabinetParams` (or an
// `EXTRA_PRESETS`/`PRESETS.mirrorCabinetNDoor = ...` literal fallback that
// does not go through window.CabinetFurniture/window.FurnitureCabinet) and
// this check fails.
{
  const bathSrc = pages['BathroomFittingsSpec.html'].html;
  check('CabinetSpec.html does not define its own mirrorCabinetParams (reads src/furniture/cabinet.js instead)',
    !/function\s+mirrorCabinetParams/.test(cabSrc) && /window\.CabinetFurniture\.MIRROR_CABINET_PRESETS/.test(cabSrc));
  check('BathroomFittingsSpec.html does not define its own mirrorCabinetParams (reads src/furniture/cabinet.js instead)',
    !/function\s+mirrorCabinetParams/.test(bathSrc) && /window\.FurnitureCabinet\.MIRROR_CABINET_PRESETS/.test(bathSrc));
  check('src/furniture/cabinet.js exports MIRROR_CABINET_PRESETS with both mirror-cabinet presets',
    !!CAB_MODULE.MIRROR_CABINET_PRESETS && Object.keys(CAB_MODULE.MIRROR_CABINET_PRESETS).length === 2, Object.keys(CAB_MODULE.MIRROR_CABINET_PRESETS || {}));
}
// A cabinet with one front changed deep inside the grid is Custom.
if (CAB && CAB.chestOfDrawers) {
  const edited = JSON.parse(JSON.stringify(CAB.chestOfDrawers.params));
  const firstRow = (edited.fronts || [])[0];
  if (firstRow && firstRow.cells) firstRow.cells[0].width += 1;
  check('cabinet: a change deep inside the fronts grid lights Custom',
    specActiveVariantId([{ id: 'c', params: CAB.chestOfDrawers.params }], edited) === null);
}
// Dining set + clock presets (full sets).
const DIN = pageConst('DiningSpec.html', 'PRESETS');
tableCheck('dining set', ['nested-set', 'pulled-out', 'larger-table'].map(id => ({ id, params: DIN[id] })),
  v => Object.assign({ detail: 'full', preset: 'x' }, v.params));
const CLK = pageConst('ClockSpec.html', 'PRESETS');
tableCheck('wall clock', Object.keys(CLK).map(id => ({ id, params: CLK[id] })), v => Object.assign({ clockLive: true }, v.params));
// Kitchen: presets of the whole kitchen, compared on every piece's params.
const KIT = await imp('src/furniture/kitchen.js');
const KEYS = { a: 'kitchen-base-run', b: 'kitchen-base-run', wall: 'kitchen-wall-run', wallB: 'kitchen-wall-run', fridge: 'fridge-freezer' };
const kitState = p => {
  const s = {};
  Object.keys(KEYS).forEach(k => { s[k] = Object.assign(JSON.parse(JSON.stringify(KIT.TYPES[KEYS[k]].DEFAULTS)), JSON.parse(JSON.stringify(p.items[k] || {}))); });
  s.wallTop = p.items.wallTop;
  return s;
};
const kitVariants = KIT.KITCHEN_PRESETS.map(p => ({ id: p.id, params: kitState(p) }));
tableCheck('kitchen', kitVariants, v => Object.assign({ lowDetail: false }, JSON.parse(JSON.stringify(v.params))));
{
  const edited = JSON.parse(JSON.stringify(kitVariants[0].params));
  edited.a.modules[0].width += 5;
  check('kitchen: resizing one module of one run lights Custom', specActiveVariantId(kitVariants, edited) === null);
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
