/**
 * item-cards.js -- tap cards for furniture items, as pure functions: binding
 * normalisation, which card a tap on an item opens, the row models the card
 * renders and the Home Assistant commands its controls send. No DOM, no
 * socket, no THREE: src/tap-popovers.js renders and wires the card,
 * src/ha-client.js records the raw states. Unit-tested in
 * scripts/test-item-cards.mjs.
 *
 * THREE KINDS OF FURNITURE TAP, all found by WHERE the tap landed (furniture
 * renders merged, see tap-popovers.js):
 *
 *   bound item   rooms.json `sensors.items[itemId]` (schemaVersion 1.6) --
 *                one card or a list of cards, each optionally scoped to a
 *                REGION of the item's width
 *   wall-clock   any item of that type: a read-only card with the local time
 *                and date; no binding
 *   radiator     any item of that type: the EXISTING climate card of the room
 *                the item stands in (`sensors.climate[room]`); nothing when the
 *                room has none
 *
 * THE BINDING:
 *
 *   items: {
 *     <itemId>: <card> | [<card>, ...]
 *   }
 *   <card> = {
 *     title:    'Media',                                 // optional
 *     region:   { from: 0, to: 50 },                     // optional, cm
 *     media:    [{ entity: 'media_player.x', label?, role? }],
 *     lights:   [{ entity: 'light.x', label? }],
 *     readings: [{ entity: 'sensor.x', label?, humidity?: 'sensor.y' }]
 *   }
 *
 * A card needs at least one row. An entity of the wrong domain drops that
 * row (media_player / light / sensor); a card left with no rows, or with a
 * region that is not 0 <= from < to, is dropped.
 *
 * REGION CONVENTION -- centimetres along the item's WIDTH, measured from the
 * item's LEFT edge as seen from its FRONT (standing in front of it, facing
 * it). This is the order a cabinet's `fronts[].cells` are authored in: the
 * cabinet builder lays cells out from local x = -width/2 upwards, and local
 * +x is the viewer's RIGHT when facing the front (the front faces local +z;
 * see src/furniture/place.js). So a console authored as
 * `cells: [door 50, stack 80, door 50]` has its left door at 0-50, the stack
 * at 50-130 and the right door at 130-180.
 *
 * A tap picks the card whose region contains the hit point projected onto
 * the width axis (from <= x <= to; the first listed wins on a shared edge);
 * failing that, a card with no region (the whole item); failing that,
 * nothing -- the tap is a plain furniture tap and the room click beneath
 * handles it.
 */

export const CLOCK_TYPE = 'wall-clock';
export const RADIATOR_TYPE = 'radiator';

const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const isEntity = (v, domain) => typeof v === 'string' && ENTITY_RE.test(v) && v.indexOf(domain + '.') === 0;
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

function normaliseRows(list, domain, extra) {
  if (!Array.isArray(list)) return [];
  return list.filter(r => r && isEntity(r.entity, domain)).map(r => Object.assign(
    { entity: r.entity, label: str(r.label) }, extra ? extra(r) : {}));
}

/** One card, or null when it could never show anything. */
export function normaliseCard(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  let region = null;
  if (raw.region !== undefined) {
    const from = num(raw.region && raw.region.from), to = num(raw.region && raw.region.to);
    if (from == null || to == null || from < 0 || !(from < to)) return null;
    region = { from, to };
  }
  const media = normaliseRows(raw.media, 'media_player', r => ({ role: str(r.role) }));
  const lights = normaliseRows(raw.lights, 'light');
  const readings = normaliseRows(raw.readings, 'sensor', r => ({ humidity: isEntity(r.humidity, 'sensor') ? r.humidity : null }));
  if (!media.length && !lights.length && !readings.length) return null;
  return { index: index || 0, title: str(raw.title), region, media, lights, readings };
}

/**
 * rooms.json `sensors.items` -> Map itemId -> [card] (in authored order;
 * each card's `index` is its position in the authored list). An item left
 * with no usable card is dropped.
 */
export function normaliseItemBindings(items) {
  const out = new Map();
  if (!items || typeof items !== 'object') return out;
  Object.keys(items).forEach(itemId => {
    const raw = items[itemId];
    const list = Array.isArray(raw) ? raw : [raw];
    const cards = list.map((c, i) => normaliseCard(c, i)).filter(Boolean);
    if (cards.length) out.set(itemId, cards);
  });
  return out;
}

