#!/usr/bin/env node
/**
 * Config-loader tests. No framework, no dependencies - `node scripts/test-config-loader.mjs`.
 *
 * The cases that matter most are the ?house= rejections. That id becomes a URL
 * path segment (houses/<id>/geometry.json), so the character-class check in
 * asHouseId is a path-traversal guard. A regression there would not look like a
 * bug - it would look like the app quietly loading a different file - so it is
 * asserted here rather than left to review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/config-loader.js'), 'utf8');

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
