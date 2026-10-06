/**
 * speaker-players.js -- every media_player that belongs to one physical
 * speaker, and which of them is the one actually playing.
 *
 * WHY. Home Assistant often has several media_players for one speaker. With
 * Google Cast plus Music Assistant there are typically three:
 *
 *   media_player.<x>      the Cast integration's own entity
 *   media_player.<x>_ma   MA's "Home Assistant" player provider; its
 *                         active_queue is `media_player.<x>`
 *   media_player.<x>_2    MA's native Cast provider; its active_queue is the
 *                         speaker's cast UUID
 *
 * Music played from MA's own UI or app often lands on `_2` while a dashboard
 * is configured with `_ma` -- so a screen that follows one entity shows
 * nothing. Each of the three usually sits on its OWN device in the device
 * registry, so "same device" does not group them. What links them is an
 * identity key they share:
 *
 *   - a player's own entity_id                 (`_ma`'s queue names the cast entity)
 *   - its `active_queue` attribute             (an entity id, or the cast UUID)
 *   - its device's registry identifier values  (cast: the UUID without dashes;
 *                                               MA `_2`: the same UUID with dashes;
 *                                               MA `_ma`: `media_player.<x>`)
 *
 * Keys are compared lowercased with dashes removed, and groups are closed
 * transitively: `_ma` -> (queue) the cast entity -> (cast UUID) `_2`.
 *
 * With no registry (a non-admin token, or a failed fetch), a fallback joins
 * players whose friendly names share a stem ("Den", "Den - ma"),
 * besides the active_queue link.
 *
 * Pure: no I/O. ha-client.js fetches the registries (read-only list calls)
 * and passes them in.
 */

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isPlayer = id => typeof id === 'string' && id.indexOf('media_player.') === 0;

/** An identity key: lowercased, dashes removed; '' when unusable. */
export function playerKey(v) {
  if (typeof v !== 'string') return '';
  const k = v.trim().toLowerCase().replace(/-/g, '');
  return k.length >= 6 ? k : '';
}

/** A friendly name's stem: "Den - ma" / "Hall (google)" -> "den" / "hall". */
export function nameStem(name) {
  if (typeof name !== 'string') return '';
  return name.toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+-\s*ma\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The registries -> Map entity_id -> [identity keys from its device].
 *   entities: HA `config/entity_registry/list_for_display` result (its
 *             `entities` array of { ei, di }) or `list` rows ({ entity_id, device_id })
 *   devices:  `config/device_registry/list` rows ({ id, identifiers: [[domain, value]] })
 * Only media_players are kept. Missing or malformed input -> an empty map.
 */
export function registryKeys(entities, devices) {
  const out = new Map();
  const ents = Array.isArray(entities) ? entities : isObj(entities) && Array.isArray(entities.entities) ? entities.entities : [];
  const devIds = new Map();
  (Array.isArray(devices) ? devices : []).forEach(d => {
    if (!isObj(d) || typeof d.id !== 'string') return;
    const keys = (Array.isArray(d.identifiers) ? d.identifiers : [])
      .map(p => (Array.isArray(p) ? playerKey(p[1]) : '')).filter(Boolean);
    devIds.set(d.id, keys);
  });
  ents.forEach(e => {
    if (!isObj(e)) return;
    const eid = e.ei || e.entity_id, did = e.di || e.device_id;
    if (!isPlayer(eid) || !did || !devIds.has(did)) return;
    out.set(eid, devIds.get(did));
  });
  return out;
}

function stateList(states) {
  if (states instanceof Map) return [...states].map(([entity_id, s]) => Object.assign({ entity_id }, s));
  return Array.isArray(states) ? states : [];
}

/**
 * Every media_player of `anchor`'s speaker, `anchor` first, then the rest in
 * the order of `states`.
 *   states:  [{ entity_id, attributes }] or Map entity_id -> { attributes }
 *   regKeys: registryKeys(...) or null (no registry: the name fallback is used)
 * An anchor that is not a media_player -> []. An anchor nothing links to -> [anchor].
 */
export function speakerSiblings(anchor, states, regKeys) {
  if (!isPlayer(anchor)) return [];
  const useReg = regKeys instanceof Map && regKeys.size > 0;
  const players = new Map();
  stateList(states).forEach(s => {
    if (!isObj(s) || !isPlayer(s.entity_id)) return;
    const a = isObj(s.attributes) ? s.attributes : {};
    const keys = new Set([playerKey(s.entity_id), playerKey(a.active_queue)]);
    if (useReg) (regKeys.get(s.entity_id) || []).forEach(k => keys.add(k));
    else { const n = nameStem(a.friendly_name); if (n) keys.add('name:' + n); }
    keys.delete('');
    players.set(s.entity_id, keys);
  });
  if (!players.has(anchor)) players.set(anchor, new Set([playerKey(anchor)]));
  const group = new Set([anchor]);
  const keys = new Set(players.get(anchor));
  for (let grew = true; grew;) {
    grew = false;
    players.forEach((pk, eid) => {
      if (group.has(eid)) return;
      for (const k of pk) {
        if (!keys.has(k)) continue;
        group.add(eid);
        pk.forEach(x => keys.add(x));
        grew = true;
        break;
      }
    });
  }
  return [anchor].concat([...players.keys()].filter(e => e !== anchor && group.has(e)));
}

/** How much a playing state can show: title, artist, artwork, a duration. */
export function metadataScore(raw) {
  const a = raw && isObj(raw.attributes) ? raw.attributes : {};
  return (a.media_title ? 4 : 0) + (a.entity_picture || a.entity_picture_local ? 2 : 0) +
    (a.media_artist || a.media_album_artist ? 1 : 0) + (Number(a.media_duration) > 0 ? 1 : 0);
}

/**
 * Which of `ids` the speaker's screen should follow -> { entityId, raw }.
 *   - any `playing`: the one with the richest metadata (ties: earliest in ids);
 *   - else any `buffering` (a track change): that one;
 *   - else the first id (the configured player), whatever its state.
 * getRaw(entityId) -> { state, attributes } | null. Empty ids -> null.
 */
export function pickSpeakerPlayer(ids, getRaw) {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return null;
  let best = null, bestScore = -1, buffering = null;
  list.forEach(eid => {
    const raw = getRaw(eid);
    const st = raw && raw.state;
    if (st === 'playing') {
      const s = metadataScore(raw);
      if (s > bestScore) { best = { entityId: eid, raw }; bestScore = s; }
    } else if (st === 'buffering' && !buffering) buffering = { entityId: eid, raw };
  });
  return best || buffering || { entityId: list[0], raw: getRaw(list[0]) };
}
