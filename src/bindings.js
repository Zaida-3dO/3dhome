/**
 * bindings.js -- Home Assistant bindings as data (plan B3), pure.
 *
 * A TARGET is something the app already drives from Home Assistant:
 *
 *   curtain:<curtainId>         openPct              (a cover)
 *   light:<roomId>/<channel>    on, brightness, color (a light)
 *
 * Each of a target's CHANNELS is either STATIC (a value in geometry.json:
 * a curtain's `openPct`, a light fixture's `static`) or bound to an ENTITY:
 * `{ entity, attribute?, transform? }`. Entity ids live ONLY in rooms.json.
 *
 * WHERE A BINDING IS WRITTEN. The legacy rooms.json slot first:
 *   sensors.curtains[id] = [entity]   is  curtain:id.openPct = { entity, attribute: current_position, transform: identity }
 *   rooms[room][ch]      = [entity]   is  light:room/ch.{on, brightness, color} from that one entity, the defaults below
 * Only a binding the slot CANNOT say (another attribute, a non-default
 * transform, a light whose channels follow different entities) goes into
 * the rooms.json 1.11 `bindings` block, keyed by the target. A target bound
 * in BOTH places is refused (normaliseBindings reports it and keeps the
 * legacy slot; scripts/validate-house.py makes it an error).
 *
 * Furniture tap-card rows (sensors.items) are always their legacy slot: a
 * row is an entity, with nothing to transform.
 *
 * PRECEDENCE for what a channel shows: a rooms.json binding, else the
 * geometry static value, else the builder/engine DEFAULTS
 * (docs/house-profile.md, "Bindings").
 *
 * No DOM, no socket. Tested in scripts/test-bindings.mjs.
 */

/** The rooms.json schemaVersion that introduced `bindings` and `sidebar`. */
export const BINDINGS_SCHEMA_VERSION = '1.11';
/** sensors.items (furniture tap cards) needs this rooms schemaVersion. */
export const ITEMS_SCHEMA_VERSION = '1.6';

/** The closed set of transforms. No expressions, ever. */
export const TRANSFORMS = Object.freeze(['identity', 'pct255', 'invert', 'onOff', 'rgb']);

/** Every domain the app drives, and so every domain the entity picker lists. */
export const PICKER_DOMAINS = Object.freeze(['light', 'cover', 'switch', 'input_boolean', 'media_player', 'script']);

/** A target kind's channels, and each channel's legacy-slot default. */
export const TARGET_CHANNELS = Object.freeze({
  curtain: Object.freeze(['openPct']),
  light: Object.freeze(['on', 'brightness', 'color']),
});
export const CHANNEL_DEFAULTS = Object.freeze({
  'curtain.openPct': Object.freeze({ attribute: 'current_position', transform: 'identity', domains: ['cover'] }),
  'light.on': Object.freeze({ attribute: null, transform: 'onOff', domains: ['light'] }),
  'light.brightness': Object.freeze({ attribute: 'brightness', transform: 'pct255', domains: ['light'] }),
  'light.color': Object.freeze({ attribute: 'rgb_color', transform: 'rgb', domains: ['light'] }),
});
/** What the panel offers per channel (attribute choices; transforms are TRANSFORMS filtered). */
export const CHANNEL_CHOICES = Object.freeze({
  'curtain.openPct': { attributes: ['current_position', 'current_tilt_position'], transforms: ['identity', 'invert'] },
  'light.on': { attributes: [null], transforms: ['onOff'] },
  'light.brightness': { attributes: ['brightness'], transforms: ['pct255', 'identity', 'invert'] },
  'light.color': { attributes: ['rgb_color'], transforms: ['rgb'] },
});

export const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const ID_RE = /^[a-z][a-z0-9_]*$/;
const KEY_RE = /^(curtain):([a-z][a-z0-9_]*)$|^(light):([a-z][a-z0-9_]*)\/([a-z][a-z0-9_]*)$/;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const domainOf = eid => String(eid || '').split('.')[0];

