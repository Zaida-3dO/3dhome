#!/usr/bin/env node
/**
 * Config-loader tests. No framework, no dependencies - `node scripts/test-config-loader.mjs`.
 *
 * The cases that matter most are the ?house= rejections. That id becomes a URL
 * path segment (houses/<id>/geometry.json), so the character-class check in
 * asHouseId is a path-traversal guard. A regression there would not look like a
 * bug - it would look like the app quietly loading a different file - so it is
 * asserted here rather than left to review.
 *
 * src/config-loader.js is an ES module. See the long comment above `EXPORT_RE`
 * for why this test still compiles it as text instead of importing it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawSrc = fs.readFileSync(path.join(root, 'src/config-loader.js'), 'utf8');

// ---------------------------------------------------------------------------
// WHY THIS FILE IS COMPILED AS TEXT RATHER THAN `await import()`ed.
//
// config-loader.js reads the bare identifiers `window`, `document` and `fetch`.
// Every case below needs (a) its own fake `window.location.search`, and (b) a
// FRESH module instance, because HomeConfig memoises its resolution in a
// closure. `new Function('window','document','fetch', ...)` gives both: the
// parameters shadow the globals per call, and each call builds a new closure.
// `await import()` can do neither -- ESM caches a module per URL, and there is
// no per-import way to inject a fake `window` into it.
//
// The cost of that choice is this shim. `new Function` compiles a FUNCTION
// BODY, and a function body may not contain `export` -- it is a SyntaxError,
// not a warning. src/config-loader.js is an ES module and does export, so the
// keyword is stripped before compiling.
//
// The strip is ASSERTED rather than assumed. A silent no-op here would be the
// dangerous failure: if the module's shape changed and the regex stopped
// matching, `new Function` would throw and this file would fail loudly -- but
// if it changed such that the export vanished entirely, the tests would still
// pass while asserting against something other than what the browser loads.
// So: require exactly one `export const HomeConfig`, and fail the run if the
// file no longer looks like the module the app imports.
// ---------------------------------------------------------------------------
const EXPORT_RE = /^export\s+(const\s+HomeConfig\s*=)/m;
if (!EXPORT_RE.test(rawSrc)) {
  console.error(
    'FATAL  src/config-loader.js no longer matches /^export const HomeConfig =/m.\n' +
    '       This test compiles that file as a function body and must strip the\n' +
    '       `export` keyword to do so. If the module\'s export shape changed on\n' +
    '       purpose, update EXPORT_RE (and check the import in index.html);\n' +
    '       do NOT delete this check -- it is what stops these tests silently\n' +
    '       exercising a file the app does not actually load.'
  );
  process.exit(1);
}
const src = rawSrc.replace(EXPORT_RE, '$1');

// Belt and braces: nothing resembling a top-level ES module statement may
// survive into the text handed to `new Function`, or the SyntaxError it raises
// is reported at an unhelpful offset with no explanation.
{
  const leftover = src.match(/^\s*(export|import)\s/m);
  if (leftover) {
    console.error(
      `FATAL  src/config-loader.js contains a top-level \`${leftover[1]}\` this test ` +
      'cannot compile.\n       Add a case to the stripping above, or switch the ' +
      'test to a different loading strategy.'
    );
    process.exit(1);
  }
}

/** Load a fresh copy of the module against a fake window with the given query string. */
async function loadWith(search) {
  const win = {
    location: { search, href: 'http://localhost/' + search },
    HOME3D_CONFIG: null,
  };
  const doc = { querySelectorAll: () => [], querySelector: () => null };
  const noFetch = async () => { throw new Error('no network in tests'); };

  const warnings = [];
  const realWarn = console.warn, realInfo = console.info;
  console.warn = (...a) => warnings.push(a.join(' '));
  console.info = () => {};
  try {
    const factory = new Function(
      'window', 'document', 'fetch',
      src + '\nreturn typeof HomeConfig !== "undefined" ? HomeConfig : window.HomeConfig;'
    );
    const HomeConfig = factory(win, doc, noFetch);
    return { config: await HomeConfig.load(), warnings };
  } finally {
    console.warn = realWarn;
    console.info = realInfo;
  }
}

const cases = [
  // [query string, expected house, label]
  ['?house=cottage',            'cottage',     'a valid id is used'],
  ['?house=my_house-2',         'my_house-2',  'underscores and digits are allowed'],
  ['?house=demo',               'demo',        'the default named explicitly'],
  ['',                          'demo',        'absent parameter falls back'],
  ['?house=',                   'demo',        'an empty value is ignored'],
  ['?house=../../etc/passwd',   'demo',        'PATH TRAVERSAL is rejected'],
  ['?house=a%2F..%2Fb',         'demo',        'an encoded slash is rejected'],
  ['?house=..',                 'demo',        'a bare .. is rejected'],
  ['?house=UPPER',              'demo',        'uppercase is rejected'],
  ['?house=9leading',           'demo',        'a leading digit is rejected'],
  ['?house=has%20space',        'demo',        'a space is rejected'],
];

let pass = 0, fail = 0;
for (const [search, want, label] of cases) {
  const { config } = await loadWith(search);
  const got = config.house;
  if (got === want) {
    pass++;
    console.log(`PASS  ${label.padEnd(34)} ${(search || '(none)').padEnd(26)} -> ${got}`);
  } else {
    fail++;
    console.log(`FAIL  ${label.padEnd(34)} ${(search || '(none)').padEnd(26)} -> ${got} (wanted ${want})`);
  }
}

// ?haUrl= must keep clearing fallbackUrl. This is the semantic the Home
// Assistant embed depends on: an explicit origin is used alone, never raced
// against a deployment default that could receive the token.
{
  const { config } = await loadWith('?haUrl=https://ha.example.com');
  const ok = config.url === 'https://ha.example.com'
          && config.fallbackUrl === ''
          && config.haUrlOverride === true;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'?haUrl= clears fallbackUrl'.padEnd(34)} ` +
              `url=${config.url} fallback=${JSON.stringify(config.fallbackUrl)}`);
}

// The two are independent: setting one must not disturb the other.
{
  const { config } = await loadWith('?house=cottage&haUrl=https://ha.example.com');
  const ok = config.house === 'cottage' && config.url === 'https://ha.example.com';
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'?house= and ?haUrl= coexist'.padEnd(34)} ` +
              `house=${config.house} url=${config.url}`);
}

// A javascript: URL must never reach the HA client - that is where the token goes.
{
  const { config } = await loadWith('?haUrl=javascript:alert(1)');
  const ok = !String(config.url).startsWith('javascript:');
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'javascript: haUrl rejected'.padEnd(34)} url=${JSON.stringify(config.url)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