/** Every entity a card reads (rows, then humidity partners), de-duplicated. */
export function cardEntities(card) {
  const s = new Set();
  if (!card) return [];
  card.media.forEach(r => s.add(r.entity));
  card.lights.forEach(r => s.add(r.entity));
  card.readings.forEach(r => { s.add(r.entity); if (r.humidity) s.add(r.humidity); });
  return [...s];
}

/** Every entity any bound item reads -- what the HA client must record. */
export function itemBindingEntities(map) {
  const s = new Set();
  (map || new Map()).forEach(cards => cards.forEach(c => cardEntities(c).forEach(e => s.add(e))));
  return s;
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

/**
 * Where along an item's width a world point lies, in cm from the item's LEFT
 * edge seen from its front (the region convention above).
 *
 * @param point  {x, y, z} metres, the raycast hit
 * @param item   { origin: [x, y, z] metres (the placed group's position, the
 *               item's back-centre), rotationDeg (plan, clockwise), width cm }
 * @returns cm, or null when the item's width or origin is unknown
 *
 * The renderer sets group.rotation.y = -r, so the world offset d maps back to
 * the builder's local x by rotating it by +r about y:
 *   local.x = d.x cos r + d.z sin r
 * -- the plan width vector (cos r, sin r) dotted with d, as it must be.
 */
export function widthOffsetCm(point, item) {
  if (!point || !item || !Array.isArray(item.origin)) return null;
  const w = num(item.width);
  if (w == null || w <= 0) return null;
  const r = (num(item.rotationDeg) || 0) * Math.PI / 180;
  const dx = point.x - item.origin[0], dz = point.z - item.origin[2];
  const localX = dx * Math.cos(r) + dz * Math.sin(r);   // metres, 0 = centre
  return localX * 100 + w / 2;
}

/**
 * The card a tap at `offsetCm` along the item opens: the first card whose
 * region contains it, else the first card with no region, else null. A null
 * offset (width unknown) can only open a region-less card.
 */
export function pickItemCard(cards, offsetCm) {
  if (!Array.isArray(cards) || !cards.length) return null;
  if (offsetCm != null) {
    const hit = cards.find(c => c.region && offsetCm >= c.region.from && offsetCm <= c.region.to);
    if (hit) return hit;
  }
  return cards.find(c => !c.region) || null;
}

/**
 * A furniture hit -> its tap target, or null (not a target: the tap falls
 * through as a plain furniture tap).
 *
 * @param it     what home.furnitureItemAt returned: { id, type, room,
 *               rotationDeg, origin, width }
 * @param point  the hit point (world metres)
 * @param ctx    { items: Map from normaliseItemBindings, climate: rooms.json
 *               sensors.climate (room -> entity) }
 */
export function furnitureTapTarget(it, point, ctx) {
  if (!it) return null;
  const c = ctx || {};
  const cards = c.items && c.items.get(it.id);
  if (cards) {
    const card = pickItemCard(cards, widthOffsetCm(point, it));
    if (!card) return null;
    return { kind: 'item', id: cards.length > 1 ? it.id + '#' + card.index : it.id, itemId: it.id, card,
      entities: cardEntities(card) };
  }
  if (it.type === CLOCK_TYPE) return { kind: 'clock', id: it.id, itemId: it.id, entities: [] };
  if (it.type === RADIATOR_TYPE) {
    const eid = c.climate && it.room ? c.climate[it.room] : null;
    return typeof eid === 'string' && eid ? { kind: 'climate', id: it.room, itemId: it.id, entities: [eid] } : null;
  }
  return null;
}

/**
 * The furniture ids a tap should be tested against: every bound item, every
 * clock, and every radiator standing in a room with a climate binding.
 *
 * @param furniture  house.furniture ([{ id, type, room }])
 */
export function tappableFurnitureIds(furniture, items, climate) {
  const s = new Set(items ? items.keys() : []);
  (furniture || []).forEach(f => {
    if (!f || !f.id) return;
    if (f.type === CLOCK_TYPE) s.add(f.id);
    else if (f.type === RADIATOR_TYPE && climate && typeof climate[f.room] === 'string') s.add(f.id);
  });
  return s;
}

// ---------------------------------------------------------------------------
// Row models (raw HA state { state, attributes } in, what the row shows out)
// ---------------------------------------------------------------------------

export const isUnavailable = st => !st || st === 'unavailable' || st === 'unknown';
const OFF_STATES = new Set(['off', 'standby']);

// media_player supported_features bits (HA MediaPlayerEntityFeature).
export const MEDIA_FEATURE = Object.freeze({ VOLUME_SET: 4, TURN_ON: 128, TURN_OFF: 256, SELECT_SOURCE: 2048, SELECT_SOUND_MODE: 65536 });

const humanise = s => {
  const t = String(s || '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const objectName = eid => humanise(String(eid || '').split('.').slice(1).join('.'));

/** A row's display label: the binding's label, the entity's friendly_name, the id. */
export function rowLabel(row, raw) {
  if (row && row.label) return row.label;
  const fn = raw && raw.attributes && raw.attributes.friendly_name;
  return typeof fn === 'string' && fn.trim() ? fn.trim() : objectName(row && row.entity);
}

/**
 * A media_player row.
 * @returns { na, on, state, stateText, title, volume (0-100 | null when the
 *   device takes no volume), muted, sources [], source, soundModes [],
 *   soundMode, canPower }
 */
export function mediaRowModel(raw) {
  const st = raw ? raw.state : undefined;
  const a = (raw && raw.attributes) || {};
  if (isUnavailable(st)) {
    return { na: true, on: false, state: st || null, stateText: st === 'unavailable' ? 'Offline' : 'Unavailable',
      title: null, volume: null, muted: false, sources: [], source: null, soundModes: [], soundMode: null, canPower: false };
  }
  const on = !OFF_STATES.has(st);
  const feat = typeof a.supported_features === 'number' ? a.supported_features : null;
  const has = bit => feat == null || (feat & bit) !== 0;
  const title = (st === 'playing' || st === 'paused') && typeof a.media_title === 'string' && a.media_title ? a.media_title : null;
  const vol = num(a.volume_level);
  const volOk = on && (vol != null || (feat != null && (feat & MEDIA_FEATURE.VOLUME_SET) !== 0));
  const list = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []);
  const sources = on && has(MEDIA_FEATURE.SELECT_SOURCE) ? list(a.source_list) : [];
  const soundModes = on && has(MEDIA_FEATURE.SELECT_SOUND_MODE) ? list(a.sound_mode_list) : [];
  const stateText = { off: 'Off', standby: 'Standby', on: 'On', idle: 'Idle', playing: 'Playing', paused: 'Paused',
    buffering: 'Buffering' }[st] || humanise(st);
  return {
    na: false, on, state: st, stateText, title,
    volume: volOk ? Math.round((vol != null ? vol : 0) * 100) : null,
    muted: a.is_volume_muted === true,
    sources, source: typeof a.source === 'string' ? a.source : null,
    soundModes, soundMode: typeof a.sound_mode === 'string' ? a.sound_mode : null,
    canPower: has(on ? MEDIA_FEATURE.TURN_OFF : MEDIA_FEATURE.TURN_ON),
  };
}

/**
 * A light row: { na, on, bri (5-100), colorable, color ('#rrggbb' | null) }.
 * `colorable` is decided by the caller (light-color.js supportsColor) so this
 * module stays free of that dependency; the colour is passed in likewise.
 */
export function lightRowModel(raw, colorable, color) {
  const st = raw ? raw.state : undefined;
  if (isUnavailable(st)) return { na: true, on: false, bri: 100, colorable: false, color: null };
  const a = raw.attributes || {};
  const on = st === 'on';
  const b = num(a.brightness);
  const bri = on && b != null ? Math.max(1, Math.min(100, Math.round(b / 2.55))) : 100;
  return { na: false, on, bri, colorable: !!colorable, color: colorable ? (color || null) : null };
}

const fmtNumber = v => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(1));
// A temperature always carries one decimal (31.0°C beside 33.7°C), as the
// climate card does; any other unit drops a trailing .0.
const isTemperatureUnit = u => u === '°C' || u === '°F';
const unitText = u => (u === '°C' || u === '°F' || u === '%' ? u : ' ' + u);

/**
 * A reading row. OFFLINE IS NOT 0: an unavailable sensor reads "Offline",
 * an unknown one "Unavailable", one never heard from "No reading" -- never
 * a number.
 * @returns { na, text, value, unit, humidity (text | null) }
 */
export function readingRowModel(raw, humRaw) {
  const st = raw ? raw.state : undefined;
  let text, na = true, value = null, unit = null;
  if (!raw) text = 'No reading';
  else if (st === 'unavailable') text = 'Offline';
  else if (isUnavailable(st)) text = 'Unavailable';
  else {
    const a = raw.attributes || {};
    unit = typeof a.unit_of_measurement === 'string' ? a.unit_of_measurement : null;
    const n = Number(st);
    if (st !== '' && isFinite(n)) { value = n; text = (isTemperatureUnit(unit) ? n.toFixed(1) : fmtNumber(n)) + (unit ? unitText(unit) : ''); na = false; }
    else { text = humanise(st); na = false; }
  }
  let humidity = null;
  if (humRaw && !isUnavailable(humRaw.state)) {
    const h = Number(humRaw.state);
    if (humRaw.state !== '' && isFinite(h)) humidity = Math.round(h) + '%';
  }
  return { na, text, value, unit, humidity };
}

// ---------------------------------------------------------------------------
// Card copy: titles, the header icon, the first row's label
// ---------------------------------------------------------------------------

/**
 * A furniture `label` shortened for a card title. In a real house the label
 * is an authoring note ("Word clock (study, above the desk)", "Panel TV
 * (matte) - DRAFT POSITION"): keep what comes before the first
 * " (" or " - ". A binding's own `title` is the proper fix; this is the
 * fallback.
 */
export function shortLabel(label) {
  const s = typeof label === 'string' ? label.trim() : '';
  if (!s) return '';
  const cut = [' (', ' - ', ' – ', ' — '].map(sep => s.indexOf(sep)).filter(i => i >= 0);
  return (cut.length ? s.slice(0, Math.min(...cut)) : s).trim();
}

/** A bound card's title: its `title`, else the item's short label, else the id humanised. */
export function cardTitle(card, label, itemId) {
  if (card && card.title) return card.title;
  return shortLabel(label) || humanise(String(itemId || '').replace(/[-]+/g, '_'));
}

/**
 * The title-only binding of an item that needs no rows: `sensors.items[id]`
 * as `{ "title": "Kitchen clock" }` names a clock or a radiator. null when
 * there is none (or the binding is a list).
 */
export function bindingTitle(items, itemId) {
  const b = items && typeof items === 'object' ? items[itemId] : null;
  return b && !Array.isArray(b) && typeof b === 'object' ? str(b.title) : null;
}

/**
 * "<Room> <thing>" in sentence case -- "Home office clock", "Home office
 * radiator" -- or the bare thing, capitalised, with no room. The ONE rule
 * the clock and the radiator titles share, so the same room never reads two
 * ways. Words after the first lose a leading capital; ALL-CAPS words (TV)
 * are kept.
 */
export function roomThingTitle(roomName, thing) {
  const r = typeof roomName === 'string' ? roomName.trim() : '';
  const words = ((r ? r + ' ' : '') + thing).split(/\s+/);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1)
    : /^[A-Z][a-z]/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w)).join(' ');
}