// ---- Keys ------------------------------------------------------------------

/** 'curtain:x' -> { kind, id }; 'light:room/ch' -> { kind, id, room, channel }; else null. */
export function parseTargetKey(key) {
  const m = KEY_RE.exec(String(key || ''));
  if (!m) return null;
  if (m[1]) return { kind: 'curtain', id: m[2] };
  return { kind: 'light', id: m[4] + '/' + m[5], room: m[4], channel: m[5] };
}
export const curtainKey = id => 'curtain:' + id;
export const lightKey = (room, channel) => 'light:' + room + '/' + channel;

// ---- Transforms --------------------------------------------------------------

const ON_STATES = new Set(['on', 'open', 'opening', 'playing', 'home', 'true']);

/** One raw value through one transform. null when the value cannot be read. */
export function applyTransform(value, transform) {
  const t = transform || 'identity';
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  switch (t) {
    case 'identity':
      if (Number.isFinite(n)) return n;
      return value === undefined ? null : value;
    case 'pct255':
      return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n / 2.55))) : null;
    case 'invert':
      return Number.isFinite(n) ? Math.max(0, Math.min(100, 100 - n)) : null;
    case 'onOff':
      if (typeof value === 'boolean') return value;
      return typeof value === 'string' ? ON_STATES.has(value.toLowerCase()) : null;
    case 'rgb':
      if (!Array.isArray(value) || value.length < 3 || !value.slice(0, 3).every(c => Number.isFinite(+c))) return null;
      return '#' + value.slice(0, 3).map(c => Math.max(0, Math.min(255, Math.round(+c))).toString(16).padStart(2, '0')).join('');
    default:
      return null;
  }
}

/**
 * A raw HA state ({ state, attributes }) read through a binding: the
 * attribute (or, with none, the state string), then the transform. null for
 * an unavailable / unknown entity or a value the transform cannot read.
 */
export function readBinding(raw, binding) {
  if (!raw || !binding) return null;
  if (raw.state === 'unavailable' || raw.state === 'unknown') return null;
  const src = binding.attribute ? (raw.attributes || {})[binding.attribute] : raw.state;
  if (src === undefined || src === null) return null;
  return applyTransform(src, binding.transform);
}

// ---- One binding -------------------------------------------------------------

/** `{ entity, attribute?, transform? }` for a channel -> the full form, or an error string. */
export function normaliseChannel(kind, channel, b) {
  const def = CHANNEL_DEFAULTS[kind + '.' + channel];
  if (!def) return 'unknown channel "' + channel + '" for a ' + kind;
  if (!isObj(b)) return 'must be an object { entity, attribute?, transform? }';
  if (typeof b.entity !== 'string' || !ENTITY_RE.test(b.entity)) return 'entity must be a Home Assistant entity id';
  if (def.domains.indexOf(domainOf(b.entity)) === -1) return 'entity must be a ' + def.domains.join(' / ') + ' entity';
  if (b.attribute != null && (typeof b.attribute !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(b.attribute))) return 'attribute must be an attribute name';
  if (b.transform != null && TRANSFORMS.indexOf(b.transform) === -1) return 'transform must be one of ' + TRANSFORMS.join(', ');
  return {
    entity: b.entity,
    attribute: b.attribute != null ? b.attribute : def.attribute,
    transform: b.transform != null ? b.transform : def.transform,
  };
}

/** Is this (full-form) binding what the target's legacy slot means? */
export function isDefaultChannel(kind, channel, b) {
  const def = CHANNEL_DEFAULTS[kind + '.' + channel];
  if (!def || !b) return false;
  return (b.attribute != null ? b.attribute : def.attribute) === def.attribute &&
    (b.transform != null ? b.transform : def.transform) === def.transform;
}

