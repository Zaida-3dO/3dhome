/**
 * plant-status.js -- a plant's Home Assistant reading, as pure functions:
 * binding normalisation, folding the bound entities into one reading, the
 * status it shows and the "updated ... ago" line. READ-ONLY: nothing here
 * builds a service call, and nothing that uses it sends one. No DOM, no
 * socket, no THREE: src/ha-client.js folds states with parsePlant, and the
 * tap card (src/tap-popovers.js) and the sidebar block (index.html) render
 * the reading. Unit-tested in scripts/test-plant-status.mjs.
 *
 * THE BINDING (rooms.json `sensors.plants`, schemaVersion 1.5) is keyed by
 * the FURNITURE ITEM id of the plant (geometry.json `furniture[].id`), which
 * is what makes the model tappable:
 *
 *   plants: {
 *     lounge_fern: {
 *       moisture:    <a sensor.* soil moisture %>,     // or `watering`
 *       name:        'Fern',                           // optional
 *       battery:     <a sensor.* battery, % or text>,  // optional
 *       status:      <a binary_sensor.* "dry" / sensor.* warning>, // optional
 *       temperature: <a sensor.* temperature>,         // optional
 *       watering:    <a sensor.* watering countdown %>, // optional
 *       dryBelow: 20, wetAbove: 80                     // optional
 *     }
 *   }
 *
 * `moisture` or `watering` is required: a plant with neither has nothing to
 * show. `watering` is a countdown helper for a plant with no probe (100 =
 * watered today, 0 = due); a plant with both shows the moisture.
 *
 * OFFLINE IS NOT 0%. Zigbee soil sensors drop off the mesh often and come
 * back on a button press; `unavailable` / `unknown` must read "Offline",
 * never as a bone-dry 0% that would send someone to water a plant that
 * does not need it.
 */

export const DEFAULT_DRY_BELOW = 20;
export const DEFAULT_WET_ABOVE = 80;
export const LOW_BATTERY_PCT = 20;

const isEntity = (v, domains) => typeof v === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(v) &&
  domains.some(d => v.indexOf(d + '.') === 0);
const pct = v => (typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100 ? v : null);

/**
 * rooms.json `sensors.plants` -> Map itemId -> { itemId, name, moisture,
 * battery, status, temperature, watering, dryBelow, wetAbove }. An entry
 * with neither a `sensor.*` moisture nor a `sensor.*` watering entity is
 * dropped (it could never show anything); an optional entity of the wrong
 * domain becomes null; thresholds out of 0..100, or dry not below wet, fall
 * back to the defaults.
 */
export function normalisePlantBindings(plants) {
  const out = new Map();
  if (!plants || typeof plants !== 'object') return out;
  Object.keys(plants).forEach(itemId => {
    const b = plants[itemId];
    if (!b || typeof b !== 'object') return;
    const moisture = isEntity(b.moisture, ['sensor']) ? b.moisture : null;
    const watering = isEntity(b.watering, ['sensor']) ? b.watering : null;
    if (!moisture && !watering) return;
    let dry = pct(b.dryBelow), wet = pct(b.wetAbove);
    if (dry == null) dry = DEFAULT_DRY_BELOW;
    if (wet == null) wet = DEFAULT_WET_ABOVE;
    if (!(dry < wet)) { dry = DEFAULT_DRY_BELOW; wet = DEFAULT_WET_ABOVE; }
    out.set(itemId, {
      itemId,
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null,
      moisture,
      battery: isEntity(b.battery, ['sensor']) ? b.battery : null,
      status: isEntity(b.status, ['sensor', 'binary_sensor']) ? b.status : null,
      temperature: isEntity(b.temperature, ['sensor']) ? b.temperature : null,
      watering,
      dryBelow: dry,
      wetAbove: wet
    });
  });
  return out;
}

/** Every entity one binding reads (the client subscribes to each). */
export function plantEntities(b) {
  return b ? [b.moisture, b.watering, b.battery, b.status, b.temperature].filter(Boolean) : [];
}

const usable = s => !!s && typeof s.state === 'string' && s.state !== 'unavailable' && s.state !== 'unknown' && s.state !== '';
const num = s => {
  if (!usable(s)) return null;
  const n = +s.state;
  return isFinite(n) ? n : null;
};
/** When HA last heard from the entity (ms), or null. last_reported moves on
 *  every report, even an unchanged value; last_updated is the fallback. */
function heardMs(s) {
  if (!s) return null;
  const t = [s.last_reported, s.last_updated, s.last_changed].map(v => (typeof v === 'string' ? Date.parse(v) : NaN)).filter(isFinite);
  return t.length ? Math.max.apply(null, t) : null;
}

/**
 * A status helper's state -> 'dry' | 'ok' | 'wet', or null when it says
 * nothing usable (then the moisture thresholds decide).
 *   binary_sensor  on = dry (needs water), off = ok
 *   sensor         a warning enum: none / ok / no_warning -> ok,
 *                  dry / low / alarm / needs_water -> dry, wet / high -> wet
 */
export function helperLevel(entityId, s) {
  if (!usable(s)) return null;
  const v = s.state.trim().toLowerCase();
  if (typeof entityId === 'string' && entityId.indexOf('binary_sensor.') === 0) return v === 'on' ? 'dry' : v === 'off' ? 'ok' : null;
  if (/^(none|ok|normal|no[_ ]?warning|off|false)$/.test(v)) return 'ok';
  if (/^(dry|low|alarm|needs?[_ ]?water|water|on|true|too[_ ]?dry)$/.test(v)) return 'dry';
  if (/^(wet|high|too[_ ]?wet)$/.test(v)) return 'wet';
  return null;
}

