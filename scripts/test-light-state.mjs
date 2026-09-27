#!/usr/bin/env node
/**
 * seedLightState (src/light-state.js, item 1a181e50): the scene's initial
 * light state. The channel a room BINDS in rooms.json gets a state entry even
 * when geometry draws no fixture for it -- that is the only reason an office
 * whose ambient light is a cornice and desk strips has an Ambient row. Before
 * this was extracted, deleting the line that adds a bound channel passed
 * every test. No framework, no install: `node scripts/test-light-state.mjs`.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { seedLightState } = await import(pathToFileURL(path.join(root, 'src/light-state.js')).href);

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('  ok   ' + name); return; }
  failures++;
  console.error('  FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}

// Synthetic rooms: "study" has a geometry main + cornice; "den" has no fixture.
const ROOMS = { study: {}, den: {}, hall: {} };
const LIGHTS = {
  study: { main: [{}], cornice: [{}] },
  hall: { main: [{}] }
};

{
  const s = seedLightState(ROOMS, LIGHTS, { study: ['ambient', 'main'], den: ['ambient'] });
  check('every room gets an entry', Object.keys(s).sort().join() === 'den,hall,study', Object.keys(s));
  check('a bound channel with no fixture gets an entry (study.ambient)',
    !!s.study.ambient && s.study.ambient.on === false && s.study.ambient.bri === 80, s.study);
  check('...also in a room with no fixtures at all (den.ambient)', !!s.den.ambient, s.den);
  check('a geometry channel still gets an entry (study.cornice)', !!s.study.cornice, s.study);
  check('an unbound, unfixtured channel does not (hall.ambient, den.cornice)',
    !('ambient' in s.hall) && !('cornice' in s.den), { hall: s.hall, den: s.den });
  check('main is never overwritten by a bound "main"',
    JSON.stringify(s.study.main) === JSON.stringify({ on: false, bri: 100, temp: 4000 }), s.study.main);
  check('every room has a main entry', ['study', 'den', 'hall'].every(id => s[id].main && s[id].main.temp === 4000));
  check('exact channel set per room',
    Object.keys(s.study).sort().join() === 'ambient,cornice,main' &&
    Object.keys(s.den).sort().join() === 'ambient,main' &&
    Object.keys(s.hall).sort().join() === 'main', s);
}

{
  const s = seedLightState(ROOMS, LIGHTS, null);
  check('no boundChannels: geometry channels only', Object.keys(s.study).sort().join() === 'cornice,main' && Object.keys(s.den).join() === 'main', s);
  const junk = seedLightState(ROOMS, LIGHTS, { den: 'ambient', hall: [7, null] });
  check('a non-array / non-string binding is ignored', Object.keys(junk.den).join() === 'main' && Object.keys(junk.hall).join() === 'main', junk);
  const a = seedLightState(ROOMS, LIGHTS, { den: ['ambient'] });
  a.den.ambient.on = true;
  const b = seedLightState(ROOMS, LIGHTS, { den: ['ambient'] });
  check('each call returns fresh objects', b.den.ambient.on === false);
}

if (failures) {
  console.error(failures + ' failed, ' + passes + ' passed');
  process.exit(1);
}
console.log('ok -- ' + passes + ' passed, 0 failed');