// ---- The whole document ----------------------------------------------------------

/**
 * rooms.json -> every bound target, legacy slot or `bindings` block:
 *   { targets: Map key -> { kind, id, room?, channel?, source: 'legacy'|'bindings',
 *                           entities: [ids] (legacy: the whole slot list),
 *                           channels: { <ch>: { entity, attribute, transform } } },
 *     block:   Map key -> the same, for the `bindings` entries that were KEPT,
 *     errors:  [{ key, message }] }
 * A `bindings` entry for a target its legacy slot also binds is refused
 * (an error, the legacy slot wins). So is a malformed entry or channel.
 */
export function normaliseBindings(roomsDoc) {
  const targets = new Map(), block = new Map(), errors = [];
  const doc = isObj(roomsDoc) ? roomsDoc : {};
  const sensors = isObj(doc.sensors) ? doc.sensors : {};
  Object.entries(isObj(sensors.curtains) ? sensors.curtains : {}).forEach(([id, ents]) => {
    const list = Array.isArray(ents) ? ents.filter(e => typeof e === 'string' && e) : [];
    if (!list.length) return;
    const d = CHANNEL_DEFAULTS['curtain.openPct'];
    targets.set(curtainKey(id), { kind: 'curtain', id, source: 'legacy', entities: list,
      channels: { openPct: { entity: list[0], attribute: d.attribute, transform: d.transform } } });
  });
  Object.entries(isObj(doc.rooms) ? doc.rooms : {}).forEach(([room, chans]) => {
    Object.entries(isObj(chans) ? chans : {}).forEach(([channel, ents]) => {
      const list = Array.isArray(ents) ? ents.filter(e => typeof e === 'string' && e) : [];
      if (!list.length) return;
      const channels = {};
      TARGET_CHANNELS.light.forEach(ch => {
        const d = CHANNEL_DEFAULTS['light.' + ch];
        channels[ch] = { entity: list[0], attribute: d.attribute, transform: d.transform };
      });
      targets.set(lightKey(room, channel), { kind: 'light', id: room + '/' + channel, room, channel, source: 'legacy', entities: list, channels });
    });
  });
  Object.entries(isObj(doc.bindings) ? doc.bindings : {}).forEach(([key, entry]) => {
    const t = parseTargetKey(key);
    if (!t) { errors.push({ key, message: 'unknown target "' + key + '" (expected curtain:<id> or light:<room>/<channel>)' }); return; }
    if (targets.has(key)) {
      errors.push({ key, message: '"' + key + '" is bound both in its legacy rooms.json slot and in `bindings` -- remove one (the legacy slot is used)' });
      return;
    }
    if (!isObj(entry)) { errors.push({ key, message: 'must be an object of channels' }); return; }
    const channels = {};
    let bad = false;
    Object.entries(entry).forEach(([ch, b]) => {
      const r = normaliseChannel(t.kind, ch, b);
      if (typeof r === 'string') { errors.push({ key, message: ch + ': ' + r }); bad = true; return; }
      channels[ch] = r;
    });
    if (bad || !Object.keys(channels).length) { if (!bad) errors.push({ key, message: 'binds no channel' }); return; }
    const rec = Object.assign({}, t, { source: 'bindings', entities: uniq(Object.values(channels).map(c => c.entity)), channels });
    targets.set(key, rec);
    block.set(key, rec);
  });
  return { targets, block, errors };
}

const uniq = a => a.filter((v, i) => a.indexOf(v) === i);

/**
 * The page's view of rooms.json with every KEPT `bindings` entry folded into
 * the legacy shapes, so the sidebar rows, the curtain senders and the light
 * commands find it where they always look: a curtain in sensors.curtains, a
 * light channel in rooms[room][channel] (its `on` entity, else the first
 * channel's). The HA client is NOT given this: it takes the raw slots plus
 * `bindings`, and applies each binding's attribute and transform itself.
 * Returns { rooms, sensors } (copies; the input is untouched).
 */