/** A clock card's title: the binding's title exactly as written, else "<Room> clock". Never the label. */
export function clockTitle(title, roomName) {
  return title || roomThingTitle(roomName, 'clock');
}

/** A radiator's climate card title: the binding's title exactly as written, else "<Room> radiator". */
export function radiatorTitle(title, roomName) {
  return title || roomThingTitle(roomName, 'radiator');
}

/**
 * The card header's icon, from its PRIMARY row: the first media row's role
 * (a receiver or speaker is a speaker, a cast device a cast, else a TV),
 * else a bulb for a lights card, else a thermometer.
 * @returns 'speaker' | 'cast' | 'tv' | 'bulb' | 'thermometer'
 */
export function cardIcon(card) {
  if (!card) return 'thermometer';
  if (card.media && card.media.length) {
    const role = card.media[0].role;
    return role === 'receiver' || role === 'speaker' ? 'speaker' : role === 'cast' ? 'cast' : 'tv';
  }
  return card.lights && card.lights.length ? 'bulb' : 'thermometer';
}

/** What a row IS, for when its own label would only repeat the card title. */
export const ROLE_NAMES = Object.freeze({ tv: 'Television', cast: 'Cast', receiver: 'Receiver', speaker: 'Speaker' });
const KIND_NAMES = { media: 'Player', light: 'Light', reading: 'Reading' };

