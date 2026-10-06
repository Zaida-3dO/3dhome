/**
 * sound-model.js -- the sound menu's pure half: the rooms.json binding, what
 * each section shows, and the exact Home Assistant commands each control
 * sends. No DOM, no socket: src/sound-menu.js renders and wires it,
 * src/ha-client.js records the raw states. Unit-tested in
 * scripts/test-sound-menu.mjs.
 *
 * THE MENU mirrors the wall tablet's "Ambience" pop-up (a Bubble Card in the
 * owner's Home Assistant dashboard): three sections in this order --
 *
 *   NOW PLAYING  one slide per configured speaker whose state is 'playing',
 *                with transport (volume -/+, previous, play/pause, next,
 *                stop); a "Stop all" pill in the header
 *   PLAY ON      the speaker checklist: the shared `selection` helper (an
 *                input_text holding a JSON list of entity ids). A tap runs
 *                the `toggleScript`, which refuses to remove the last one
 *   SOUNDS       the catalogue (a sensor whose `tiles` attribute lists
 *                { id, label, icon, ... }), recents first then A-Z, six per
 *                page. A tap selects the label on the `sound` input_select;
 *                Home Assistant's own automation then plays it on every
 *                selected speaker. The app NEVER calls play_media for a
 *                local sound, so volume, repeat and the recents list behave
 *                exactly as they do from the tablet.
 *
 * THE BINDING (rooms.json schemaVersion 1.12, `sensors.soundMenu`):
 *
 *   soundMenu: {
 *     selection:    'input_text.x',     // JSON list of selected speakers
 *     toggleScript: 'script.x',         // toggles one speaker, min 1
 *     sound:        'input_select.x',   // the selected sound; 'None' = off
 *     catalogue:    'sensor.x',         // attribute `tiles`
 *     recent:       'input_text.x',     // optional: JSON [[id, codes], ...]
 *     speakers:     [{ entity: 'media_player.x', label: 'Bedroom' }, ...],
 *     openFrom:     { <furnitureItemId>: 'media_player.x' | null, ... },
 *     spotify:      { configEntryId?: '<Music Assistant config entry>' }
 *   }
 *
 * `spotify` (optional) adds a Spotify tile, first in SOUNDS, opening a picker:
 * Music Assistant's recently played Spotify tracks, or a search. A pick plays
 * on every selected speaker through music_assistant.play_media -- after the
 * ambience sound is deselected (see SPOTIFY below). Without `configEntryId`
 * the Music Assistant entry is looked up once (config_entries/get).
 *
 * `openFrom` makes any number of furniture items open the one shared menu;
 * each names the speaker it IS (highlighted and listed first), or null.
 *
 * TWO HOME ASSISTANT RACES the app has to work around, both because the
 * ambience automation is `mode: single` (a trigger that arrives while a run
 * is in progress is DROPPED, while the input_select still shows the new
 * value):
 *
 *   BUSY WINDOW  after a sound tap (or a stop) the sound tiles are disabled
 *                until the speakers report the result, or BUSY_MAX_MS --
 *                never less than BUSY_MIN_MS. See soundSettled / isBusy.
 *   RE-TAP       tapping the sound that is ALREADY selected RE-TRIGGERS it:
 *                'None' first, then -- once that has landed and the selected
 *                speakers have stopped (or RETRIGGER_MAX_MS) -- the label
 *                again. Without this the tap would be a silent no-op (the
 *                state does not change, so the automation never fires),
 *                which strands the user whenever the sound was dropped by
 *                the race above or something else has since played on the
 *                speakers. See soundTapPlan / retriggerReady.
 */

export const SOUND_NONE = 'None';
export const PAGE_SIZE = 6;
export const VOLUME_STEP = 0.05;
export const BUSY_MIN_MS = 1200;
export const BUSY_MAX_MS = 4000;
export const RETRIGGER_GAP_MS = 1000;
export const RETRIGGER_MAX_MS = 4000;
export const OPTIMISTIC_MS = 3000;
export const TITLE_MAX = 38;

const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const ITEM_ID_RE = /^[a-z][a-z0-9_-]*$/;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const inDomain = (eid, domain) => typeof eid === 'string' && ENTITY_RE.test(eid) && eid.split('.')[0] === domain;
const UNREAL = new Set(['unavailable', 'unknown', '']);

// ---------------------------------------------------------------------------
// The binding
// ---------------------------------------------------------------------------

/**
 * rooms.json `sensors.soundMenu` -> the normalised binding, or null when it
 * cannot drive a menu (a required helper missing or of the wrong domain, or
 * no valid speaker). A speaker of the wrong domain or a duplicate is
 * dropped; an `openFrom` value that is not one of the speakers opens the
 * menu with no speaker highlighted (null). validate-house.py reports both.
 */