export function foldBindings(roomsDoc) {
  const doc = isObj(roomsDoc) ? roomsDoc : {};
  const rooms = isObj(doc.rooms) ? clone(doc.rooms) : null;
  const sensors = isObj(doc.sensors) ? clone(doc.sensors) : null;
  const { block } = normaliseBindings(doc);
  if (!block.size) return { rooms, sensors };
  const r = rooms || {}, s = sensors || {};
  block.forEach(t => {
    if (t.kind === 'curtain') {
      (s.curtains || (s.curtains = {}))[t.id] = [t.channels.openPct.entity];
    } else {
      const c = t.channels.on || t.channels.brightness || t.channels.color;
      (r[t.room] || (r[t.room] = {}))[t.channel] = [c.entity];
    }
  });
  return { rooms: r, sensors: s };
}

// ---- Writers (edit mode) -----------------------------------------------------------
// Each takes a rooms.json document and returns a NEW one; untouched members
// keep their identity, so src/json-layout.js re-emits them byte for byte.

function ensureVersion(doc, v) {
  const cur = String(doc.schemaVersion || '0').split('.').map(Number), want = v.split('.').map(Number);
  const older = (cur[0] || 0) < want[0] || ((cur[0] || 0) === want[0] && (cur[1] || 0) < want[1]);
  if (older) doc.schemaVersion = v;
}

/** The current binding of one target, in the panel's terms, or null (static). */
export function bindingOf(roomsDoc, key) {
  const t = normaliseBindings(roomsDoc).targets.get(key);
  return t ? { source: t.source, entities: t.entities.slice(), channels: clone(t.channels) } : null;
}

/**
 * Bind (or, with `channels` null, unbind) one target. `channels` maps each
 * channel to `{ entity, attribute?, transform? }`. The legacy slot is used
 * when it can say the binding exactly (every channel at its default, a light
 * with all three channels on ONE entity); otherwise the `bindings` block,
 * and schemaVersion is raised to 1.11. A legacy slot's other members (a
 * multi-motor curtain, a light group) survive when its first entity is kept.
 */
export function setTargetBinding(roomsDoc, key, channels) {
  const t = parseTargetKey(key);
  if (!t) throw new Error('unknown binding target "' + key + '"');
  const doc = Object.assign({}, roomsDoc || {});
  const prev = normaliseBindings(roomsDoc).targets.get(key);
  const prevList = prev && prev.source === 'legacy' ? prev.entities : null;
  // Drop the target from both places.
  if (t.kind === 'curtain' && isObj(doc.sensors) && isObj(doc.sensors.curtains) && t.id in doc.sensors.curtains) {
    const curtains = Object.assign({}, doc.sensors.curtains); delete curtains[t.id];
    doc.sensors = Object.assign({}, doc.sensors, { curtains });
  }
  if (t.kind === 'light' && isObj(doc.rooms) && isObj(doc.rooms[t.room]) && t.channel in doc.rooms[t.room]) {
    const room = Object.assign({}, doc.rooms[t.room]); delete room[t.channel];
    doc.rooms = Object.assign({}, doc.rooms, { [t.room]: room });
    if (!Object.keys(room).length) { const rs = Object.assign({}, doc.rooms); delete rs[t.room]; doc.rooms = rs; }
  }
  if (isObj(doc.bindings) && key in doc.bindings) {
    const b = Object.assign({}, doc.bindings); delete b[key];
    if (Object.keys(b).length) doc.bindings = b; else delete doc.bindings;
  }
  if (!channels) return doc;
  const full = {};
  Object.entries(channels).forEach(([ch, b]) => {
    if (!b) return;
    const r = normaliseChannel(t.kind, ch, b);
    if (typeof r === 'string') throw new Error(key + ' ' + ch + ': ' + r);
    full[ch] = r;
  });
  const chs = Object.keys(full);
  if (!chs.length) return doc;
  const keepList = entity => (prevList && prevList[0] === entity ? prevList.slice() : [entity]);
  const legacyOk = t.kind === 'curtain'
    ? isDefaultChannel('curtain', 'openPct', full.openPct)
    : TARGET_CHANNELS.light.every(ch => full[ch] && isDefaultChannel('light', ch, full[ch]) && full[ch].entity === full.on.entity);
  if (legacyOk && t.kind === 'curtain') {
    const sensors = Object.assign({}, doc.sensors || {});
    sensors.curtains = Object.assign({}, sensors.curtains || {}, { [t.id]: keepList(full.openPct.entity) });
    doc.sensors = sensors;
    return doc;
  }
  if (legacyOk) {
    const rooms = Object.assign({}, doc.rooms || {});
    rooms[t.room] = Object.assign({}, rooms[t.room] || {}, { [t.channel]: keepList(full.on.entity) });
    doc.rooms = rooms;
    return doc;
  }
  const entry = {};
  chs.forEach(ch => {
    const def = CHANNEL_DEFAULTS[t.kind + '.' + ch];
    const out = { entity: full[ch].entity };
    if (full[ch].attribute !== def.attribute && full[ch].attribute != null) out.attribute = full[ch].attribute;
    if (full[ch].transform !== def.transform) out.transform = full[ch].transform;
    entry[ch] = out;
  });
  doc.bindings = Object.assign({}, doc.bindings || {}, { [key]: entry });
  ensureVersion(doc, BINDINGS_SCHEMA_VERSION);
  return doc;
}