/**
 * The bound entities' HA states -> the reading every surface shows:
 *   { available, moisture, level, fromHa, battery, batteryText, batteryLow,
 *     temperature, watering, updated }
 * `states` is { moisture, battery, status, temperature, watering }, each a
 * raw HA state object or null. `level` is 'dry' | 'ok' | 'wet' | 'due' |
 * 'offline' | null (null: not reported yet). `available` is false when the
 * plant's main reading (moisture, else watering) is unavailable or not a
 * number -- then `moisture` is null, NEVER 0. `fromHa` is true when the level
 * came from the status helper rather than the thresholds. `updated` is when
 * HA last heard the main reading (ms since the epoch), or null.
 */
export function parsePlant(binding, states) {
  const b = binding || {};
  const st = states || {};
  const mainKey = b.moisture ? 'moisture' : 'watering';
  const main = st[mainKey] || null;
  const r = { available: false, moisture: null, level: null, fromHa: false, battery: null, batteryText: null,
    batteryLow: false, temperature: null, watering: null, updated: heardMs(main) };

  const w = num(st.watering);
  if (w != null) r.watering = Math.max(0, Math.min(100, Math.round(w)));

  const bs = st.battery;
  const bn = num(bs);
  if (bn != null) { r.battery = Math.max(0, Math.min(100, Math.round(bn))); r.batteryLow = r.battery <= LOW_BATTERY_PCT; }
  else if (usable(bs)) { r.batteryText = humanise(bs.state); r.batteryLow = /^low$/i.test(bs.state.trim()); }

  const t = num(st.temperature);
  if (t != null) r.temperature = Math.round(t * 10) / 10;

  if (!main) return r;                         // not reported yet: level null
  if (b.moisture) {
    const m = num(main);
    if (m == null) { r.level = 'offline'; return r; }
    r.available = true;
    r.moisture = Math.max(0, Math.min(100, Math.round(m)));
    const h = b.status ? helperLevel(b.status, st.status) : null;
    if (h) { r.level = h; r.fromHa = true; }
    else r.level = r.moisture < b.dryBelow ? 'dry' : r.moisture > b.wetAbove ? 'wet' : 'ok';
    return r;
  }
  if (r.watering == null) { r.level = 'offline'; return r; }
  r.available = true;
  const h = b.status ? helperLevel(b.status, st.status) : null;
  if (h) { r.level = h === 'dry' ? 'due' : h; r.fromHa = true; }
  else r.level = r.watering <= 0 ? 'due' : 'ok';
  return r;
}

/** 'charging_completed' -> 'Charging completed'. */
export function humanise(s) {
  if (typeof s !== 'string' || !s) return '';
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const LABEL = { dry: 'Dry', ok: 'OK', wet: 'Wet', due: 'Water due', offline: 'Offline' };
/** The one-word status: Dry / OK / Wet / Water due / Offline, or 'No reading yet'. */
export function plantStatusText(reading) {
  return (reading && LABEL[reading.level]) || 'No reading yet';
}

/** 5 -> 'just now', 'N min ago', 'N h ago', 'N d ago'; '' without a time. */
export function agoText(ms, now) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '';
  const s = Math.max(0, ((typeof now === 'number' ? now : Date.now()) - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 48 * 3600) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}

/** The battery as shown: '87%' or 'High' / 'Low' (text-only gauges), or ''. */
export function batteryText(reading) {
  if (!reading) return '';
  if (reading.battery != null) return reading.battery + '%';
  return reading.batteryText || '';
}

/**
 * Sample readings for a house with no Home Assistant (the demo) and for the
 * spec page's preview. Clearly marked as samples wherever shown. `updated`
 * is an AGE in ms here (the caller subtracts it from now).
 */
export const MOCK_PLANT_READINGS = Object.freeze({
  ok: Object.freeze({ available: true, moisture: 46, level: 'ok', fromHa: false, battery: 88, batteryText: null, batteryLow: false, temperature: 21.5, watering: null, updated: 12 * 60e3 }),
  dry: Object.freeze({ available: true, moisture: 12, level: 'dry', fromHa: false, battery: 64, batteryText: null, batteryLow: false, temperature: 22.1, watering: null, updated: 40 * 60e3 }),
  wet: Object.freeze({ available: true, moisture: 91, level: 'wet', fromHa: false, battery: null, batteryText: 'High', batteryLow: false, temperature: 20.4, watering: null, updated: 3 * 60e3 }),
  due: Object.freeze({ available: true, moisture: null, level: 'due', fromHa: false, battery: null, batteryText: null, batteryLow: false, temperature: null, watering: 0, updated: 5 * 3600e3 }),
  offline: Object.freeze({ available: false, moisture: null, level: 'offline', fromHa: false, battery: null, batteryText: null, batteryLow: false, temperature: null, watering: null, updated: 3 * 86400e3 })
});
const MOCK_ORDER = ['ok', 'dry', 'wet', 'offline'];

/**
 * The n-th bound plant's sample reading (the demo shows each state once),
 * with `updated` made absolute against `now`. A watering-only binding gets
 * the 'due' sample.
 */
export function mockPlantReading(index, binding, now) {
  const key = binding && !binding.moisture ? 'due' : MOCK_ORDER[(index | 0) % MOCK_ORDER.length];
  const m = MOCK_PLANT_READINGS[key];
  return Object.assign({}, m, { updated: (typeof now === 'number' ? now : Date.now()) - m.updated });
}