export function normaliseSoundMenu(raw) {
  if (!isObj(raw)) return null;
  if (!inDomain(raw.selection, 'input_text') || !inDomain(raw.toggleScript, 'script') ||
    !inDomain(raw.sound, 'input_select') || !inDomain(raw.catalogue, 'sensor')) return null;
  const seen = new Set();
  const speakers = [];
  (Array.isArray(raw.speakers) ? raw.speakers : []).forEach(s => {
    if (!isObj(s) || !inDomain(s.entity, 'media_player') || seen.has(s.entity)) return;
    seen.add(s.entity);
    const label = typeof s.label === 'string' && s.label.trim() ? s.label.trim() : s.entity.split('.')[1];
    speakers.push({ entity: s.entity, label });
  });
  if (!speakers.length) return null;
  const openFrom = new Map();
  Object.entries(isObj(raw.openFrom) ? raw.openFrom : {}).forEach(([itemId, eid]) => {
    if (!ITEM_ID_RE.test(itemId)) return;
    openFrom.set(itemId, typeof eid === 'string' && seen.has(eid) ? eid : null);
  });
  return {
    selection: raw.selection,
    toggleScript: raw.toggleScript,
    sound: raw.sound,
    catalogue: raw.catalogue,
    recent: inDomain(raw.recent, 'input_text') ? raw.recent : null,
    speakers,
    openFrom,
    spotify: isObj(raw.spotify) ? {
      configEntryId: typeof raw.spotify.configEntryId === 'string' && /^[A-Za-z0-9_-]+$/.test(raw.spotify.configEntryId) ? raw.spotify.configEntryId : null,
    } : null,
  };
}

/** Every entity the menu reads: the helpers, the catalogue and the speakers. */
export function soundMenuEntities(cfg) {
  if (!cfg) return [];
  return [cfg.selection, cfg.sound, cfg.catalogue, cfg.recent].filter(Boolean).concat(cfg.speakers.map(s => s.entity));
}

// ---------------------------------------------------------------------------
// Reading the raw states
// ---------------------------------------------------------------------------

const parseJson = text => { try { return JSON.parse(text); } catch (e) { return null; } };

/** The `selection` input_text -> the selected speakers' entity ids ([] when unreadable). */
export function parseSelection(raw) {
  const v = raw && typeof raw.state === 'string' ? parseJson(raw.state) : null;
  return Array.isArray(v) ? v.filter(e => typeof e === 'string' && e) : [];
}

/**
 * The `recent` input_text -> the recent sound ids, most recent first. An
 * entry is an [id, speakerCodes] pair; a legacy entry is a bare string (a
 * label written before the pair shape). Exactly the tablet template's read.
 */
export function parseRecentIds(raw) {
  const v = raw && typeof raw.state === 'string' ? parseJson(raw.state) : null;
  if (!Array.isArray(v)) return [];
  return v.map(e => (Array.isArray(e) ? e[0] : e)).filter(e => typeof e === 'string' && e);
}

/** The catalogue sensor -> its tiles, each { id, label, icon } (malformed ones dropped). */
export function catalogueTiles(raw) {
  const tiles = raw && raw.attributes && Array.isArray(raw.attributes.tiles) ? raw.attributes.tiles : [];
  return tiles.filter(t => isObj(t) && typeof t.id === 'string' && t.id && typeof t.label === 'string' && t.label)
    .map(t => ({ id: t.id, label: t.label, icon: typeof t.icon === 'string' ? t.icon : 'mdi:music-note' }));
}

/** The `sound` input_select -> the selected label ('None' when off), or null before it reports. */
export function currentSound(raw) {
  if (!raw || typeof raw.state !== 'string' || UNREAL.has(raw.state)) return null;
  return raw.state;
}

/** A sound is playing (selected) unless it is 'None' or unknown. */
export const soundActive = s => typeof s === 'string' && s !== SOUND_NONE;

/**
 * The SOUNDS order, ported verbatim from the tablet's Jinja: the catalogue
 * sorted by label (case-insensitively, as Jinja's `sort` is), then each
 * recent id in turn pulls forward the tile whose id -- or, for a legacy
 * entry, label -- matches it, once; everything else follows in A-Z order.
 */
export function orderSounds(tiles, recentIds) {
  const sorted = (tiles || []).map((t, i) => ({ t, i, k: String(t.label).toLowerCase() }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i)).map(x => x.t);
  const seen = new Set();
  const out = [];
  (recentIds || []).forEach(rid => {
    sorted.forEach(t => {
      if ((t.id === rid || t.label === rid) && !seen.has(t.id)) { out.push(t); seen.add(t.id); }
    });
  });
  sorted.forEach(t => { if (!seen.has(t.id)) out.push(t); });
  return out;
}

/** A list -> pages of `size` (no cap on the number of pages). */
export function pageSounds(list, size) {
  const n = size || PAGE_SIZE;
  const pages = [];
  for (let i = 0; i < (list || []).length; i += n) pages.push(list.slice(i, i + n));
  return pages;
}

/** The speakers in display order: the tapped one first, then as configured. */
export function orderedSpeakers(cfg, tapped) {
  const list = cfg ? cfg.speakers.slice() : [];
  const i = list.findIndex(s => s.entity === tapped);
  if (i > 0) list.unshift(list.splice(i, 1)[0]);
  return list;
}

/** PLAY ON rows: { entity, label, selected, tapped }. */
export function speakerRows(cfg, selection, tapped) {
  const sel = new Set(selection || []);
  return orderedSpeakers(cfg, tapped).map(s => ({ entity: s.entity, label: s.label, selected: sel.has(s.entity), tapped: s.entity === tapped }));
}

/**
 * A NOW PLAYING slide's subtitle, the tablet tile's rule: media_title, else
 * media_content_id, cut to 38 characters with an ellipsis; else the selected
 * sound; else 'Playing' (or the raw state).
 */