// ---- Furniture tap-card rows (sensors.items) --------------------------------------

/** The row kinds edit mode binds on a furniture item, and their card lists. */
export const ITEM_ROW_KINDS = Object.freeze({
  media: { list: 'media', domains: ['media_player'] },
  light: { list: 'lights', domains: ['light'] },
  switch: { list: 'switches', domains: ['switch', 'input_boolean'] },
});

/** Every media / light / switch row an item's cards carry: [{ card, kind, index, entity, label }]. */
export function itemRows(roomsDoc, itemId) {
  const raw = roomsDoc && isObj(roomsDoc.sensors) && isObj(roomsDoc.sensors.items) ? roomsDoc.sensors.items[itemId] : null;
  const cards = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  cards.forEach((card, ci) => {
    if (!isObj(card)) return;
    Object.entries(ITEM_ROW_KINDS).forEach(([kind, k]) => {
      (Array.isArray(card[k.list]) ? card[k.list] : []).forEach((row, index) => {
        if (isObj(row)) out.push({ card: ci, kind, index, entity: row.entity, label: row.label || null });
      });
    });
  });
  return out;
}

function withItemCards(roomsDoc, itemId, fn) {
  const doc = Object.assign({}, roomsDoc || {});
  const sensors = Object.assign({}, doc.sensors || {});
  const items = Object.assign({}, sensors.items || {});
  const raw = items[itemId];
  const wasArray = Array.isArray(raw);
  let cards = wasArray ? raw.map(c => clone(c)) : raw ? [clone(raw)] : [];
  cards = fn(cards);
  const hasRows = c => isObj(c) && (typeof c.title === 'string' || Object.keys(c).some(k => Array.isArray(c[k]) && c[k].length));
  cards = cards.filter(hasRows);
  if (!cards.length) delete items[itemId];
  else items[itemId] = wasArray || cards.length > 1 ? cards : cards[0];
  if (Object.keys(items).length) sensors.items = items; else delete sensors.items;
  doc.sensors = sensors;
  if (items[itemId]) ensureVersion(doc, ITEMS_SCHEMA_VERSION);
  return doc;
}

