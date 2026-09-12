#!/usr/bin/env node
/**
 * house-loader strictness tests. No framework, no dependencies -
 * `node scripts/test-house-loader-strict.mjs`.
 *
 * WHAT THIS GUARDS, AND WHY IT IS WORTH A TEST FILE
 *
 * loadWithFallback() used to render the demo house whenever the configured
 * profile could not be loaded. That is a regression nobody would SEE: the app
 * boots, a house draws, the container reports healthy, and the only signal is a
 * console line that nobody reads on a wall tablet. The result is a fictional
 * flat displayed as if it were the real home, with Home Assistant wiring real
 * entities to fake rooms.
 *
 * So the property under test is a NEGATIVE one - "no other house is rendered" -
 * which is exactly the kind that rots silently in review. Hence these asserts:
 * every one of them fails if the substitution comes back.
 *
 * The loader is an ES module, so its named export is import()ed. fetch is
 * stubbed per-case.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// src/house-loader.js is an ES module (`export const HouseLoader`), so it is
// imported for its NAMED export rather than require()'d. Worth stating because
// the obvious-looking require() does not fail loudly here: Node's interop hands
// back the module NAMESPACE, so `require(...)` yields { HouseLoader } and
// `.loadWithFallback` reads as undefined one level too shallow -- which
// presents as "is not a function" rather than as a module-format error.
const { HouseLoader } = await import(
  pathToFileURL(path.join(root, 'src/house-loader.js')).href
);

/**
 * Serve a minimal but SCHEMA-VALID geometry doc for the named ids; 404
 * everything else. `served` is the set of house ids that exist.
 *
 * The doc has to be valid enough to compile, because a test that passed only
 * because compile() threw would not be testing the fetch path at all.
 */
function stubFetch(served, log) {
  globalThis.fetch = async (url) => {
    const m = String(url).match(/houses\/([^/]+)\/(geometry|rooms)\.json/);
    if (log) log.push(String(url));
    const id = m && m[1];
    const kind = m && m[2];

    if (!id || !served.includes(id)) {
      return { ok: false, status: 404, statusText: 'Not Found',
               json: async () => { throw new Error('not json'); } };
    }
    if (kind === 'rooms') {
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => ({
          kind: 'rooms', schemaVersion: '1.0', house: id,
          homeAssistant: { enabled: false }, rooms: {}
        })
      };
    }
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({
        kind: 'geometry',
        schemaVersion: '1.0',
        id,
        name: id === 'demo' ? 'Demo House' : id,
        units: 'cm',
        coordinateTransform: { originX: 0, originY: 0, scale: 0.01, planAxes: 'x_east_y_south' },
        defaults: { wallHeight: 245, wallThickness: 10 },
        walls: [{ id: 'w1', start: [0, 0], end: [400, 0] }],
        rooms: [{ id: 'r_' + id, name: 'Room ' + id,
                  polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }]
      })
    };
  };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log('PASS  ' + label); pass++; }
  else { console.log('FAIL  ' + label + (detail ? '   -> ' + detail : '')); fail++; }
}

// ---------------------------------------------------------------------------
// 1. THE CORE PROPERTY: a named house that 404s must REJECT, not substitute.
//    This is the real failure mode - the bind-mount for houses/ope goes
//    unreadable and every request under it 404s while nginx stays healthy.
//    Breaks if `throw e` in loadWithFallback becomes a return of load(fallback).
// ---------------------------------------------------------------------------
{
  stubFetch(['demo']);                       // demo exists, ope does not
  let resolved = null, rejected = null;
  try { resolved = await HouseLoader.loadWithFallback('ope', 'demo'); }
  catch (e) { rejected = e; }

  check('a named house that 404s REJECTS', rejected !== null && resolved === null,
        resolved ? 'resolved with house id "' + resolved.id + '"' : '');
  check('  ...and no substitute house is returned', resolved === null,
        resolved ? 'got "' + resolved.id + '" - THE DEMO HOUSE WAS SUBSTITUTED' : '');
  check('  ...and the error names the house that failed',
        !!rejected && rejected.houseId === 'ope',
        rejected ? 'houseId=' + JSON.stringify(rejected.houseId) : '');
  check('  ...and the message contains the house id (for the on-screen card)',
        !!rejected && /\bope\b/.test(rejected.message));
  check('  ...and the underlying cause is preserved',
        !!rejected && !!rejected.cause);
}

// ---------------------------------------------------------------------------
// 2. The demo house itself still loads. Guards against "fix" by making
//    everything reject. Breaks if load() is short-circuited.
// ---------------------------------------------------------------------------
{
  stubFetch(['demo']);
  let house = null, err = null;
  try { house = await HouseLoader.loadWithFallback('demo', 'demo'); }
  catch (e) { err = e; }
  check('the demo house still loads normally', !!house && house.id === 'demo',
        err ? 'threw: ' + err.message : 'id=' + (house && house.id));
}

// ---------------------------------------------------------------------------
// 3. An explicitly-named house that DOES exist loads, and is not replaced by
//    the demo. Breaks if the fallback is applied unconditionally.
// ---------------------------------------------------------------------------
{
  stubFetch(['demo', 'ope']);
  const house = await HouseLoader.loadWithFallback('ope', 'demo');
  check('a named house that exists loads as itself',
        house.id === 'ope', 'id=' + house.id);
  check('  ...and is NOT the demo house', house.id !== 'demo');
}

// ---------------------------------------------------------------------------
// 4. The demo house is never even FETCHED when a named house fails. Stronger
//    than checking the return value: it proves no substitution was attempted,
//    so a future refactor cannot load the demo and discard it (wasted request)
//    or half-apply it. Breaks the moment a load(fallback) call reappears.
// ---------------------------------------------------------------------------
{
  const log = [];
  stubFetch(['demo'], log);
  try { await HouseLoader.loadWithFallback('ope', 'demo'); } catch (e) { /* expected */ }
  const fetchedDemo = log.some(u => /houses\/demo\//.test(u));
  check('the fallback house is never fetched after a named house fails',
        !fetchedDemo, 'requests: ' + JSON.stringify(log));
}

// ---------------------------------------------------------------------------
// 5. The path-traversal guard is still exported and still rejects. The ?house=
//    validation lives in config-loader (covered by test-config-loader.mjs), but
//    the loader exports its own isValidHouseId and it must not drift.
// ---------------------------------------------------------------------------
{
  check('isValidHouseId rejects path traversal',
        HouseLoader.isValidHouseId('../../etc/passwd') === false);
  check('isValidHouseId rejects a bare ..',
        HouseLoader.isValidHouseId('..') === false);
  check('isValidHouseId accepts a normal id',
        HouseLoader.isValidHouseId('ope') === true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