/**
 * The first row's label, unless it only repeats the card's title (a "TV"
 * card whose first row is "TV"): then what the row is -- its role name, or
 * its kind -- instead.
 */
export function rowLabelUnderTitle(label, title, role, kind) {
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  if (!same(label, title)) return label;
  const alt = (role && ROLE_NAMES[role]) || KIND_NAMES[kind] || label;
  return same(alt, title) ? (KIND_NAMES[kind] || alt) : alt;
}

// ---------------------------------------------------------------------------
// Commands -- { domain, service, data, target }, sent by the caller through
// the HA client (ha.callService); never sent from here.
// ---------------------------------------------------------------------------

const cmd = (domain, service, data, entity) => ({ domain, service, data: data || {}, target: { entity_id: entity } });

export function mediaPowerCommand(entity, on) { return cmd('media_player', on ? 'turn_on' : 'turn_off', {}, entity); }
export function mediaVolumeCommand(entity, pct) {
  const v = Math.max(0, Math.min(100, Math.round(+pct || 0)));
  return cmd('media_player', 'volume_set', { volume_level: Math.round(v) / 100 }, entity);
}
export function mediaSourceCommand(entity, source) { return cmd('media_player', 'select_source', { source: String(source) }, entity); }
export function mediaSoundModeCommand(entity, mode) { return cmd('media_player', 'select_sound_mode', { sound_mode: String(mode) }, entity); }