/** Point one existing row at another entity. */
export function setItemRowEntity(roomsDoc, itemId, ref, entity) {
  const k = ITEM_ROW_KINDS[ref && ref.kind];
  if (!k) throw new Error('unknown row kind');
  if (!ENTITY_RE.test(String(entity)) || k.domains.indexOf(domainOf(entity)) === -1) throw new Error('a ' + ref.kind + ' row needs a ' + k.domains.join(' / ') + ' entity');
  return withItemCards(roomsDoc, itemId, cards => {
    const row = cards[ref.card] && cards[ref.card][k.list] && cards[ref.card][k.list][ref.index];
    if (!row) throw new Error('no such row');
    row.entity = entity;
    return cards;
  });
}

/** Add a row of `kind` bound to `entity` (to the first card; one is made if the item has none). */
export function addItemRow(roomsDoc, itemId, kind, entity, label) {
  const k = ITEM_ROW_KINDS[kind];
  if (!k) throw new Error('unknown row kind "' + kind + '"');
  if (!ENTITY_RE.test(String(entity)) || k.domains.indexOf(domainOf(entity)) === -1) throw new Error('a ' + kind + ' row needs a ' + k.domains.join(' / ') + ' entity');
  return withItemCards(roomsDoc, itemId, cards => {
    if (!cards.length) cards.push({});
    const card = cards[0];
    const row = { entity };
    if (label) row.label = label;
    card[k.list] = (Array.isArray(card[k.list]) ? card[k.list] : []).concat([row]);
    return cards;
  });
}

/** Remove one row; a card left with no rows (and no title) goes, and so does an item left with no card. */
export function removeItemRow(roomsDoc, itemId, ref) {
  const k = ITEM_ROW_KINDS[ref && ref.kind];
  if (!k) throw new Error('unknown row kind');
  return withItemCards(roomsDoc, itemId, cards => {
    const card = cards[ref.card];
    if (!card || !Array.isArray(card[k.list])) return cards;
    card[k.list] = card[k.list].filter((_, i) => i !== ref.index);
    if (!card[k.list].length) delete card[k.list];
    return cards;
  });
}

// ---- Sidebar (rooms.json 1.11 `sidebar`) --------------------------------------------

/** Sidebar `hide` group names: one entry hides every row of that kind. */
export const SIDEBAR_GROUPS = Object.freeze({ door: 'doors', curtain: 'curtains', vacuum: 'vacuums' });

export const EXTRA_KINDS = Object.freeze({
  light: ['light'],
  cover: ['cover'],
  switch: ['switch', 'input_boolean'],
  script: ['script'],
});

/** One room's sidebar config from rooms.json, cleaned: { hide: [], show: [], extra: [] }. */
export function roomSidebar(roomsDoc, roomId) {
  const raw = roomsDoc && isObj(roomsDoc.sidebar) && isObj(roomsDoc.sidebar[roomId]) ? roomsDoc.sidebar[roomId] : {};
  return {
    hide: Array.isArray(raw.hide) ? raw.hide.slice() : [],
    show: Array.isArray(raw.show) ? raw.show.slice() : [],
    extra: Array.isArray(raw.extra) ? raw.extra.map(x => clone(x)) : [],
  };
}

/**
 * Write one room's sidebar config. Empty lists are left out, a room with
 * nothing left is removed, and an empty `sidebar` goes too. Raises
 * schemaVersion to 1.11 when anything is written. An `extra` entry must be
 * { kind, entity (of that kind's domain), label, confirm? (script only), variables? (script only) }.
 */
