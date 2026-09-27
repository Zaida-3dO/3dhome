#!/usr/bin/env node
/**
 * A plant's Home Assistant reading (src/plant-status.js), its fold into the
 * client (src/ha-client.js) and its read-only tap card (src/tap-popovers.js).
 * Never a real HA: the client runs against scripts/fake-ha-websocket.mjs.
 * No framework, no install: `node scripts/test-plant-status.mjs`.
 *
 *   1. normalisePlantBindings: keeps a valid binding, drops one with neither
 *      moisture nor watering, nulls a wrong-domain entity, falls back on bad
 *      thresholds.
 *   2. parsePlant: OFFLINE IS NOT 0% -- an unavailable moisture reads offline
 *      with moisture null; the dry / ok / wet thresholds at their edges; a
 *      status helper overrides them (binary on = dry, a warning enum), an
 *      unusable helper does not; battery % and text; the watering countdown;
 *      `updated` from last_reported.
 *   3. agoText and the status words.
 *   4. The client: the snapshot fires one reading per plant, an unchanged
 *      republish fires nothing, an unavailable sensor fires "offline", a
 *      reconnect re-emits -- and NOTHING is ever sent (read-only).
 *   5. Picking and the card: deviceTarget names a plant item; the card shows
 *      the moisture and status, "Offline" (never 0%) for a dropped sensor,
 *      and has no control at all.
 *
 * Each check names the one-line mutation it catches.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFakeHA } from './fake-ha-websocket.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const P = await imp('src/plant-status.js');
const { HAClient } = await imp('src/ha-client.js');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const st = (entity_id, state, extra) => Object.assign({ entity_id, state: String(state), attributes: {} }, extra || {});

// ---- 1. bindings ---------------------------------------------------------------
{
  const m = P.normalisePlantBindings({
    fern: { moisture: 'sensor.demo_fern_moisture', battery: 'sensor.demo_fern_battery', status: 'binary_sensor.demo_fern_dry',
      temperature: 'sensor.demo_fern_temp', name: ' Fern ', dryBelow: 30, wetAbove: 70 },
    cactus: { watering: 'sensor.demo_cactus_countdown' },
    nothing: { battery: 'sensor.demo_x_battery' },
    wrong: { moisture: 'binary_sensor.demo_wrong', watering: 'light.demo_wrong' },
    odd: { moisture: 'sensor.demo_odd', battery: 'light.demo_odd', status: 'switch.demo_odd', dryBelow: 90, wetAbove: 10 }
  });
  // Mutation: drop the `if (!moisture && !watering) return` -> 'nothing' kept -> fails.
  check('bindings: needs moisture or watering', m.size === 3 && !m.has('nothing') && !m.has('wrong'), [...m.keys()]);
  const f = m.get('fern');
  check('bindings: every optional entity kept', f.battery === 'sensor.demo_fern_battery' && f.status === 'binary_sensor.demo_fern_dry' &&
    f.temperature === 'sensor.demo_fern_temp' && f.name === 'Fern', f);
  check('bindings: thresholds kept', f.dryBelow === 30 && f.wetAbove === 70, f);
  check('bindings: watering-only kept', m.get('cactus').watering === 'sensor.demo_cactus_countdown' && m.get('cactus').moisture === null);
  const o = m.get('odd');
  // Mutation: allow any domain for battery -> 'light.demo_odd' kept -> fails.
  check('bindings: wrong-domain optional entities -> null', o.battery === null && o.status === null, o);
  // Mutation: drop the `!(dry < wet)` fallback -> 90 / 10 kept -> fails.
  check('bindings: dry not below wet -> defaults', o.dryBelow === P.DEFAULT_DRY_BELOW && o.wetAbove === P.DEFAULT_WET_ABOVE, o);
  check('bindings: nothing bound -> empty', P.normalisePlantBindings(undefined).size === 0);
  check('plantEntities: every bound entity', P.plantEntities(f).length === 4 && P.plantEntities(m.get('cactus')).length === 1);
}

// ---- 2. parsePlant -------------------------------------------------------------
{
  const B = P.normalisePlantBindings({
    p: { moisture: 'sensor.demo_m', battery: 'sensor.demo_b', temperature: 'sensor.demo_t' },
    h: { moisture: 'sensor.demo_m', status: 'binary_sensor.demo_dry' },
    e: { moisture: 'sensor.demo_m', status: 'sensor.demo_warning' },
    w: { watering: 'sensor.demo_w' }
  });
  const p = B.get('p'), h = B.get('h'), e = B.get('e'), w = B.get('w');
  const read = (b, s) => P.parsePlant(b, s);

  for (const bad of ['unavailable', 'unknown', '', 'n/a']) {
    const r = read(p, { moisture: st('sensor.demo_m', bad) });
    // Mutation: `num` returning 0 for a non-number (e.g. `+s.state || 0`) -> moisture 0 -> fails.
    check('parse: "' + bad + '" moisture is OFFLINE, not 0%', r.level === 'offline' && r.moisture === null && !r.available, r);
  }
  check('parse: no state yet -> level null (not offline)', read(p, {}).level === null);
  // Thresholds at their edges (defaults 20 / 80).
  const lvl = v => read(p, { moisture: st('sensor.demo_m', v) }).level;
  // Mutation: `<` -> `<=` on dryBelow -> 20 reads dry -> fails.
  check('parse: 19 dry, 20 ok', lvl(19) === 'dry' && lvl(20) === 'ok', [lvl(19), lvl(20)]);
  // Mutation: `>` -> `>=` on wetAbove -> 80 reads wet -> fails.
  check('parse: 80 ok, 81 wet', lvl(80) === 'ok' && lvl(81) === 'wet', [lvl(80), lvl(81)]);
  check('parse: a real 0% is dry, and available', (() => { const r = read(p, { moisture: st('sensor.demo_m', '0') }); return r.available && r.moisture === 0 && r.level === 'dry'; })());
  check('parse: moisture rounded and clamped', read(p, { moisture: st('sensor.demo_m', '47.6') }).moisture === 48 &&
    read(p, { moisture: st('sensor.demo_m', '130') }).moisture === 100);

  // The helper decides when it says something usable.
  const hr = read(h, { moisture: st('sensor.demo_m', 55), status: st('binary_sensor.demo_dry', 'on') });
  // Mutation: ignore the helper (always thresholds) -> 55 reads ok -> fails.
  check('parse: binary helper on -> dry, over a 55% moisture', hr.level === 'dry' && hr.fromHa === true, hr);
  check('parse: binary helper off -> ok, over a 5% moisture', read(h, { moisture: st('sensor.demo_m', 5), status: st('binary_sensor.demo_dry', 'off') }).level === 'ok');
  const hu = read(h, { moisture: st('sensor.demo_m', 5), status: st('binary_sensor.demo_dry', 'unavailable') });
  check('parse: an unavailable helper falls back to the thresholds', hu.level === 'dry' && hu.fromHa === false, hu);
  check('parse: warning enum none -> ok', read(e, { moisture: st('sensor.demo_m', 5), status: st('sensor.demo_warning', 'none') }).level === 'ok');
  check('parse: warning enum alarm -> dry', read(e, { moisture: st('sensor.demo_m', 50), status: st('sensor.demo_warning', 'alarm') }).level === 'dry');
  check('parse: warning enum wet -> wet', read(e, { moisture: st('sensor.demo_m', 50), status: st('sensor.demo_warning', 'wet') }).level === 'wet');
  check('parse: an unknown warning word falls back', read(e, { moisture: st('sensor.demo_m', 50), status: st('sensor.demo_warning', 'sideways') }).fromHa === false);
  // A dropped moisture sensor is offline even if the helper still reports.
  check('parse: offline wins over a live helper', read(h, { moisture: st('sensor.demo_m', 'unavailable'), status: st('binary_sensor.demo_dry', 'on') }).level === 'offline');

  // Battery, temperature.
  const r1 = read(p, { moisture: st('sensor.demo_m', 50), battery: st('sensor.demo_b', 17), temperature: st('sensor.demo_t', '21.46') });
  // Mutation: LOW_BATTERY_PCT 20 -> 10 -> 17 is not low -> fails.
  check('parse: numeric battery, low at <= 20', r1.battery === 17 && r1.batteryLow === true && r1.batteryText === null, r1);
  check('parse: temperature to 1 dp', r1.temperature === 21.5, r1.temperature);
  const r2 = read(p, { moisture: st('sensor.demo_m', 50), battery: st('sensor.demo_b', 'low') });
  check('parse: text battery gauge', r2.battery === null && r2.batteryText === 'Low' && r2.batteryLow === true, r2);
  check('parse: text battery high is not low', read(p, { moisture: st('sensor.demo_m', 50), battery: st('sensor.demo_b', 'high') }).batteryLow === false);
  check('parse: unavailable battery shows nothing', (() => { const r = read(p, { moisture: st('sensor.demo_m', 50), battery: st('sensor.demo_b', 'unavailable') }); return r.battery === null && r.batteryText === null; })());

  // Updated: the newest of last_reported / last_updated, of the MAIN reading.
  const r3 = read(p, { moisture: st('sensor.demo_m', 50, { last_updated: '2026-01-01T10:00:00Z', last_reported: '2026-01-01T12:00:00Z' }),
    battery: st('sensor.demo_b', 50, { last_reported: '2026-01-02T00:00:00Z' }) });
  // Mutation: drop last_reported from heardMs -> 10:00 -> fails.
  check('parse: updated = the moisture\'s last_reported', r3.updated === Date.parse('2026-01-01T12:00:00Z'), r3.updated);

  // Watering countdown (no probe).
  // Mutation: `<= 0` -> `< 0` -> 0 reads ok -> fails.
  check('parse: watering 0 -> due', read(w, { watering: st('sensor.demo_w', 0) }).level === 'due');
  check('parse: watering 30 -> ok', read(w, { watering: st('sensor.demo_w', 30) }).level === 'ok');
  const wo = read(w, { watering: st('sensor.demo_w', 'unavailable') });
  check('parse: watering unavailable -> offline, no number', wo.level === 'offline' && wo.watering === null, wo);
}

// ---- 3. words --------------------------------------------------------------------
{
  const now = Date.parse('2026-01-02T00:00:00Z');
  check('ago: just now', P.agoText(now - 20e3, now) === 'just now');
  check('ago: minutes', P.agoText(now - 12 * 60e3, now) === '12 min ago');
  // Mutation: 48 h -> 24 h in agoText -> '1 d ago' -> fails.
  check('ago: hours up to two days', P.agoText(now - 30 * 3600e3, now) === '30 h ago');
  check('ago: days', P.agoText(now - 3 * 86400e3, now) === '3 d ago');
  check('ago: no time -> empty', P.agoText(null, now) === '');
  check('status: words', P.plantStatusText({ level: 'dry' }) === 'Dry' && P.plantStatusText({ level: 'ok' }) === 'OK' &&
    P.plantStatusText({ level: 'wet' }) === 'Wet' && P.plantStatusText({ level: 'offline' }) === 'Offline' &&
    P.plantStatusText({ level: 'due' }) === 'Water due' && P.plantStatusText(null) === 'No reading yet');
  check('battery text: % or word', P.batteryText({ battery: 88 }) === '88%' && P.batteryText({ battery: null, batteryText: 'High' }) === 'High');
  const mk = P.mockPlantReading(0, { moisture: 'sensor.demo_m' }, now);
  check('mock: sample updated made absolute', mk.level === 'ok' && mk.updated === now - P.MOCK_PLANT_READINGS.ok.updated, mk);
  check('mock: watering-only binding -> due sample', P.mockPlantReading(0, { moisture: null, watering: 'sensor.demo_w' }, now).level === 'due');
  check('mock: the fourth plant is offline', P.mockPlantReading(3, { moisture: 'sensor.demo_m' }, now).level === 'offline');
}

// ---- 4. the client, against the fake HA ----------------------------------------
{
  // The moisture is listed BEFORE its battery, on purpose: the snapshot must
  // still report the plant once, with both.
  const states = [st('sensor.demo_fern_moisture', 44), st('sensor.demo_fern_battery', 90), st('sensor.demo_cactus_countdown', 0)];
  const fake = installFakeHA({ states });
  const log = console.log, warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try {
    const ha = HAClient.create({ url: 'http://ha.invalid', token: 't', rooms: {}, wsReconnectMs: 15,
      sensors: { plants: {
        fern: { moisture: 'sensor.demo_fern_moisture', battery: 'sensor.demo_fern_battery' },
        cactus: { watering: 'sensor.demo_cactus_countdown' }
      } } });
    const seen = [];
    ha.onPlantChange((id, r) => seen.push({ id, r }));
    ha.connect();
    await fake.whenConnected(ha);
    const fern = seen.filter(s => s.id === 'fern');
    // Mutations: drop the post-loop resolvePlant in the snapshot -> none;
    // resolve inside the loop -> two (battery null, then 90) -> fails.
    check('client: snapshot fires one reading per plant', seen.length === 2 && fern.length === 1 &&
      fern[0].r.moisture === 44 && fern[0].r.battery === 90 && fern[0].r.level === 'ok', seen);
    check('client: getPlant', (ha.getPlant('cactus') || {}).level === 'due');
    check('client: plantBinding', (ha.plantBinding('fern') || {}).moisture === 'sensor.demo_fern_moisture');

    const sock = () => fake.sockets[fake.sockets.length - 1];
    sock().emitStateChanged(st('sensor.demo_fern_moisture', 44));
    await sleep(10);
    // Mutation: drop the `prev.key === key` early return -> fires -> fails.
    check('client: an unchanged republish fires nothing', seen.length === 2, seen.length);
    sock().emitStateChanged(st('sensor.demo_fern_moisture', 'unavailable'));
    await sleep(10);
    const last = seen[seen.length - 1];
    check('client: a dropped sensor fires OFFLINE, not 0', seen.length === 3 && last.r.level === 'offline' && last.r.moisture === null, last);

    states[0] = st('sensor.demo_fern_moisture', 'unavailable');   // unchanged across the outage
    sock().close();
    await sleep(30);
    await fake.whenConnected(ha, 2000);
    await sleep(10);
    // Mutation: drop the plantResolved loop in reapplyAll -> fails.
    check('client: a reconnect re-emits each plant', seen.length === 5, seen.length);
    // Mutation: any plant path calling callService -> fails.
    check('client: READ-ONLY -- no call_service ever', fake.calls.length === 0, fake.calls);
    check('client: nothing over REST', fake.fetches.length === 0, fake.fetches);
    ha.disconnect();
  } finally {
    console.log = log; console.warn = warn;
    fake.restore();
  }
}

// ---- 5. picking and the card ---------------------------------------------------
{
  const T = await imp('src/tap-popovers.js');
  const V = await imp('src/vacuum-control.js');
  const plants = P.normalisePlantBindings({ fern: { moisture: 'sensor.demo_fern_moisture' }, cactus: { watering: 'sensor.demo_cactus_w' } });
  const vacuums = V.normaliseVacuumBindings({ robot: { entity: 'vacuum.demo_robot' } });
  const t = T.deviceTarget('fern', vacuums, plants);
  // Mutation: return null for plants in deviceTarget -> fails.
  check('deviceTarget: a plant item -> a plant target', t && t.kind === 'plant' && t.entities[0] === 'sensor.demo_fern_moisture' && t.binding === plants.get('fern'), t);
  check('deviceTarget: watering-only plant targets its countdown', T.deviceTarget('cactus', vacuums, plants).entities[0] === 'sensor.demo_cactus_w');
  check('deviceTarget: a vacuum stays a vacuum', T.deviceTarget('robot', vacuums, plants).kind === 'vacuum');
  check('deviceTarget: anything else -> null', T.deviceTarget('sofa', vacuums, plants) === null);

  const dot = k => '<i data-st="' + k + '"></i>';
  const card = (reading, extra) => T.popoverHtml.plant(Object.assign({ name: 'Fern', status: 'ok', haOff: false, reading, ago: '5 min ago' }, extra || {}), dot);
  const R = P.MOCK_PLANT_READINGS;
  const ok = card(R.ok);
  check('card: moisture and status', ok.indexOf('<b>46%</b>') !== -1 && /data-level="ok"[^>]*>OK</.test(ok), ok);
  check('card: updated, battery and temperature', ok.indexOf('Updated 5 min ago') !== -1 && ok.indexOf('88%') !== -1 && ok.indexOf('21.5°') !== -1);
  check('card: dry and wet', /data-level="dry"[^>]*>Dry</.test(card(R.dry)) && /data-level="wet"[^>]*>Wet</.test(card(R.wet)));
  check('card: a text battery', card(R.wet).indexOf('High') !== -1);
  const off = card(R.offline, { ago: '3 d ago' });
  // Mutation: render r.moisture || 0 when unavailable -> '0%' -> fails.
  check('card: OFFLINE, never 0%', off.indexOf('Offline') !== -1 && off.indexOf('0%') === -1 && off.indexOf('data-level') === -1, off);
  check('card: offline says when it last reported', off.indexOf('Last reading 3 d ago') !== -1);
  const due = card(R.due);
  check('card: watering countdown and Water due', due.indexOf('Countdown <b>0%</b>') !== -1 && due.indexOf('Water due') !== -1, due);
  check('card: no reading yet', card(null, { ago: '' }).indexOf('No reading') !== -1);
  // Read-only: no button, slider or input of any kind in the card body.
  // Mutation: add any control to popoverHtml.plant -> fails.
  check('card: READ-ONLY, no controls', [ok, off, due].every(h => !/<(button|input|select)\b/.test(h)));
  check('card: HA offline line', card(R.ok, { haOff: true }).indexOf('HA offline') !== -1);
}

console.log(failures ? 'FAILED -- ' + failures + ' failed, ' + passes + ' passed' : 'ok -- ' + passes + ' passed, 0 failed');
process.exit(failures ? 1 : 0);