/**
 * A light row's command: turn_off, or turn_on with the brightness (and the
 * colour when `withColor`), the same data the sidebar's sendToHA builds.
 * @param state  { on, bri (1-100), color ('#rrggbb') }
 */
export function lightRowCommand(entity, state, withColor) {
  if (!state || !state.on) return cmd('light', 'turn_off', {}, entity);
  const data = {};
  if (state.bri != null) data.brightness = Math.round(Math.max(1, Math.min(100, state.bri)) * 2.55);
  if (withColor && typeof state.color === 'string' && /^#[0-9a-f]{6}$/i.test(state.color)) {
    const c = state.color;
    data.rgb_color = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  }
  return cmd('light', 'turn_on', data, entity);
}

/**
 * What a raw state becomes once `command` lands -- used for the optimistic
 * repaint after a send (until HA's echo arrives) and to move the demo's
 * sample devices. Returns a NEW state; the input is not mutated.
 */
export function applyCommand(raw, command) {
  const prev = raw || { state: 'off', attributes: {} };
  const a = Object.assign({}, prev.attributes || {});
  let st = prev.state;
  const d = (command && command.data) || {};
  switch (command && command.domain + '.' + command.service) {
    case 'media_player.turn_on': st = 'on'; break;
    case 'media_player.turn_off': st = 'off'; break;
    case 'media_player.volume_set': a.volume_level = d.volume_level; break;
    case 'media_player.select_source': a.source = d.source; break;
    case 'media_player.select_sound_mode': a.sound_mode = d.sound_mode; break;
    case 'light.turn_off': st = 'off'; break;
    case 'light.turn_on':
      st = 'on';
      if (d.brightness != null) a.brightness = d.brightness;
      if (d.rgb_color) a.rgb_color = d.rgb_color.slice();
      break;
    default: return prev;
  }
  return { state: st, attributes: a };
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

const pad = n => (n < 10 ? '0' : '') + n;
/** { time: 'HH:MM', seconds: 'SS', date } in local time, 24-hour. */
export function clockText(d, locale) {
  const date = typeof d.toLocaleDateString === 'function'
    ? d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
  return { time: pad(d.getHours()) + ':' + pad(d.getMinutes()), seconds: pad(d.getSeconds()), date };
}

// ---------------------------------------------------------------------------
// Demo samples (no Home Assistant configured)
// ---------------------------------------------------------------------------

/**
 * A sample raw state for a bound entity, so every card kind can be tried on
 * the demo house with no Home Assistant. Deterministic per (kind, index).
 * A media row with role 'receiver' is a full AV receiver (volume, source,
 * sound mode); any other media row is a TV / cast device (power + volume).
 */
export function mockItemState(kind, row, index) {
  const i = index || 0;
  if (kind === 'media') {
    if (row && row.role === 'receiver') {
      return { state: 'on', attributes: { supported_features: 4 | 8 | 128 | 256 | 2048 | 65536, volume_level: 0.35,
        source: 'TV', source_list: ['TV', 'Bluetooth', 'Game', 'Radio'], sound_mode: 'Stereo', sound_mode_list: ['Stereo', 'Surround', 'Night'] } };
    }
    return i % 2 === 0
      ? { state: 'off', attributes: { supported_features: 4 | 128 | 256 } }
      : { state: 'playing', attributes: { supported_features: 4 | 128 | 256, volume_level: 0.2, media_title: 'Sample programme' } };
  }
  if (kind === 'light') return i % 2 === 0 ? { state: 'on', attributes: { brightness: 153 } } : { state: 'off', attributes: {} };
  if (kind === 'humidity') return { state: String(40 + (i * 3) % 15), attributes: { unit_of_measurement: '%' } };
  return { state: (31 + (i * 2.7) % 12).toFixed(1), attributes: { unit_of_measurement: '°C', device_class: 'temperature' } };
}