export function setRoomSidebar(roomsDoc, roomId, cfg) {
  if (!ID_RE.test(String(roomId))) throw new Error('bad room id');
  const doc = Object.assign({}, roomsDoc || {});
  const out = {};
  const c = cfg || {};
  const hide = uniq((c.hide || []).filter(k => typeof k === 'string' && k));
  const show = uniq((c.show || []).filter(k => typeof k === 'string' && /^item:[a-z0-9_-]+$/i.test(k)));
  const extra = (c.extra || []).map(x => {
    const doms = EXTRA_KINDS[x && x.kind];
    if (!doms) throw new Error('an extra row needs a kind of ' + Object.keys(EXTRA_KINDS).join(' / '));
    if (!ENTITY_RE.test(String(x.entity)) || doms.indexOf(domainOf(x.entity)) === -1) throw new Error('a ' + x.kind + ' row needs a ' + doms.join(' / ') + ' entity');
    const label = typeof x.label === 'string' ? x.label.trim() : '';
    if (!label) throw new Error('an extra row needs a label');
    const e = { kind: x.kind, entity: x.entity, label };
    if (x.kind === 'script' && x.confirm) e.confirm = true;
    if (x.kind === 'script' && isObj(x.variables) && Object.keys(x.variables).length) e.variables = clone(x.variables);
    return e;
  });
  if (hide.length) out.hide = hide;
  if (show.length) out.show = show;
  if (extra.length) out.extra = extra;
  const sidebar = Object.assign({}, isObj(doc.sidebar) ? doc.sidebar : {});
  if (Object.keys(out).length) sidebar[roomId] = out; else delete sidebar[roomId];
  if (Object.keys(sidebar).length) { doc.sidebar = sidebar; ensureVersion(doc, BINDINGS_SCHEMA_VERSION); } else delete doc.sidebar;
  return doc;
}

// ---- The entity picker ---------------------------------------------------------------

/**
 * A get_states result -> what the picker keeps: [{ entity_id, friendly_name,
 * domain }] in `domains` only (default PICKER_DOMAINS), sorted by name. Every
 * other field of the state is dropped here, at the boundary.
 */
export function pickerEntities(states, domains) {
  const allow = new Set(Array.isArray(domains) && domains.length ? domains : PICKER_DOMAINS);
  const out = [];
  (Array.isArray(states) ? states : []).forEach(s => {
    if (!s || typeof s.entity_id !== 'string' || !ENTITY_RE.test(s.entity_id)) return;
    const domain = domainOf(s.entity_id);
    if (!allow.has(domain) || PICKER_DOMAINS.indexOf(domain) === -1) return;
    const fn = s.attributes && typeof s.attributes.friendly_name === 'string' && s.attributes.friendly_name.trim()
      ? s.attributes.friendly_name.trim() : s.entity_id;
    out.push({ entity_id: s.entity_id, friendly_name: fn, domain });
  });
  return out.sort((a, b) => a.friendly_name.localeCompare(b.friendly_name) || a.entity_id.localeCompare(b.entity_id));
}

/** The picker's search: every word must appear in the name or the id. */
export function filterEntities(list, query, domains) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const allow = Array.isArray(domains) && domains.length ? new Set(domains) : null;
  return (list || []).filter(e => (!allow || allow.has(e.domain)) &&
    words.every(w => e.friendly_name.toLowerCase().indexOf(w) !== -1 || e.entity_id.indexOf(w) !== -1));
}

// ---- The privacy line --------------------------------------------------------------

/**
 * Every string in `doc` that looks like an entity id of a domain the app
 * binds (or a sensor / binary_sensor / climate ...). geometry.json must
 * have none: scripts/test-bindings.mjs asserts it after every edit-mode write.
 */
const ENTITY_DOMAINS_SEEN = /^(light|cover|switch|input_boolean|media_player|script|sensor|binary_sensor|climate|vacuum|camera|scene|fan|remote|automation|input_number|input_select)\.[a-z0-9_]+$/;
export function findEntityIds(doc) {
  const out = [];
  (function walk(v) {
    if (typeof v === 'string') { if (ENTITY_DOMAINS_SEEN.test(v)) out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (isObj(v)) Object.keys(v).forEach(k => { if (ENTITY_DOMAINS_SEEN.test(k)) out.push(k); walk(v[k]); });
  })(doc);
  return out;
}
