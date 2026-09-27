#!/usr/bin/env node
/**
 * The real sun (src/sun-position.js), its Home Assistant feed and the
 * ?time= / &date= override. No framework, no install --
 * `node scripts/test-sun-position.mjs`.
 *
 * WHAT THIS GUARDS
 *   1. solarPosition: textbook elevations at a mid-latitude site on the
 *      solstices and equinox, sunrise at the right time, morning sun in the
 *      east and afternoon sun in the west, and a southern-hemisphere site
 *      (longitude and the sign of latitude both matter).
 *   2. sunDirection: compass -> world axes (east = +x, south = +z, up = +y),
 *      and northOffsetDegrees turning plan-north.
 *   3. daylightCurve: night is EXACTLY the old sun-factor-0 rig (so night
 *      looks as it always has); midday fill is well below the old flat 0.70;
 *      sky from above is cool and the bounce from below warm; the sun colour
 *      warms continuously toward the horizon, with no step.
 *   4. windowSunPool: the pool of a south window under a southern sun has the
 *      area the geometry says; the wall reveal narrows an oblique pool and
 *      shifts it away from the sun; a sun behind the wall or below the horizon
 *      gives none; the room polygon (an L included) clips it.
 *   5. parseSunTime: HH:MM and YYYY-MM-DD, alone or together; junk is null.
 *   6. HAClient: sun.sun in the snapshot and in a state_changed event reaches
 *      onSunChange; a repeat or a reading without numbers does not.
 *   7. index.html wires both: ha.onSunChange -> home.setSunFromHA, and
 *      ?time= / &date= -> parseSunTime -> home.setSunTime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const {
  solarPosition, solarNoon, sunDirection, sunColor, daylightCurve, NIGHT,
  windowSunPool, clipPolygon, polygonArea, parseSunTime
} = await imp('src/sun-position.js');

// ---- 1. solarPosition ------------------------------------------------------
console.log('solarPosition');
{
  const LAT = 51.5, LON = 0;   // a city-level mid-latitude site on the meridian
  // Solar noon elevation = 90 - lat + declination.
  const june = solarPosition(new Date(Date.UTC(2026, 5, 21, 12, 2)), LAT, LON);
  check('June solstice noon: elevation ~ 90 - 51.5 + 23.44 = 61.9', near(june.elevation, 61.9, 0.5), june);
  check('June solstice noon: sun due south', near(june.azimuth, 180, 2), june);
  const dec = solarPosition(new Date(Date.UTC(2026, 11, 21, 11, 58)), LAT, LON);
  check('December solstice noon: elevation ~ 15.1', near(dec.elevation, 15.1, 0.5), dec);
  const mar = solarPosition(new Date(Date.UTC(2026, 2, 20, 12, 7)), LAT, LON);
  check('March equinox noon: elevation ~ 38.5', near(mar.elevation, 38.5, 0.6), mar);
  // Sunrise near the September equinox is ~06:00 UTC at this site.
  const pre = solarPosition(new Date(Date.UTC(2026, 8, 27, 5, 40)), LAT, LON);
  const post = solarPosition(new Date(Date.UTC(2026, 8, 27, 6, 20)), LAT, LON);
  check('late September: below the horizon at 05:40 UTC, above it at 06:20', pre.elevation < 0 && post.elevation > 0, [pre, post]);
  const morning = solarPosition(new Date(Date.UTC(2026, 8, 27, 8, 0)), LAT, LON);
  const evening = solarPosition(new Date(Date.UTC(2026, 8, 27, 16, 30)), LAT, LON);
  check('morning sun is in the east-south-east', morning.azimuth > 100 && morning.azimuth < 150, morning);
  check('late-afternoon sun is in the west-south-west', evening.azimuth > 210 && evening.azimuth < 260, evening);
  // Southern hemisphere, far east: summer noon sun is high and to the NORTH.
  const syd = solarPosition(new Date(Date.UTC(2026, 11, 21, 1, 57)), -33.87, 151.2);
  check('Sydney December noon: elevation ~ 79.6', near(syd.elevation, 79.6, 0.8), syd);
  check('Sydney December noon: sun to the north', Math.min(syd.azimuth, 360 - syd.azimuth) < 10, syd);
  const noon = solarNoon(new Date(Date.UTC(2026, 8, 27, 3, 0)), 15);
  check('solarNoon moves 1 h earlier per 15 deg east', noon.toISOString() === '2026-09-27T11:00:00.000Z', noon.toISOString());
}

// ---- 2. sunDirection --------------------------------------------------------
console.log('sunDirection');
{
  const v = (a, b) => a.every((x, i) => near(x, b[i], 1e-9));
  check('south, horizon -> +z', v(sunDirection(180, 0, 0), [0, 0, 1]), sunDirection(180, 0, 0));
  check('east, horizon -> +x', v(sunDirection(90, 0, 0), [1, 0, 0]), sunDirection(90, 0, 0));
  check('north, horizon -> -z', v(sunDirection(0, 0, 0), [0, 0, -1]), sunDirection(0, 0, 0));
  check('zenith -> +y', v(sunDirection(123, 90, 0), [0, 1, 0]), sunDirection(123, 90, 0));
  check('northOffsetDegrees 90: true north lies along plan east (+x)', v(sunDirection(0, 0, 90), [1, 0, 0]), sunDirection(0, 0, 90));
  const d = sunDirection(200, 30, 0);
  check('unit length', near(Math.hypot(d[0], d[1], d[2]), 1, 1e-9), d);
}

// ---- 3. daylightCurve -------------------------------------------------------
console.log('daylightCurve');
{
  const night = daylightCurve(-20);
  check('night: no day, no direct sun, no sun intensity', night.day === 0 && night.direct === 0 && night.sunIntensity === 0, night);
  check('night fill is the old ambient: 0.12', night.fill === 0.12, night.fill);
  check('night sky == bounce == the old ambient colour (hemisphere == ambient)',
    JSON.stringify(night.sky) === JSON.stringify(NIGHT.fillColor) && JSON.stringify(night.bounce) === JSON.stringify(NIGHT.fillColor), night);
  check('night background and ground are the old night colours',
    JSON.stringify(night.background) === JSON.stringify(NIGHT.background) && JSON.stringify(night.ground) === JSON.stringify(NIGHT.ground), night);
  const high = daylightCurve(45);
  check('midday: full day and full direct sun', high.day === 1 && high.direct === 1, high);
  check('midday fill is well under the old flat 0.70 (the rooms get contrast)', high.fill > 0.3 && high.fill < 0.55, high.fill);
  check('sky fill is cool (blue > red), bounce warm (red > blue)', high.sky[2] > high.sky[0] && high.bounce[0] > high.bounce[2], high);
  check('by day the sky is brighter than at night', high.background[2] > NIGHT.background[2] * 3, high.background);
  const low = daylightCurve(3);
  check('a low sun is weaker than a high one', low.sunIntensity < high.sunIntensity && low.sunIntensity > 0, [low.sunIntensity, high.sunIntensity]);
  check('a low sun is warmer than a high one', low.sun[2] < high.sun[2] - 0.2, [low.sun, high.sun]);
  // No step anywhere: 0.1 deg never moves a channel by more than 0.01.
  let maxStep = 0;
  for (let e = -2; e < 50; e += 0.1) {
    const a = sunColor(e), b = sunColor(e + 0.1);
    maxStep = Math.max(maxStep, ...a.map((x, i) => Math.abs(x - b[i])));
  }
  check('sun colour is continuous (no gold->white snap)', maxStep < 0.01, maxStep);
  const dusk = daylightCurve(-3);
  check('civil twilight: some sky, no direct sun', dusk.day > 0 && dusk.day < 1 && dusk.direct === 0, dusk);
}

// ---- 4. windowSunPool ---------------------------------------------------------
console.log('windowSunPool');
{
  // A window in a south wall: room face at z = 0, outer face at z = 0.3
  // (outside is +z = south), opening x -0.5..0.5, y 0.1..2.1. Room to the north.
  const rect = z => [[-0.5, 0.1, z], [0.5, 0.1, z], [0.5, 2.1, z], [-0.5, 2.1, z]];
  const base = { outer: rect(0.3), inner: rect(0), inward: [0, -1],
    room: [[-3, -4], [3, -4], [3, 0], [-3, 0]] };
  const south45 = sunDirection(180, 45, 0);
  const pool = windowSunPool(Object.assign({}, base, { toSun: south45 }));
  // Inner face projects to z -0.1..-2.1, outer to 0.2..-1.8: overlap -0.1..-1.8.
  check('south sun at 45 deg: pool area = 1.0 x 1.7', pool && near(polygonArea(pool), 1.7, 1e-6), pool && polygonArea(pool));
  const zs = pool ? pool.map(p => p[1]) : [0];
  check('...running from 0.1 m to 1.8 m into the room', near(Math.max(...zs), -0.1, 1e-6) && near(Math.min(...zs), -1.8, 1e-6), zs);
  const oblique = windowSunPool(Object.assign({}, base, { toSun: sunDirection(135, 45, 0) }));
  const cx = oblique ? oblique.reduce((a, p) => a + p[0], 0) / oblique.length : 0;
  check('south-east sun: pool shifted west (away from the sun)', oblique && cx < -0.3, cx);
  check('south-east sun: the wall reveal narrows it', oblique && polygonArea(oblique) < polygonArea(pool) - 0.05, oblique && polygonArea(oblique));
  check('sun behind the wall (north): no pool', windowSunPool(Object.assign({}, base, { toSun: sunDirection(0, 45, 0) })) === null);
  // The side test itself, not the room clip: with a floor reaching both sides
  // of the wall a northern sun's projection WOULD land on it.
  check('sun behind the wall: no pool even where a floor lies outside',
    windowSunPool(Object.assign({}, base, { room: [[-3, -4], [3, -4], [3, 4], [-3, 4]], toSun: sunDirection(0, 45, 0) })) === null);
  check('sun at 0 deg elevation: no pool', windowSunPool(Object.assign({}, base, { toSun: sunDirection(180, 0, 0) })) === null);
  check('sun below the horizon: no pool', windowSunPool(Object.assign({}, base, { toSun: sunDirection(180, -10, 0) })) === null);
  const shallow = windowSunPool(Object.assign({}, base, { room: [[-3, -1], [3, -1], [3, 0], [-3, 0]], toSun: south45 }));
  check('a shallow room clips the pool at its far wall (area 0.9)', shallow && near(polygonArea(shallow), 0.9, 1e-6), shallow && polygonArea(shallow));
  // L-shaped room: the north-west quarter of the pool's run is another room.
  const L = [[-3, -4], [0, -4], [0, -1], [3, -1], [3, 0], [-3, 0]];
  const lpool = windowSunPool(Object.assign({}, base, { room: L, toSun: south45 }));
  // Pool x -0.5..0.5, z -1.8..-0.1. The L keeps x<0 fully (0.5 x 1.7) and x>0 only to z=-1 (0.5 x 0.9).
  check('an L-shaped room clips the pool to its own floor (0.85 + 0.45)', lpool && near(polygonArea(lpool), 1.3, 1e-6), lpool && polygonArea(lpool));
  const tri = clipPolygon([[0, 0], [2, 0], [2, 2], [0, 2]], [[0, 0], [2, 0], [0, 2]]);
  check('clipPolygon: square by triangle', near(polygonArea(tri), 2, 1e-9), tri);
  const cw = clipPolygon([[0, 0], [2, 0], [2, 2], [0, 2]], [[0, 0], [0, 2], [2, 0]]);
  check('clipPolygon: clip winding does not matter', near(polygonArea(cw), 2, 1e-9), cw);
}

// ---- 5. parseSunTime ----------------------------------------------------------
console.log('parseSunTime');
{
  const now = new Date(2026, 8, 27, 15, 42);
  const both = parseSunTime('09:00', '2026-06-21', now);
  check('time + date', both && both.getFullYear() === 2026 && both.getMonth() === 5 && both.getDate() === 21 &&
    both.getHours() === 9 && both.getMinutes() === 0, both && both.toString());
  const t = parseSunTime('17:45', null, now);
  check('time alone: today', t && t.getDate() === 27 && t.getHours() === 17 && t.getMinutes() === 45, t && t.toString());
  const d = parseSunTime(null, '2026-12-21', now);
  check('date alone: that day at the current clock time', d && d.getMonth() === 11 && d.getHours() === 15 && d.getMinutes() === 42, d && d.toString());
  check('neither: null', parseSunTime(null, null, now) === null);
  check('junk time: null', parseSunTime('9am', null, now) === null);
  check('hour 24: null', parseSunTime('24:00', null, now) === null);
  check('junk date: null', parseSunTime('09:00', '21/06/2026', now) === null);
  check('a day the month lacks: null', parseSunTime(null, '2026-02-30', now) === null);
}

// ---- 6. HAClient sun.sun ------------------------------------------------------
console.log('HAClient sun.sun');
{
  const { HAClient } = await imp('src/ha-client.js');
  const states = [{ entity_id: 'sun.sun', state: 'above_horizon', attributes: { azimuth: 150.5, elevation: 30.25 } }];
  const fake = installFakeHA({ states });
  const realLog = console.log;
  console.log = () => {};
  const seen = [];
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, sensors: {}, wsReconnectMs: 15 });
    ha.onSunChange(r => seen.push(r));
    ha.connect();
    await fake.whenConnected(ha);
    console.log = realLog;
    check('sun.sun in the snapshot reaches onSunChange', seen.length === 1 && seen[0].azimuth === 150.5 && seen[0].elevation === 30.25, seen);
    console.log = () => {};
    fake.sockets[fake.sockets.length - 1].emitStateChanged({ entity_id: 'sun.sun', state: 'above_horizon', attributes: { azimuth: 160, elevation: 31 } });
    await sleep(20);
    console.log = realLog;
    check('a sun.sun state_changed reaches onSunChange', seen.length === 2 && seen[1].azimuth === 160, seen);
    check('the same reading again does not fire', ha._injectSunState({ attributes: { azimuth: 160, elevation: 31 } }) === false && seen.length === 2, seen);
    check('a reading without numbers does not fire', ha._injectSunState({ attributes: { azimuth: 'x' } }) === false && seen.length === 2, seen);
    ha.disconnect();
  } finally {
    console.log = realLog;
    fake.restore();
  }
}

// ---- 7. index.html wiring -----------------------------------------------------
console.log('index.html wiring');
{
  const html = read('index.html');
  check('ha.onSunChange feeds home.setSunFromHA', /ha\.onSunChange\(\s*reading\s*=>\s*home\.setSunFromHA\(reading\)\s*\)/.test(html));
  check('?time= / &date= are parsed and pinned', /parseSunTime\(\s*tParam\s*,\s*dParam\s*\)/.test(html) &&
    /params\.get\('time'\)/.test(html) && /params\.get\('date'\)/.test(html) && /home\.setSunTime\(at\)/.test(html));
  const scene = read('src/home3d-scene.js');
  check('the scene fills with a HemisphereLight, not a flat AmbientLight',
    /new THREE\.HemisphereLight\(/.test(scene) && !/new THREE\.AmbientLight\(/.test(scene));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
