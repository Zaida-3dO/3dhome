#!/usr/bin/env node
/**
 * Theme: Auto / Dark / Light (src/theme.js, the inline <head> script in
 * index.html, and the Settings row). No framework, no install:
 * `node scripts/test-theme.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. Default resolution: nothing stored (or junk, or storage that throws)
 *      is Auto, and Auto follows prefers-color-scheme.
 *   2. Persistence: a manual choice is stored and restored by a fresh
 *      controller; choosing Auto clears it; a refusing store is survived.
 *   3. The prefers-color-scheme listener: while Auto, a system flip re-themes
 *      live; with a manual choice it does not. The old addListener API works
 *      too, and dispose() unsubscribes.
 *   4. applyTheme writes data-theme, data-theme-pref, color-scheme
 *      ('only light' for Light, which opts out of forced dark) and the meta.
 *   5. The inline pre-paint script agrees with the module for every
 *      (stored value x system) combination.
 *   6. index.html and the popover carry the wiring and the light rules.
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
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}

const T = await imp('src/theme.js');

// ---- fakes --------------------------------------------------------------
function makeStorage(init = {}, { throwOnGet = false, throwOnSet = false } = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    getItem(k) { if (throwOnGet) throw new Error('SecurityError'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (throwOnSet) throw new Error('QuotaExceeded'); m.set(k, String(v)); },
    removeItem(k) { if (throwOnSet) throw new Error('QuotaExceeded'); m.delete(k); }
  };
}
function makeWin(dark, { legacy = false } = {}) {
  const listeners = new Set();
  const mq = { get matches() { return win.dark; }, media: T.DARK_QUERY };
  if (legacy) { mq.addListener = f => listeners.add(f); mq.removeListener = f => listeners.delete(f); }
  else { mq.addEventListener = (t, f) => t === 'change' && listeners.add(f); mq.removeEventListener = (t, f) => listeners.delete(f); }
  const win = {
    dark,
    matchMedia: q => { if (q !== T.DARK_QUERY) throw new Error('unexpected query ' + q); return mq; },
    flip(d) { win.dark = d; listeners.forEach(f => f({ matches: d })); },
    listenerCount: () => listeners.size
  };
  return win;
}
function makeDoc() {
  const attrs = {}, meta = { content: 'dark', setAttribute(k, v) { if (k === 'content') this.content = v; } };
  return {
    meta,
    documentElement: { style: {}, setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: k => attrs[k] },
    querySelector: sel => (sel === 'meta[name="color-scheme"]' ? meta : null),
    attrs
  };
}
const state = d => ({ theme: d.attrs['data-theme'], pref: d.attrs['data-theme-pref'], scheme: d.documentElement.style.colorScheme, meta: d.meta.content });

// 1. default resolution ----------------------------------------------------
check('THEME_PREFS is auto/dark/light', JSON.stringify(T.THEME_PREFS) === '["auto","dark","light"]');
check('nothing stored -> auto', T.readPref(makeStorage()) === 'auto');
check('junk stored -> auto', T.readPref(makeStorage({ [T.THEME_KEY]: 'purple' })) === 'auto');
check('throwing storage -> auto', T.readPref(makeStorage({}, { throwOnGet: true })) === 'auto');
check('null storage -> auto', T.readPref(null) === 'auto');
check('auto + system dark -> dark', T.resolveTheme('auto', true) === 'dark');
check('auto + system light -> light', T.resolveTheme('auto', false) === 'light');
check('dark wins over a light system', T.resolveTheme('dark', false) === 'dark');
check('light wins over a dark system', T.resolveTheme('light', true) === 'light');
check('no matchMedia -> treated as dark', T.systemPrefersDark({}) === true);
check('matchMedia reports light', T.systemPrefersDark(makeWin(false)) === false);
{
  const d = makeDoc(), w = makeWin(false);
  const c = T.createThemeController(w, d, makeStorage());
  check('fresh controller: pref auto', c.pref === 'auto');
  check('fresh controller on a light system paints light', state(d).theme === 'light' && state(d).pref === 'auto', state(d));
}

// 2. persistence -----------------------------------------------------------
{
  const st = makeStorage();
  check('writePref light stores it', T.writePref(st, 'light') && st.map.get(T.THEME_KEY) === 'light');
  check('writePref auto clears the key', T.writePref(st, 'auto') && !st.map.has(T.THEME_KEY));
  check('writePref on a refusing store returns false, does not throw', T.writePref(makeStorage({}, { throwOnSet: true }), 'dark') === false);

  const d1 = makeDoc(), w = makeWin(true), store = makeStorage();
  const c1 = T.createThemeController(w, d1, store);
  c1.set('light');
  check('set(light) paints light at once', state(d1).theme === 'light', state(d1));
  check('set(light) is stored', store.map.get(T.THEME_KEY) === 'light');
  const d2 = makeDoc();
  const c2 = T.createThemeController(w, d2, store);
  check('a fresh controller restores the stored choice', c2.pref === 'light' && state(d2).theme === 'light', state(d2));
  c2.set('auto');
  check('choosing auto clears storage and follows the (dark) system', !store.map.has(T.THEME_KEY) && state(d2).theme === 'dark');
  const d3 = makeDoc();
  const c3 = T.createThemeController(makeWin(false), d3, makeStorage({}, { throwOnSet: true, throwOnGet: true }));
  c3.set('dark');
  check('a refusing store still applies the choice for this session', state(d3).theme === 'dark');
}

// 3. the prefers-color-scheme listener --------------------------------------
{
  const d = makeDoc(), w = makeWin(true);
  const c = T.createThemeController(w, d, makeStorage());
  check('auto on a dark system: dark', state(d).theme === 'dark');
  w.flip(false);
  check('auto: system flips to light -> light, live', state(d).theme === 'light', state(d));
  w.flip(true);
  check('auto: system flips back -> dark', state(d).theme === 'dark');
  c.set('dark');
  w.flip(false);
  check('manual dark ignores a system flip to light', state(d).theme === 'dark', state(d));
  c.set('light');
  w.flip(true);
  check('manual light ignores a system flip to dark', state(d).theme === 'light');
  c.dispose();
  check('dispose() unsubscribes', w.listenerCount() === 0);

  const dl = makeDoc(), wl = makeWin(true, { legacy: true });
  T.createThemeController(wl, dl, makeStorage());
  wl.flip(false);
  check('legacy addListener path follows the system too', state(dl).theme === 'light');
}

// 4. applyTheme output -------------------------------------------------------
{
  const d = makeDoc();
  T.applyTheme(d, 'light', true);
  check('light: data-theme, pref, only light, meta', JSON.stringify(state(d)) === JSON.stringify({ theme: 'light', pref: 'light', scheme: 'only light', meta: 'only light' }), state(d));
  T.applyTheme(d, 'auto', true);
  check('auto on dark: dark scheme, pref auto', JSON.stringify(state(d)) === JSON.stringify({ theme: 'dark', pref: 'auto', scheme: 'dark', meta: 'dark' }), state(d));
}

// 5. the inline pre-paint script agrees with the module ----------------------
const html = read('index.html');
{
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const inline = scripts.find(s => s.includes('home3d.theme'));
  check('index.html has the inline theme script', !!inline);
  const headEnd = html.indexOf('</head>'), at = html.indexOf(inline || '###');
  check('it is in <head>, before first paint', at > 0 && at < headEnd);
  check('it uses the module\'s storage key', inline && inline.includes("'" + T.THEME_KEY + "'"));
  let agree = true; const seen = [];
  for (const stored of [null, 'auto', 'dark', 'light', 'junk']) {
    for (const sys of [true, false]) {
      const doc = makeDoc(), win = makeWin(sys);
      const store = makeStorage(stored == null ? {} : { [T.THEME_KEY]: stored });
      vm.runInNewContext(inline, { window: win, document: doc, localStorage: store });
      const ref = makeDoc();
      T.applyTheme(ref, T.readPref(store), sys);
      const a = state(doc), b = state(ref);
      seen.push([stored, sys, a.theme]);
      if (JSON.stringify(a) !== JSON.stringify(b)) { agree = false; console.error('       inline', a, 'module', b, stored, sys); }
    }
  }
  check('inline script == module for every stored value x system', agree, seen);
  const doc = makeDoc();
  vm.runInNewContext(inline, { window: {}, document: doc, get localStorage() { throw new Error('SecurityError'); } });
  check('inline script survives blocked storage and no matchMedia (-> dark)', state(doc).theme === 'dark' && state(doc).pref === 'auto', state(doc));
}

// 6. wiring and light rules ------------------------------------------------
{
  check('index.html imports the controller', /import \{ createThemeController \} from '\.\/src\/theme\.js\?v=__VERSION__';/.test(html));
  check('index.html creates it', /const themeCtl = createThemeController\(window, document,/.test(html));
  for (const v of ['auto', 'dark', 'light']) check('Theme row has a ' + v + ' button', html.includes("themeBtn('" + v + "'"));
  check('a Theme button click sets the choice', /themeCtl\.set\(btn\.dataset\.themeChoice\)/.test(html));
  check('buttons expose aria-pressed', /aria-pressed="' \+ \(themePref === val\)/.test(html));
  const css = html.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of ['.panel', '.top-btn', '.toggle', '.slider', '.row-ib', '.sun-mode-btn', '.room-list-item', '.ha-status', '.spec-btn'])
    check('light rule for ' + sel, css.includes(':root[data-theme="light"] ' + sel));
  check('light theme declares only light', /:root\[data-theme="light"\] \{ color-scheme: only light; \}/.test(css));
  for (const sel of ['.plant-list', '.plant-row svg', '.plant-st.ok', '.plant-st.dry', '.plant-st.wet', '.kbd-hint'])
    check('light rule for ' + sel, css.includes(':root[data-theme="light"] ' + sel));
  check('no inline-styled keyboard hint left (it could not be re-themed)', !html.includes('<span style="opacity:0.4;font-weight:400;">'));
  const TP = await imp('src/tap-popovers.js');
  const lp = (TP.STYLE.match(/:root\[data-theme="light"\] \.tp-pop \{([^}]*)\}/) || [])[1] || '';
  check('popover has a light rule re-pointing its tokens',
    /color-scheme: only light/.test(lp) && /--ink:#1a1d29/.test(lp) && /--pop-bg:/.test(lp) && /--pop-border:/.test(lp) && /--range-track:/.test(lp), lp);
}

// 7. light-theme contrast, measured from the CSS source ---------------------
// WCAG contrast of the declared colours: chip text on its tint (the tint
// composited over the panel or card), icons on the panel or card. Text needs
// 4.5:1, icons 3:1.
{
  const TP = await imp('src/tap-popovers.js');
  const css = (html + '\n' + TP.STYLE).replace(/\/\*[\s\S]*?\*\//g, '');
  const rgba = str => {
    let m = str.match(/^#([0-9a-f]{6})$/i);
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
    m = str.match(/^rgba?\(([^)]*)\)$/);
    if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    throw new Error('colour? ' + str);
  };
  const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  const lum = c => { const l = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // The declaration `prop` in the LIGHT rule whose selector list contains `sel`.
  const lightDecl = (sel, prop) => {
    const re = /([^{}]+)\{([^{}]*)\}/g; let m;
    while ((m = re.exec(css))) {
      const sels = m[1].split(',').map(x => x.trim());
      if (sels.includes(':root[data-theme="light"] ' + sel)) {
        const d = m[2].match(new RegExp('(?:^|[;\\s])' + prop + ':\\s*([^;]+)'));
        if (d) return d[1].trim();
      }
    }
    return null;
  };
  const PANEL = over(rgba('rgba(248,249,252,0.95)'), [255, 255, 255, 1]);
  const CARD = over(rgba('rgba(250,251,253,0.96)'), [255, 255, 255, 1]);
  const r2 = x => Math.round(x * 100) / 100;
  for (const [sel, base] of [['.plant-st.ok', PANEL], ['.plant-st.dry', PANEL], ['.plant-st.wet', PANEL], ['.tp-pst.ok', CARD], ['.tp-pst.dry', CARD], ['.tp-pst.wet', CARD]]) {
    const fg = lightDecl(sel, 'color'), bg = lightDecl(sel, 'background');
    const c = fg && bg ? ratio(rgba(fg), over(rgba(bg), base)) : 0;
    check('light ' + sel + ' text >= 4.5:1 (' + r2(c) + ')', c >= 4.5, { fg, bg });
  }
  for (const [sel, base] of [['.plant-row svg', PANEL], ['.plant-row svg.p-ok', PANEL], ['.plant-row svg.p-dry', PANEL], ['.plant-row svg.p-wet', PANEL], ['.tp-pmoist svg', CARD], ['.tp-pmoist.muted svg', CARD]]) {
    const fill = lightDecl(sel, 'fill');
    const c = fill ? ratio(rgba(fill), base) : 0;
    check('light ' + sel + ' icon >= 3:1 (' + r2(c) + ')', c >= 3, fill);
  }
  // Keyboard hint: panel ink at (label opacity x hint opacity) over the panel.
  const labelOp = Number(lightDecl('.panel-toggle-label', 'opacity')), hintOp = Number(lightDecl('.kbd-hint', 'opacity'));
  const hint = ratio(over([26, 29, 41, labelOp * hintOp], PANEL), PANEL);
  check('light keyboard hint >= 4.5:1 (' + r2(hint) + ')', hint >= 4.5, { labelOp, hintOp });
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
