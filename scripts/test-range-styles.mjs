#!/usr/bin/env node
/**
 * Slider and popover styling contract. No framework, no install:
 * `node scripts/test-range-styles.mjs`.
 *
 * WHY. A range input whose parts are only partly styled leaves the rest to
 * the browser, and each browser (Chrome, Android Chrome, Samsung Internet,
 * Safari, a WebView) draws those parts its own way. The same card showed
 * an invisible track on one phone and a faint one on the tablet. A page that
 * does not declare `color-scheme: dark` is also eligible for Chrome's auto
 * dark theme and Samsung's dark web pages, which re-colour elements one by
 * one. This test holds the fix in place. CI has no headless browser, so it
 * reads the CSS source instead of computed styles.
 *
 * WHAT THIS GUARDS
 *   1. The popover's .tp-range and the sidebar's .slider each style EVERY
 *      part explicitly: appearance none, the WebKit track (a fill gradient
 *      up to --p), the Moz track, the Moz progress, and a WebKit and a Moz
 *      thumb with a size, a fill and a ring.
 *   2. The thumb is at least 24px on touch, inside a 44px hit area.
 *   3. The pointer diamond paints from the same --pop-bg / --pop-border
 *      variables as the card.
 *   4. color-scheme: dark is declared on the popover, on :root and in a
 *      <meta>.
 *   5. rangeFillPct maths, and every sidebar slider's markup carries --p.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}

// Collect every declaration block whose selector list contains `sel` exactly
// (as one comma-separated selector), and merge them.
function rules(css, sel) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1].split(',').map(x => x.trim().replace(/\s+/g, ' '));
    if (sels.includes(sel)) out.push(m[2]);
  }
  return out.join(';');
}
const has = (body, prop, valRe) => new RegExp('(^|[;\\s{])' + prop.replace(/[-]/g, '\\-') + '\\s*:\\s*' + valRe, 'm').test(body);

const TP = await imp('src/tap-popovers.js');
const RP = await imp('src/room-panel.js');
const indexHtml = read('index.html');
const indexCss = (indexHtml.match(/<style>([\s\S]*?)<\/style>/g) || []).join('\n');
// Strip comments so a commented-out rule cannot satisfy the check.
const strip = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const popCss = strip(TP.STYLE);
const sideCss = strip(indexCss);

function partsContract(label, css, base) {
  const input = rules(css, base);
  check(label + ': appearance none on the input', has(input, 'appearance', 'none') && has(input, '-webkit-appearance', 'none'), input);
  check(label + ': transparent input background', has(input, 'background', 'transparent'));
  const wtrack = rules(css, base + '::-webkit-slider-runnable-track');
  check(label + ': WebKit track has a height', has(wtrack, 'height', '\\S'), wtrack);
  check(label + ': WebKit track fills up to --p', /linear-gradient\([^;]*var\(--p\)[^;]*var\(--p\)/.test(wtrack), wtrack);
  const mtrack = rules(css, base + '::-moz-range-track');
  check(label + ': Moz track has height and background', has(mtrack, 'height', '\\S') && has(mtrack, 'background', '\\S'), mtrack);
  const mprog = rules(css, base + '::-moz-range-progress');
  check(label + ': Moz progress (filled part) has a background', has(mprog, 'background', '\\S'), mprog);
  for (const th of ['::-webkit-slider-thumb', '::-moz-range-thumb']) {
    const t = rules(css, base + th);
    check(label + th + ': size', has(t, 'width', 'var\\(--thumb\\)') && has(t, 'height', 'var\\(--thumb\\)'), t);
    check(label + th + ': fill', has(t, 'background', '\\S'), t);
    check(label + th + ': ring', has(t, 'border', '\\d+px solid'), t);
    check(label + th + ': halo shadow', has(t, 'box-shadow', '\\S'), t);
  }
  const wthumb = rules(css, base + '::-webkit-slider-thumb');
  check(label + ': WebKit thumb drops the UA appearance', has(wthumb, '-webkit-appearance', 'none'));
}

// 1. every part, both engines
partsContract('popover .tp-range', popCss, '.tp-range');
partsContract('sidebar .slider', sideCss, '.slider');

// 2. touch sizes
{
  const coarseThumb = +((TP.STYLE.match(/--thumb:(\d+)px;--track-h/) || [])[1]);
  check('popover: touch thumb >= 24px', coarseThumb >= 24, coarseThumb);
  check('popover: touch hit area (range height) >= 44px', TP.GEOM.coarse.rangeH >= 44, TP.GEOM.coarse.rangeH);
  check('popover: touch controls still do not overlap the slider', TP.hitOverlapPx(TP.GEOM.coarse) <= 0);
  const coarse = (sideCss.match(/@media \(pointer: coarse\) \{ \.slider \{([^}]*)\}/) || [])[1] || '';
  check('sidebar: touch thumb >= 24px', +((coarse.match(/--thumb:\s*(\d+)px/) || [])[1]) >= 24, coarse);
  check('sidebar: touch hit area >= 44px', +((coarse.match(/height:\s*(\d+)px/) || [])[1]) >= 44, coarse);
}

// 3. the pointer diamond matches the card
{
  const pop = rules(popCss, '.tp-pop');
  const arrow = rules(popCss, '.tp-arrow');
  check('card paints from --pop-bg / --pop-border', has(pop, 'background', 'var\\(--pop-bg\\)') && has(pop, 'border', '1px solid var\\(--pop-border\\)'), pop);
  check('diamond paints from --pop-bg / --pop-border', has(arrow, 'background', 'var\\(--pop-bg\\)') && /var\(--pop-border\)/.test(arrow), arrow);
  check('no literal colour on the diamond', !/rgb|#[0-9a-f]{3}/i.test(arrow), arrow);
}

// 4. color-scheme
check('popover declares color-scheme: dark', has(rules(popCss, '.tp-pop'), 'color-scheme', 'dark'));
check(':root declares color-scheme: dark', has(rules(sideCss, ':root'), 'color-scheme', 'dark'));
check('<meta name="color-scheme" content="dark">', /<meta name="color-scheme" content="dark">/.test(indexHtml));

// 5. fill maths and markup
check('rangeFillPct 50 of 0..100', RP.rangeFillPct(50, 0, 100) === '50%');
check('rangeFillPct min -> 0%', RP.rangeFillPct(5, 5, 100) === '0%');
check('rangeFillPct max -> 100%', RP.rangeFillPct(100, 5, 100) === '100%');
check('rangeFillPct offset range', RP.rangeFillPct(21, 16, 26) === '50%', RP.rangeFillPct(21, 16, 26));
check('rangeFillPct clamps', RP.rangeFillPct(-5, 0, 100) === '0%' && RP.rangeFillPct(500, 0, 100) === '100%');
check('rangeFillPct degenerate range', RP.rangeFillPct(3, 5, 5) === '0%' && RP.rangeFillPct('x', 0, 1) === '0%');
{
  const s = { on: true, bri: 60, temp: 4000, color: [255, 0, 0] };
  const rows = [
    RP.mainLightRowHtml(s, false), RP.ambientRowHtml(s, 'Ambience', false, true), RP.galaxyRowHtml(s, false),
    RP.curtainRowHtml({ id: 'c1', label: 'Sheer' }, 25, true, false)
  ].join('');
  const inputs = rows.match(/<input type="range" class="slider[^>]*>/g) || [];
  check('sidebar rows render sliders', inputs.length >= 4, inputs.length);
  // Temperature has no fill: the warm-to-cool scale is the whole track.
  const filled = inputs.filter(i => !/class="slider temp"/.test(i));
  check('every sidebar fill slider carries --p', filled.length >= 4 && filled.every(i => /style="--p:[\d.]+%"/.test(i)), filled.filter(i => !/--p:/.test(i)));
  check('curtain 25% -> --p:25%', /value="25" style="--p:25%"/.test(rows));
  check('index.html keeps --p live on input', /querySelectorAll\('input\.slider'\)\.forEach\(el => el\.addEventListener\('input', \(\) => fillRange\(el\)\)\)/.test(indexHtml));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