export function slideTitle(raw, sound) {
  const a = (raw && raw.attributes) || {};
  let title = String(a.media_title || a.media_content_id || '');
  if (title.length > TITLE_MAX) title = title.substr(0, TITLE_MAX - 1) + '…';
  if (!title && soundActive(sound)) title = sound;
  if (!title) title = raw && raw.state === 'playing' ? 'Playing' : String((raw && raw.state) || 'unavailable');
  return title;
}

/** A speaker's volume_level (0..1), or null when it reports none. */
export function volumeOf(raw) {
  const v = raw && raw.attributes ? raw.attributes.volume_level : null;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * NOW PLAYING: one slide per configured speaker whose state is 'playing',
 * the tapped speaker's first (so it is the initial slide).
 * Each: { entity, label, title, volume, volumeText, tapped }.
 */
export function nowPlaying(cfg, rawOf, sound, tapped) {
  return orderedSpeakers(cfg, tapped).filter(s => { const r = rawOf(s.entity); return !!r && r.state === 'playing'; }).map(s => {
    const r = rawOf(s.entity);
    const vol = volumeOf(r);
    return { entity: s.entity, label: s.label, title: slideTitle(r, sound), volume: vol,
      volumeText: vol == null ? '--' : Math.round(vol * 100) + '%', tapped: s.entity === tapped };
  });
}

/**
 * "Stop all" shows when a sound is selected OR any listed speaker is
 * playing -- a deliberate superset of the tablet's rule (sound only), so
 * audio started some other way can be stopped from here too.
 */
export function stopAllVisible(sound, slides) {
  return soundActive(sound) || (slides || []).length > 0;
}

// ---------------------------------------------------------------------------
// Commands -- { domain, service, data, target: { entity_id } }
// ---------------------------------------------------------------------------

const cmd = (domain, service, data, entity) => ({ domain, service, data: data || {}, target: { entity_id: entity } });

/** PLAY ON tap: run the toggle script for one speaker (script.turn_on, so it does not block). */
export function toggleSpeakerCommand(cfg, entity) {
  return cmd('script', 'turn_on', { variables: { entity_id: entity } }, cfg.toggleScript);
}

/** Select a sound (or 'None') on the sound helper. */
export function selectSoundCommand(cfg, option) {
  return cmd('input_select', 'select_option', { option }, cfg.sound);
}

/**
 * A SOUNDS tile tap -> the options to select, in order. A different sound
 * is one select. The sound that is ALREADY selected is re-triggered:
 * 'None', then the label again once retriggerReady() says the stop has
 * landed (see the header). A tap while the state is unknown is one select.
 * @returns {{ retrigger: boolean, first: string, then: string|null }}
 */
export function soundTapPlan(label, current) {
  if (soundActive(current) && current === label) return { retrigger: true, first: SOUND_NONE, then: label };
  return { retrigger: false, first: label, then: null };
}

/**
 * Has a 'None' we sent landed -- may the next step go out? Used by the
 * re-trigger (its second select) and by a Spotify play (its play_media).
 *
 *   'ready'  the sound helper reads 'None', no selected speaker is still
 *            playing, and RETRIGGER_GAP_MS has passed since the 'None' went
 *            out (the automation's stop run must have finished, or it drops
 *            the next trigger); or RETRIGGER_MAX_MS has passed and the helper
 *            DOES read 'None' (a speaker that never reports stopped)
 *   'abort'  RETRIGGER_MAX_MS has passed and the helper does NOT read 'None':
 *            the 'None' never landed, or someone has since picked another
 *            sound (the tablet, another app) -- going ahead would override
 *            them
 *   'wait'   otherwise
 */
export function stopLanded(since, now, sound, selection, rawOf) {
  const dt = now - since;
  if (dt >= RETRIGGER_MAX_MS) return sound === SOUND_NONE ? 'ready' : 'abort';
  if (dt < RETRIGGER_GAP_MS || sound !== SOUND_NONE) return 'wait';
  return (selection || []).some(e => { const r = rawOf(e); return !!r && r.state === 'playing'; }) ? 'wait' : 'ready';
}

/** The re-trigger's second select may go out (stopLanded says 'ready'). */
export function retriggerReady(since, now, sound, selection, rawOf) {
  return stopLanded(since, now, sound, selection, rawOf) === 'ready';
}

/**
 * Has a sound change landed? The sound helper reads the target AND, for a
 * sound, every selected speaker reports 'playing' -- for 'None', none does.
 */
export function soundSettled(target, sound, selection, rawOf) {
  if (sound !== target) return false;
  const playing = (selection || []).map(e => { const r = rawOf(e); return !!r && r.state === 'playing'; });
  return target === SOUND_NONE ? !playing.some(Boolean) : playing.length > 0 && playing.every(Boolean);
}

/**
 * The sound tiles' busy window: from a tap, at least BUSY_MIN_MS, then until
 * the change has settled or BUSY_MAX_MS has passed.
 * @param busy  { since } or null
 */
export function isBusy(busy, now, settled) {
  if (!busy) return false;
  const dt = now - busy.since;
  if (dt < BUSY_MIN_MS) return true;
  if (dt >= BUSY_MAX_MS) return false;
  return !settled;
}

/** A NOW PLAYING transport button -> its command, or null. */
export function transportCommand(entity, action, raw) {
  if (action === 'prev') return cmd('media_player', 'media_previous_track', {}, entity);
  if (action === 'next') return cmd('media_player', 'media_next_track', {}, entity);
  if (action === 'playPause') return cmd('media_player', 'media_play_pause', {}, entity);
  if (action === 'volDown' || action === 'volUp') {
    const v = volumeOf(raw);
    const base = v == null ? 0.25 : v;
    const next = action === 'volUp' ? Math.min(1, Math.round((base + VOLUME_STEP) * 100) / 100)
      : Math.max(0, Math.round((base - VOLUME_STEP) * 100) / 100);
    return cmd('media_player', 'volume_set', { volume_level: next }, entity);
  }
  return null;
}

/**
 * A slide's Stop: media_stop on THAT speaker. When it was the last one
 * playing and a sound is still selected, also select 'None', so the tablet
 * and the app agree that nothing is playing.
 */
export function slideStopCommands(cfg, entity, slides, sound) {
  const out = [cmd('media_player', 'media_stop', {}, entity)];
  const others = (slides || []).filter(s => s.entity !== entity);
  if (!others.length && soundActive(sound)) out.push(selectSoundCommand(cfg, SOUND_NONE));
  return out;
}

/**
 * "Stop all": select 'None' when a sound is selected (the automation stops
 * the selected speakers), PLUS media_stop on every playing listed speaker
 * the automation will not reach -- one outside the selection, or every
 * playing one when no sound is selected.
 */
export function stopAllCommands(cfg, sound, selection, slides) {
  const out = [];
  const active = soundActive(sound);
  if (active) out.push(selectSoundCommand(cfg, SOUND_NONE));
  const sel = new Set(active ? selection || [] : []);
  (slides || []).forEach(s => { if (!sel.has(s.entity)) out.push(cmd('media_player', 'media_stop', {}, s.entity)); });
  return out;
}

/** The selection after a toggle, the script's rule: add, or remove unless it is the last. */
export function toggledSelection(selection, entity) {
  const s = (selection || []).slice();
  const i = s.indexOf(entity);
  if (i === -1) s.push(entity);
  else if (s.length > 1) s.splice(i, 1);
  return s;
}

// ---------------------------------------------------------------------------
// Mock mode (no Home Assistant configured: the demo house)
// ---------------------------------------------------------------------------

/** The demo's sample catalogue, the tablet's shape. Nothing here is a real file. */
export const SAMPLE_SOUNDS = [
  { id: 'rain', label: 'Rain', icon: 'mdi:weather-rainy' },
  { id: 'heavy_rain', label: 'Heavy rain', icon: 'mdi:weather-pouring' },
  { id: 'thunderstorm', label: 'Thunderstorm', icon: 'mdi:weather-lightning-rainy' },
  { id: 'ocean', label: 'Ocean', icon: 'mdi:waves' },
  { id: 'beach', label: 'Beach', icon: 'mdi:beach' },
  { id: 'forest', label: 'Forest', icon: 'mdi:forest' },
  { id: 'pine_wind', label: 'Pine wind', icon: 'mdi:pine-tree' },
  { id: 'fireplace', label: 'Fireplace', icon: 'mdi:fire' },
  { id: 'fan', label: 'Fan', icon: 'mdi:fan' },
  { id: 'night', label: 'Night', icon: 'mdi:weather-night' },
  { id: 'waterfall', label: 'Waterfall', icon: 'mdi:waterfall' },
  { id: 'wind', label: 'Wind', icon: 'mdi:weather-windy' },
  { id: 'white_noise', label: 'White noise', icon: 'mdi:waveform' },
  { id: 'brown_noise', label: 'Brown noise', icon: 'mdi:volume-mute' },
  { id: 'sleep', label: 'Sleep', icon: 'mdi:power-sleep' },
  { id: 'stars', label: 'Stars', icon: 'mdi:star-four-points' },
  { id: 'lullaby', label: 'Lullaby', icon: 'mdi:baby-carriage' },
  { id: 'music_box', label: 'Music box', icon: 'mdi:music-note-eighth' },
];

/** The demo's starting state: Rain on the first speaker, which is selected. */
export function mockSoundStates(cfg) {
  const m = new Map();
  if (!cfg) return m;
  const first = cfg.speakers[0].entity;
  m.set(cfg.selection, { state: JSON.stringify([first]), attributes: {} });
  m.set(cfg.sound, { state: 'Rain', attributes: { options: [SOUND_NONE].concat(SAMPLE_SOUNDS.map(t => t.label)) } });
  m.set(cfg.catalogue, { state: String(SAMPLE_SOUNDS.length), attributes: { tiles: SAMPLE_SOUNDS.map(t => Object.assign({}, t)) } });
  if (cfg.recent) m.set(cfg.recent, { state: JSON.stringify([['rain', 'A'], ['fan', 'A'], ['ocean', 'A']]), attributes: {} });
  cfg.speakers.forEach((s, i) => m.set(s.entity, i === 0
    ? { state: 'playing', attributes: { media_title: 'Rain', volume_level: 0.25 } }
    : { state: 'idle', attributes: { volume_level: 0.3 } }));
  return m;
}

/**
 * Apply one command to the demo's sample state, the way Home Assistant and
 * its ambience automation would -- a NEW Map; nothing is ever sent.
 */
export function applyMockCommand(cfg, states, command) {
  const m = new Map(states);
  const eid = command.target.entity_id;
  const cur = m.get(eid) || { state: 'idle', attributes: {} };
  const set = (id, state, attrs) => { const p = m.get(id) || { attributes: {} }; m.set(id, { state, attributes: Object.assign({}, p.attributes, attrs || {}) }); };
  const selection = parseSelection(m.get(cfg.selection));
  if (command.domain === 'input_select' && eid === cfg.sound) {
    const opt = command.data.option;
    if (opt === cur.state) return m;          // no state change: HA fires nothing
    set(cfg.sound, opt);
    if (opt === SOUND_NONE) {
      selection.forEach(e => set(e, 'idle', { media_title: null }));
    } else {
      selection.forEach(e => set(e, 'playing', { media_title: opt, volume_level: 0.25 }));
      const tile = catalogueTiles(m.get(cfg.catalogue)).find(t => t.label === opt);
      if (cfg.recent && tile) {
        const prev = parseJson((m.get(cfg.recent) || {}).state) || [];
        const next = [[tile.id, 'A']].concat(prev.filter(e => (Array.isArray(e) ? e[0] : e) !== tile.id)).slice(0, 3);
        set(cfg.recent, JSON.stringify(next));
      }
    }
  } else if (command.domain === 'script' && eid === cfg.toggleScript) {
    set(cfg.selection, JSON.stringify(toggledSelection(selection, command.data.variables.entity_id)));
  } else if (command.domain === 'media_player') {
    if (command.service === 'media_stop') set(eid, 'idle', { media_title: null });
    else if (command.service === 'media_play_pause') set(eid, cur.state === 'playing' ? 'paused' : 'playing');
    else if (command.service === 'volume_set') set(eid, cur.state, { volume_level: command.data.volume_level });
  } else if (command.domain === 'music_assistant' && command.service === 'play_media') {
    const t = SAMPLE_SPOTIFY_TRACKS.find(x => x.uri === command.data.media_id);
    [].concat(eid).forEach(e => set(e, 'playing', { media_title: t ? t.name : command.data.media_id, media_content_id: command.data.media_id }));
  }
  return m;
}

// ---------------------------------------------------------------------------
// SPOTIFY (soundMenu.spotify): the picker's calls, results and the play
// ---------------------------------------------------------------------------
//
// Spotify is a Music Assistant provider, so everything goes through MA's
// services, which need the HA config entry of Music Assistant (config_entry_id
// -- NOT the provider instance id in a track's uri):
//
//   recents  music_assistant.get_library { media_type: track,
//            order_by: last_played_desc } -- Music Assistant's own play
//            history, local files included; kept to Spotify by the artwork
//            (i.scdn.co) or a spotify uri
//   search   music_assistant.search { name, media_type: [track] }
//   play     media_player.repeat_set off, music_assistant.play_media
//            { media_id: uri, media_type: track, enqueue: replace },
//            repeat_set off again -- all on exactly the selected speakers,
//            each sent only after the previous one has answered. The
//            ambience automation leaves its speakers on repeat ONE; off
//            before the play and once more after it, so the track does not
//            loop whatever order Music Assistant applies them in.
//
// BEFORE the play, a selected ambience sound is deselected ('None'): the
// automation stops the selected speakers, and the tablet and this menu stop
// showing the old sound as playing -- so a later tap on that sound starts it
// rather than doing nothing. The play waits for that stop to land
// (stopLanded); if the helper still reads another sound at the timeout, the
// play is abandoned with an error rather than fighting it.

export const SPOTIFY_GREEN = '#1DB954';
export const SPOTIFY_LIMIT = 25;
export const RECENTS_FETCH = 50;
export const SEARCH_DEBOUNCE_MS = 400;
export const SEARCH_MIN_CHARS = 2;
export const SPOTIFY_TIMEOUT_MS = 15000;
export const PLAY_TIMEOUT_MS = 20000;
export const NOTICE_MS = 4000;

const SPOTIFY_URI = /^spotify[a-z0-9_-]*:\/\//i;
const imageHost = url => { try { return new URL(String(url)).hostname; } catch (e) { return ''; } };

/** A Music Assistant item from Spotify: a spotify uri, or Spotify's artwork CDN. */
export function isSpotifyItem(item) {
  if (!isObj(item) || typeof item.uri !== 'string') return false;
  return SPOTIFY_URI.test(item.uri) || /(^|\.)scdn\.co$/i.test(imageHost(item.image));
}

/**
 * Music Assistant tracks -> picker rows { uri, title, artists, image }: Spotify
 * only, each uri once, at most `limit`. `image` is kept only as an https URL.
 */
export function spotifyTracks(items, limit) {
  const seen = new Set();
  const out = [];
  (Array.isArray(items) ? items : []).forEach(it => {
    if (out.length >= (limit || SPOTIFY_LIMIT) || !isSpotifyItem(it) || seen.has(it.uri)) return;
    seen.add(it.uri);
    const artists = (Array.isArray(it.artists) ? it.artists : []).map(a => (isObj(a) ? a.name : a)).filter(a => typeof a === 'string' && a).join(', ');
    const img = typeof it.image === 'string' && /^https:\/\//.test(it.image) ? it.image : null;
    out.push({ uri: it.uri, title: String(it.name || it.uri), artists, image: img });
  });
  return out;
}

/** The recents call: Music Assistant's last-played tracks. */
export function recentsCall(entryId) {
  return { domain: 'music_assistant', service: 'get_library',
    data: { config_entry_id: entryId, media_type: 'track', order_by: 'last_played_desc', limit: RECENTS_FETCH } };
}

/** The search call. */
export function searchCall(entryId, query) {
  return { domain: 'music_assistant', service: 'search',
    data: { config_entry_id: entryId, name: query, media_type: ['track'], limit: SPOTIFY_LIMIT } };
}

/** What the picker should show for a typed query: recents under SEARCH_MIN_CHARS, else that search. */
export function pickerWant(query) {
  const q = String(query || '').trim();
  return q.length >= SEARCH_MIN_CHARS ? { kind: 'search', query: q } : { kind: 'recents', query: '' };
}

/** config_entries/get's list -> Music Assistant's entry id (a loaded one first), or null. */
export function pickConfigEntry(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(e => isObj(e) && typeof e.entry_id === 'string' && (!e.domain || e.domain === 'music_assistant'));
  const loaded = list.find(e => e.state === 'loaded');
  return (loaded || list[0] || {}).entry_id || null;
}

/** The play, in order, on exactly `selection`: repeat off, play_media, repeat off. */
export function spotifyPlayCommands(selection, uri) {
  const target = { entity_id: (selection || []).slice() };
  const repeatOff = () => ({ domain: 'media_player', service: 'repeat_set', data: { repeat: 'off' }, target: { entity_id: target.entity_id.slice() } });
  return [
    repeatOff(),
    { domain: 'music_assistant', service: 'play_media', data: { media_id: uri, media_type: 'track', enqueue: 'replace' }, target: { entity_id: target.entity_id.slice() } },
    repeatOff(),
  ];
}

/** An error from a Spotify call -> the line the picker shows. */
export function spotifyErrorText(err) {
  const m = String((err && err.message) || err || 'unknown error');
  if (/did not answer/i.test(m)) return 'Music Assistant did not answer.';
  if (/not connected|disconnected/i.test(m)) return 'Home Assistant is not connected.';
  if (/not set up|entry not found/i.test(m)) return 'Music Assistant is not set up in Home Assistant (' + m + ').';
  if (/no playable item|mediano?tfound|login|credential|unauthori[sz]ed|auth/i.test(m)) {
    return 'Spotify could not play this. Music Assistant\'s Spotify sign-in may need redoing (Music Assistant: Settings, Providers, Spotify). (' + m + ')';
  }
  return 'Music Assistant: ' + m;
}

/**
 * The demo's Spotify fixtures, in Music Assistant's response shape. Generic
 * names, no artwork (rows show a placeholder), spotify--demo uris -- plus one
 * local file in the recents, which the Spotify filter must drop.
 */
export const SAMPLE_SPOTIFY_TRACKS = [
  ['Morning Light', 'Sample Artist'], ['Slow Tide', 'The Placeholders'], ['Quiet Hours', 'Demo Ensemble'],
  ['Paper Lanterns', 'Sample Artist'], ['Late Train', 'The Placeholders'], ['Glasshouse', 'Demo Ensemble'],
  ['Northern Window', 'Example Quartet'], ['Soft Static', 'Sample Artist, Demo Ensemble'], ['Lemon Grove', 'The Placeholders'],
  ['Harbour Lights', 'Example Quartet'], ['Kite Season', 'Demo Ensemble'], ['Sunday Rooms', 'Sample Artist'],
].map(([name, artists], i) => ({ media_type: 'track', uri: 'spotify--demo://track/demo_' + (i + 1), name, version: '', image: null, favorite: false,
  explicit: null, artists: artists.split(', ').map(a => ({ media_type: 'artist', name: a })) }));

/** The demo's response to a recents or a search call (no Home Assistant). */
export function mockSpotifyResponse(kind, query) {
  if (kind === 'search') {
    const q = String(query || '').toLowerCase();
    return { tracks: SAMPLE_SPOTIFY_TRACKS.filter(t => (t.name + ' ' + t.artists.map(a => a.name).join(' ')).toLowerCase().includes(q)),
      artists: [], albums: [], playlists: [], radio: [] };
  }
  const local = { media_type: 'track', uri: 'library://track/1', name: 'Rain', version: '', image: null, artists: [{ name: 'Relaxing sounds' }] };
  return { items: [local].concat(SAMPLE_SPOTIFY_TRACKS), limit: RECENTS_FETCH, offset: 0, order_by: 'last_played_desc', media_type: 'track' };
}

// ---------------------------------------------------------------------------
// The controller: the menu's state and every tap, DOM-free
// ---------------------------------------------------------------------------

/** conn: the client's status, or null with no client (the demo: mock). */
export function soundStatusKey(conn) {
  if (conn == null) return 'mock';
  if (conn === 'connected') return 'ok';
  if (conn === 'syncing') return 'connecting';
  return 'haOffline';
}

/**
 * The sound menu's state machine, with no DOM: src/sound-menu.js renders
 * model() and forwards each tap to tap(); a timer calls tick(). Kept here so
 * the busy window and the re-trigger are tested end to end against the fake
 * Home Assistant (scripts/test-sound-menu.mjs).
 *
 * @param d  { cfg (normaliseSoundMenu), getHa: () => client|null,
 *           sendScript (src/script-call.js), now: () => ms,
 *           onChange: () => void (an async result landed: repaint) }
 */
export function createSoundController(d) {
  const cfg = d.cfg;
  const now = d.now || (() => Date.now());
  const ha = () => (d.getHa ? d.getHa() : null);
  const mockMode = () => !ha();
  const writable = () => { const h = ha(); return !!h && h.status === 'connected'; };
  let mock = null;
  const mockStates = () => (mock || (mock = mockSoundStates(cfg)));
  const rawOf = eid => (mockMode() ? mockStates().get(eid) || null : (ha() && ha().getRawState ? ha().getRawState(eid) : null));
  let busy = null;      // { since, target }  the sound tiles' busy window
  let pending = null;   // { label, since }   a re-trigger waiting for its second select
  let optSel = null;    // { list, until }    PLAY ON, optimistic until the echo
  let tapped = null;    // the speaker the menu was opened from
  const sent = [];      // what went out (or was applied to the sample), for debug and tests
  // Spotify: the open picker, the play in progress, and the last notice.
  let picker = null;    // { query, queryAt, seq, shown: { kind, query }, status, items, error }
  let job = null;       // { uri, title, selection, since, phase: 'stopping' | 'starting' }
  let notice = null;    // { text, kind: 'ok' | 'error', until }
  let entryId = cfg.spotify ? cfg.spotify.configEntryId : null;
  let entryLookup = null;
  const changed = () => { if (d.onChange) { try { d.onChange(); } catch (e) { /* a repaint must not break the controller */ } } };

  function send(c) {
    if (mockMode()) { mock = applyMockCommand(cfg, mockStates(), c); sent.push(Object.assign({ mock: true }, c)); return true; }
    if (!writable()) return false;
    const ok = ha().callService(c.domain, c.service, c.data, c.target) === true;
    if (ok) sent.push(c);
    return ok;
  }
  const realSelection = () => parseSelection(rawOf(cfg.selection));
  function selection() {
    const real = realSelection();
    if (optSel && optSel.until > now() && JSON.stringify(optSel.list) !== JSON.stringify(real)) return optSel.list;
    optSel = null;
    return real;
  }

  function model() {
    const t = now();
    const statusKey = soundStatusKey(mockMode() ? null : ha().status);
    const live = statusKey === 'ok' || statusKey === 'mock';
    const sound = currentSound(rawOf(cfg.sound));
    const slides = nowPlaying(cfg, rawOf, sound, tapped);
    const tiles = orderSounds(catalogueTiles(rawOf(cfg.catalogue)), parseRecentIds(cfg.recent ? rawOf(cfg.recent) : null));
    if (busy && !pending && !isBusy(busy, t, soundSettled(busy.target, sound, realSelection(), rawOf))) busy = null;
    const rows = speakerRows(cfg, selection(), tapped);
    if (notice && notice.until <= t) notice = null;
    return {
      statusKey, live, sound, slides, rows,
      pages: pageSounds(cfg.spotify ? [{ id: '__spotify', label: 'Spotify', spotify: true }].concat(tiles) : tiles),
      stopAll: stopAllVisible(sound, slides),
      busy: busy ? { target: busy.target } : null,
      spotify: !!cfg.spotify,
      notice: notice ? { text: notice.text, kind: notice.kind } : null,
      picker: picker ? {
        query: picker.query, kind: picker.shown ? picker.shown.kind : 'recents', status: picker.status, error: picker.error,
        items: picker.items, playing: job ? { uri: job.uri, phase: job.phase } : null,
        on: rows.filter(r => r.selected).map(r => r.label),
      } : null,
    };
  }

  /**
   * Advance what waits on time: the re-trigger's second select (or its
   * abort), a Spotify play waiting on its 'None', and a debounced search.
   * Returns true when the re-trigger's second select went out.
   */
  function tick() {
    let fired = false;
    if (pending) {
      const r = stopLanded(pending.since, now(), currentSound(rawOf(cfg.sound)), realSelection(), rawOf);
      if (r === 'abort') { pending = null; busy = null; }
      else if (r === 'ready') {
        const label = pending.label;
        pending = null;
        busy = send(selectSoundCommand(cfg, label)) ? { since: now(), target: label } : null;
        fired = true;
      }
    }
    if (job && job.phase === 'stopping') {
      const r = stopLanded(job.since, now(), currentSound(rawOf(cfg.sound)), job.selection, rawOf);
      if (r === 'abort') { job = null; say('The ambience sound did not stop, so nothing was played.', 'error'); }
      else if (r === 'ready') startPlay();
    }
    if (picker) {
      const want = pickerWant(picker.query);
      const shown = picker.shown;
      const same = shown && shown.kind === want.kind && shown.query === want.query;
      if (!same && (want.kind === 'recents' || now() - picker.queryAt >= SEARCH_DEBOUNCE_MS)) fetchList(want.kind, want.query);
    }
    return fired;
  }

  function say(text, kind) { notice = { text, kind, until: now() + NOTICE_MS }; if (picker && kind === 'error') picker.error = text; changed(); }

  // ---- Spotify -------------------------------------------------------------
  function resolveEntry() {
    if (entryId) return Promise.resolve(entryId);
    if (!entryLookup) {
      entryLookup = ha().request({ type: 'config_entries/get', domain: 'music_assistant' }, SPOTIFY_TIMEOUT_MS).then(list => {
        const id = pickConfigEntry(list);
        if (!id) throw new Error('Music Assistant is not set up in Home Assistant');
        entryId = id;
        return id;
      });
      entryLookup.catch(() => { entryLookup = null; });   // a failed lookup is retried next time
    }
    return entryLookup;
  }

  function fetchList(kind, query) {
    if (!picker) return;
    const seq = ++picker.seq;
    picker.shown = { kind, query };
    picker.status = 'loading';
    picker.error = null;
    const respKey = kind === 'search' ? 'tracks' : 'items';
    const p = mockMode() ? Promise.resolve(mockSpotifyResponse(kind, query))
      : !writable() ? Promise.reject(new Error('Home Assistant is not connected'))
        : resolveEntry().then(id => {
          const c = kind === 'search' ? searchCall(id, query) : recentsCall(id);
          sent.push(Object.assign({ read: true }, c));
          return ha().callServiceForResponse(c.domain, c.service, c.data, undefined, SPOTIFY_TIMEOUT_MS);
        });
    p.then(resp => {
      if (!picker || picker.seq !== seq) return;   // a newer list was asked for: drop this one
      picker.items = spotifyTracks(resp && resp[respKey], SPOTIFY_LIMIT);
      picker.status = 'ok';
      changed();
    }, err => {
      if (!picker || picker.seq !== seq) return;
      picker.items = [];
      picker.status = 'error';
      picker.error = spotifyErrorText(err);
      changed();
    });
  }

  /** Open the picker: recents, at once. */
  function openPicker() {
    if (!cfg.spotify || !model().live) return false;
    picker = { query: '', queryAt: now(), seq: 0, shown: null, status: 'idle', items: [], error: null };
    fetchList('recents', '');
    return true;
  }

  /** A keystroke in the search box: the search follows SEARCH_DEBOUNCE_MS later (tick). */
  function setQuery(q) {
    if (!picker) return;
    picker.query = String(q || '');
    picker.queryAt = now();
  }

  function startPlay() {
    const j = job;
    j.phase = 'starting';
    // The 'None' has landed: end its busy window now -- it would otherwise
    // wait for the speakers to stop, and they are about to play Spotify.
    busy = null;
    const cmds = spotifyPlayCommands(j.selection, j.uri);
    const done = () => {
      if (job !== j) return;
      job = null;
      picker = null;
      say('Playing on ' + j.selection.length + ' speaker' + (j.selection.length === 1 ? '' : 's'), 'ok');
    };
    if (mockMode()) { cmds.forEach(send); done(); return; }
    cmds.reduce((prev, c) => prev.then(() => {
      if (!writable()) throw new Error('Home Assistant is not connected');
      sent.push(c);
      return ha().request({ type: 'call_service', domain: c.domain, service: c.service, service_data: c.data, target: c.target }, PLAY_TIMEOUT_MS);
    }), Promise.resolve()).then(done, err => {
      if (job !== j) return;
      job = null;
      say(spotifyErrorText(err), 'error');
    });
  }

  /**
   * A picker row: play `uri` on every selected speaker. A selected ambience
   * sound is deselected first and the play waits for that stop (tick).
   */
  function playTrack(uri) {
    const m = model();
    if (!m.live || !cfg.spotify || job || pending) return false;
    const sel = realSelection();
    if (!sel.length) { say('Select a speaker first.', 'error'); return false; }
    const item = picker && picker.items.find(x => x.uri === uri);
    job = { uri, title: item ? item.title : uri, selection: sel, since: now(), phase: 'stopping' };
    if (soundActive(m.sound)) {
      if (!send(selectSoundCommand(cfg, SOUND_NONE))) { job = null; return false; }
      busy = { since: now(), target: SOUND_NONE };
    } else {
      startPlay();
    }
    changed();
    return true;
  }

  /**
   * One tap. action: 'spk' | 'snd' | 'stopAll' | 'stop' | 'volDown' | 'volUp'
   * | 'prev' | 'next' | 'playPause'; arg: the speaker entity, or a sound's
   * label for 'snd'. Returns true when something was sent.
   */
  function tap(action, arg) {
    const m = model();
    if (!m.live) return false;
    if (action === 'spk') {
      if (!cfg.speakers.some(s => s.entity === arg)) return false;
      if (mockMode()) return send(toggleSpeakerCommand(cfg, arg));
      const cur = selection();
      if (!d.sendScript(ha(), { entity: cfg.toggleScript, variables: { entity_id: arg } }, writable)) return false;
      sent.push(toggleSpeakerCommand(cfg, arg));
      optSel = { list: toggledSelection(cur, arg), until: now() + OPTIMISTIC_MS };
      return true;
    }
    if (action === 'snd') {
      if (m.busy || pending || job) return false;
      const plan = soundTapPlan(arg, m.sound);
      if (!send(selectSoundCommand(cfg, plan.first))) return false;
      busy = { since: now(), target: plan.then || plan.first };
      if (plan.retrigger) pending = { label: plan.then, since: now() };
      return true;
    }
    // Only ever a configured speaker: a slide's buttons carry its entity id.
    if (action !== 'stopAll' && !cfg.speakers.some(s => s.entity === arg)) return false;
    if (action === 'stopAll' || action === 'stop') {
      const cmds = action === 'stopAll' ? stopAllCommands(cfg, m.sound, realSelection(), m.slides)
        : slideStopCommands(cfg, arg, m.slides, m.sound);
      let any = false;
      cmds.forEach(c => { if (send(c)) any = true; });
      if (cmds.some(c => c.domain === 'input_select')) { busy = { since: now(), target: SOUND_NONE }; pending = null; }
      return any;
    }
    const c = transportCommand(arg, action, rawOf(arg));
    return c ? send(c) : false;
  }

  return {
    cfg, model, tap, tick, rawOf,
    openPicker, setQuery, playTrack,
    closePicker() { picker = null; },
    pickerOpen: () => !!picker,
    setTapped(e) { tapped = e || null; },
    pendingRetrigger: () => !!pending,
    playing: () => (job ? { uri: job.uri, phase: job.phase } : null),
    sent: () => sent.slice(),
  };
}
