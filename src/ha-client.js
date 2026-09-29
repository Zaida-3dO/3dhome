/**
 * Home Assistant WebSocket Client for 3dHome
 * Syncs 3D scene light state with real HA light entities.
 *
 * Usage:
 *   const ha = HAClient.create({ url, token, rooms, sensors, ... });
 *   ha.onStateChange((roomId, group, state) => { ... });
 *   ha.onPresenceChange((roomId, occupied) => { ... });
 *   ha.onDoorChange((doorId, open) => { ... });
 *   ha.onCurtainChange((curtainId, { pct, moving }) => { ... });
 *   ha.onCorniceChange((curtainId, { on, bri, color }) => { ... });
 *   ha.onStatusChange(status => { ... });
 *   ha.connect();
 */

import { colorFromAttributes, DEFAULT_ACCENT_COLOR } from './light-color.js';
import { normaliseVacuumBindings, parseVacuum, vacuumCommand, vacuumSegmentCommand } from './vacuum-control.js';
import { normalisePlantBindings, plantEntities, parsePlant } from './plant-status.js';
import { normaliseItemBindings, itemBindingEntities, itemWatchedAttributes } from './item-cards.js';

/**
 * Slider value -> a `cover.set_cover_position` call, fanned out to every
 * motor bound to a curtain. Pure and framework-free on purpose: the sidebar
 * slider is the only caller today, but the mapping (clamp/round the position,
 * turn one or several bound entity ids into one target) is exactly the kind
 * of thing that is easy to get subtly wrong inline in a DOM handler and hard
 * to unit-test there. `entities` is the `sensors.curtains[<curtainId>]` array
 * from rooms.json -- it may be empty/missing (curtain not bound to any real
 * cover) or hold several ids (multi-motor track), same shape callService()
 * already expects for its `target.entity_id`.
 *
 * Returns null when there is nothing to send: no bound entities, OR pct is
 * not a finite number. The latter matters because these numbers drive a
 * physical motor -- `+pct || 0` would silently turn NaN/undefined/a string
 * into position 0 (fully CLOSE), which is the one failure mode with no safe
 * default. No current caller can produce a non-numeric pct (the slider's
 * `+e.target.value` always yields a number for a range input), but the
 * fail-safe is "send nothing" regardless of whether today's call sites can
 * reach it.
 */
function coverPositionCommand(pct, entities) {
  const ids = entityList(entities);
  if (!ids.length) return null;
  const n = finiteOrNull(pct);
  if (n === null) return null;
  const position = Math.max(0, Math.min(100, Math.round(n)));
  return {
    domain: 'cover',
    service: 'set_cover_position',
    data: { position },
    target: { entity_id: ids.length === 1 ? ids[0] : ids.slice() }
  };
}

/** Bound entity ids as a clean array: one id, several, or none. */
function entityList(entities) {
  return Array.isArray(entities) ? entities.filter(Boolean) : (entities ? [entities] : []);
}

/**
 * A user-supplied number, or null when it is not one. Stricter than `+v`
 * on purpose: `+null`, `+''` and `+false` are all 0, and 0 is a real
 * command (curtain fully CLOSED). Only a finite number, or a non-blank
 * numeric string (what a range input's `.value` holds), counts.
 */
function finiteOrNull(v) {
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = +v;
  else return null;
  return isFinite(n) ? n : null;
}

/**
 * Curtain Open / Close button -> `cover.open_cover` / `cover.close_cover`,
 * fanned out to every bound motor exactly like coverPositionCommand. Null
 * for anything other than 'open'|'close', or when nothing is bound.
 */
function coverOpenCloseCommand(action, entities) {
  const service = action === 'open' ? 'open_cover' : action === 'close' ? 'close_cover' : null;
  if (!service) return null;
  const ids = entityList(entities);
  if (!ids.length) return null;
  return {
    domain: 'cover',
    service,
    data: {},
    target: { entity_id: ids.length === 1 ? ids[0] : ids.slice() }
  };
}

// Home Assistant's own climate defaults, used only when an entity does not
// publish its limits. target_temp_step is commonly absent on a room
// thermostat; 0.5 is what the brief (and most TRVs) use.
const CLIMATE_DEFAULT_MIN = 7;
const CLIMATE_DEFAULT_MAX = 35;
const CLIMATE_DEFAULT_STEP = 0.5;

/**
 * One climate entity's HA state -> the sidebar's reading:
 *   { available, off, current, target, min, max, step }
 * `off` is true for hvac state 'off' AND for a null/missing target
 * temperature (a thermostat that is off often reports `temperature: null`)
 * -- the row then shows "off" and its slider is disabled, so no command can
 * ever be derived from a missing target. `target` is null whenever `off`.
 * Limits come from min_temp / max_temp / target_temp_step, falling back to
 * HA's defaults when absent or nonsensical (min > max, step <= 0).
 */
function parseClimate(haState) {
  const st = haState ? haState.state : undefined;
  const available = typeof st === 'string' && st !== 'unavailable' && st !== 'unknown';
  const a = (haState && haState.attributes) || {};
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
  let min = num(a.min_temp), max = num(a.max_temp);
  if (min === null) min = CLIMATE_DEFAULT_MIN;
  if (max === null) max = CLIMATE_DEFAULT_MAX;
  if (min > max) { min = CLIMATE_DEFAULT_MIN; max = CLIMATE_DEFAULT_MAX; }
  let step = num(a.target_temp_step);
  if (step === null || step <= 0) step = CLIMATE_DEFAULT_STEP;
  const rawTarget = num(a.temperature);
  const off = st === 'off' || rawTarget === null;
  return {
    available,
    off,
    current: num(a.current_temperature),
    target: off ? null : rawTarget,
    min,
    max,
    step
  };
}

/**
 * Temperature slider value -> `climate.set_temperature`. Rounds to the
 * entity's step, clamps into [min, max], and strips float noise (21.499999
 * -> 21.5). Returns null -- send nothing -- when the value is not a number,
 * when no entity is bound, or when the reading says the entity cannot take
 * a target right now (no reading, unavailable, or off / null target). The
 * last guard duplicates the disabled slider on purpose: a thermostat is a
 * physical device, and "the DOM was disabled" is not a safety argument.
 */
function climateTargetCommand(value, entityId, reading) {
  if (typeof entityId !== 'string' || !entityId) return null;
  if (!reading || !reading.available || reading.off) return null;
  const n = finiteOrNull(value);
  if (n === null) return null;
  const step = reading.step > 0 ? reading.step : CLIMATE_DEFAULT_STEP;
  let t = Math.round(n / step) * step;
  t = Math.max(reading.min, Math.min(reading.max, t));
  const decimals = Math.min(3, (String(step).split('.')[1] || '').length);
  t = +t.toFixed(decimals);
  return {
    domain: 'climate',
    service: 'set_temperature',
    data: { temperature: t },
    target: { entity_id: entityId }
  };
}

/**
 * Several binary sensors on one target -> 'on' | 'off' | 'unavailable'.
 * `states` are raw HA state strings, with undefined for a sensor that has
 * never reported. ANY 'on' wins (a room with three zone sensors is occupied
 * when any one of them is); otherwise any sensor that is reporting a real
 * state makes it 'off'; only when EVERY sensor is unavailable, unknown or
 * silent is the target 'unavailable'. Used for the sidebar's motion tag and
 * door status text.
 */
function reduceBinarySensorStates(states) {
  const list = Array.isArray(states) ? states : [];
  if (list.some(s => s === 'on')) return 'on';
  if (list.some(s => typeof s === 'string' && s !== 'unavailable' && s !== 'unknown')) return 'off';
  return 'unavailable';
}

export const HAClient = (() => {

  function create(opts) {
    const {
      token,
      rooms,
      sensors = null,
      wsReconnectMs = 5000
      // pollIntervalMs is still accepted (config files carry it) and ignored:
      // there is no REST polling any more. See "Transport" below.
    } = opts;
    // Support url array or single string + optional fallbackUrl
    const urls = Array.isArray(opts.url)
      ? opts.url
      : [opts.url, opts.fallbackUrl].filter(Boolean);
    let urlIndex = 0;
    let url = urls[urlIndex];

    // ---- Transport: the WebSocket API, and nothing else ----
    // Every read and every command goes over /api/websocket. The first
    // snapshot is the socket's own `get_states` (sent on auth_ok, below);
    // live changes are its `state_changed` subscription; commands are
    // `call_service` on the same socket.
    //
    // There is deliberately NO REST (fetch) path. This app is served from its
    // own origin, so any fetch to Home Assistant is cross-origin, and HA's REST
    // API carries a Bearer header that forces a CORS preflight. Unless HA's
    // `http: cors_allowed_origins` names this app's origin, that preflight
    // fails -- which is exactly what the console showed on every load: a
    // redundant REST `GET /api/states` snapshot, blocked by CORS, while the
    // WebSocket (which has no preflight) authenticated fine and delivered the
    // same states moments later. The REST polling and REST service-call
    // fallbacks could only ever have worked with that same CORS change, and
    // the snapshot also held up the house load while it waited.
    // scripts/test-ha-client-transport.mjs pins this: no fetch, ever.
    let ws = null;
    // True between auth_ok and the socket closing. An open socket is not
    // enough: HA rejects anything sent before auth_ok.
    let authed = false;
    let wsId = 1;
    let status = 'disconnected';
    let reconnectTimer = null;

    const stateCallbacks = [];
    const statusCallbacks = [];
    const presenceCallbacks = [];
    const doorCallbacks = [];
    const curtainCallbacks = [];
    const corniceCallbacks = [];
    const curtainAvailabilityCallbacks = [];

    // Reverse index: entityId -> { roomId, group }
    const entityIndex = new Map();
    Object.entries(rooms).forEach(([roomId, groups]) => {
      Object.entries(groups).forEach(([group, entities]) => {
        entities.forEach(eid => entityIndex.set(eid, { roomId, group }));
      });
    });

    // ---- Non-light sensors (presence, door contacts) ----
    //
    // A SECOND reverse index, deliberately separate from entityIndex: its
    // values are { roomId, group } and a door is not room-scoped, so a door
    // sensor has nowhere to live in that shape. Keeping them apart also keeps
    // a sensor entity out of the light path entirely -- it never reaches
    // normalizeState (which would invent a `bri` for a binary_sensor) and it
    // never reaches the first-entity-only filter in processStateUpdate.
    //
    // sensorIndex: entityId -> { kind: 'presence'|'door', targetId }
    // sensorGroups: kind -> targetId -> [entityId], so several entities on one
    // target can be OR-ed (any one 'on' wins).
    const sensorIndex = new Map();
    const sensorGroups = { presence: {}, door: {} };
    // Last RESOLVED boolean per target. This is what makes the sensor path
    // safe for an on-demand renderer: HA re-sends state_changed on
    // attribute-only updates (a battery level every 30s is the usual case),
    // and forwarding those would call requestRender() forever and silently
    // destroy the scene's zero-frame idle. We compare the resolved boolean and
    // drop the update when it has not actually changed.
    const sensorState = { presence: new Map(), door: new Map() };
    // Raw per-entity on/off, the input to the OR. Kept separate from
    // sensorState because with two entities on one door we must remember both
    // to know whether the OR has flipped.
    const sensorEntityOn = new Map();
    // The sidebar's STATUS for the same targets ('on'|'off'|'unavailable'),
    // tracked alongside the boolean above rather than replacing it: the
    // boolean path deliberately folds 'unavailable' into off (a dropped
    // sensor must not leave footsteps walking or a door hanging open), while
    // the status row has to say "unavailable" out loud. Raw per-entity state
    // string in, resolved status per target out, notify on a real change.
    const sensorEntityRaw = new Map();
    const sensorStatus = { presence: new Map(), door: new Map() };
    const sensorStatusCallbacks = [];

    // ---- Climate (one entity per room, sidebar temperature row) ----
    // climateIndex: entityId -> [roomId] (an entity may serve two rooms).
    // climateResolved: roomId -> { reading, key } last dispatched.
    const climateIndex = new Map();
    const climateByRoom = new Map();
    const climateResolved = new Map();
    const climateCallbacks = [];
    if (sensors && sensors.climate && typeof sensors.climate === 'object') {
      Object.entries(sensors.climate).forEach(([roomId, eid]) => {
        if (typeof eid !== 'string' || !eid) return;
        climateByRoom.set(roomId, eid);
        (climateIndex.get(eid) || climateIndex.set(eid, []).get(eid)).push(roomId);
      });
    }

    // ---- Robot vacuums (sensors.vacuums, keyed by furniture item id) ----
    // vacuumIndex: entityId -> [itemId] for the vacuum AND its battery
    // sensor (a reading needs both). vacuumState: entityId -> last raw
    // state. vacuumResolved: itemId -> { reading, key } last dispatched.
    const vacuumBindings = normaliseVacuumBindings(sensors && sensors.vacuums);
    const vacuumIndex = new Map();
    const vacuumState = new Map();
    const vacuumResolved = new Map();
    const vacuumCallbacks = [];
    vacuumBindings.forEach(b => {
      [b.entity, b.battery].filter(Boolean).forEach(eid =>
        (vacuumIndex.get(eid) || vacuumIndex.set(eid, []).get(eid)).push(b.itemId));
    });

    // ---- Plants (sensors.plants, keyed by furniture item id) ----
    // READ-ONLY: no plant path ever sends. plantIndex: entityId -> [itemId]
    // for every entity a plant reads (moisture, battery, status helper,
    // temperature, watering). plantState: entityId -> last raw state.
    // plantResolved: itemId -> { reading, key } last dispatched.
    const plantBindings = normalisePlantBindings(sensors && sensors.plants);
    const plantIndex = new Map();
    const plantState = new Map();
    const plantResolved = new Map();
    const plantCallbacks = [];
    plantBindings.forEach(b => {
      plantEntities(b).forEach(eid =>
        (plantIndex.get(eid) || plantIndex.set(eid, []).get(eid)).push(b.itemId));
    });

    if (sensors) {
      const indexKind = (kind, map) => {
        Object.entries(map || {}).forEach(([targetId, entities]) => {
          if (!Array.isArray(entities) || !entities.length) return;
          sensorGroups[kind][targetId] = entities.slice();
          entities.forEach(eid => sensorIndex.set(eid, { kind, targetId }));
        });
      };
      indexKind('presence', sensors.presence);
      indexKind('door', sensors.doors);
    }

    // ---- Curtains (cover entities) and their cornice lights ----
    //
    // A THIRD index, because neither of the others fits: a cover's reading is
    // a position (0..100) plus a motion, not a boolean, and a cornice light is
    // keyed by CURTAIN id rather than by room/channel. Keeping the cornice
    // light out of `rooms` is also what stops it being double-driven: in a
    // real house the cornice entity is usually a member of the room's
    // ambience group, which the room's 'ambient' channel already follows.
    //
    // fittingIndex: entityId -> { kind: 'curtain'|'cornice', targetId }
    // fittingGroups[kind][targetId] -> [entityId]
    // fittingEntity: entityId -> last parsed reading (per entity)
    // fittingResolved[kind]: targetId -> last dispatched value, as a JSON key
    const fittingIndex = new Map();
    const fittingGroups = { curtain: {}, cornice: {} };
    const fittingEntity = new Map();
    const fittingResolved = { curtain: new Map(), cornice: new Map() };
    // Curtain availability, tracked SEPARATELY from fittingEntity/parseCover:
    // parseCover deliberately returns null (no event, keep the last reading)
    // for 'unavailable'/'unknown', which is exactly right for position but
    // wrong for a slider's enabled state -- the sidebar needs to know a motor
    // has dropped off even though its last-known position is being held.
    // curtainEntityAvailable: entityId -> bool, raw per-entity input to the OR.
    // curtainAvailable: targetId -> bool, last resolved (any motor down ->
    // whole curtain unavailable, since one dead motor on a multi-motor track
    // means the slider can no longer promise to move the whole curtain).
    const curtainEntityAvailable = new Map();
    const curtainAvailable = new Map();
    if (sensors) {
      const indexFitting = (kind, map) => {
        Object.entries(map || {}).forEach(([targetId, entities]) => {
          if (!Array.isArray(entities) || !entities.length) return;
          fittingGroups[kind][targetId] = entities.slice();
          entities.forEach(eid => fittingIndex.set(eid, { kind, targetId }));
        });
      };
      indexFitting('curtain', sensors.curtains);
      indexFitting('cornice', sensors.corniceLights);
    }

    /**
     * One cover entity's state -> { pct, moving } or null when it has no
     * usable reading ('unavailable'/'unknown'), in which case the curtain
     * keeps whatever it last showed rather than snapping somewhere invented.
     * `current_position` is the Home Assistant convention: 0 closed, 100 open.
     * A cover with no position support reports only 'open'/'closed'.
     */
    function parseCover(haState) {
      const st = haState.state;
      const attrs = haState.attributes || {};
      let pct = attrs.current_position;
      if (typeof pct !== 'number' || !isFinite(pct)) {
        if (st === 'open') pct = 100;
        else if (st === 'closed') pct = 0;
        else if (st === 'opening' || st === 'closing') pct = null;
        else return null;
      }
      const moving = (st === 'opening' || st === 'closing') ? st : null;
      if (pct == null) pct = moving === 'opening' ? 0 : 100;   // start of travel
      return { pct: Math.max(0, Math.min(100, Math.round(pct))), moving };
    }

    /** One light entity's state -> { on, bri, color|null }. */
    function parseCorniceLight(haState) {
      const on = haState.state === 'on';
      const attrs = haState.attributes || {};
      const bri = on ? (attrs.brightness != null ? Math.round(attrs.brightness / 2.55) : 100) : 0;
      let color = null;
      if (Array.isArray(attrs.rgb_color)) {
        color = '#' + attrs.rgb_color.map(c => (c | 0).toString(16).padStart(2, '0')).join('');
      }
      return { on, bri, color };
    }

    function resolveFitting(kind, targetId) {
      const readings = (fittingGroups[kind][targetId] || [])
        .map(eid => fittingEntity.get(eid)).filter(Boolean);
      if (!readings.length) return null;
      if (kind === 'curtain') {
        // Several motors on one curtain: average their positions; any one
        // moving means the curtain is moving (opening wins a tie).
        const pct = Math.round(readings.reduce((a, r) => a + r.pct, 0) / readings.length);
        const moving = readings.some(r => r.moving === 'opening') ? 'opening'
          : readings.some(r => r.moving === 'closing') ? 'closing' : null;
        return { pct, moving };
      }
      // Cornice: OR the on state; brightness is the brightest; colour from the
      // first entity that is on and reports one.
      const lit = readings.filter(r => r.on);
      return {
        on: lit.length > 0,
        bri: lit.length ? Math.max(...lit.map(r => r.bri)) : 0,
        color: (lit.find(r => r.color) || {}).color || null
      };
    }

    /**
     * Fold one cover/cornice entity into its curtain's resolved value and
     * notify ONLY when that value actually changed -- same reasoning as the
     * sensor path: an attribute-only republish must not become a render.
     * Returns true if the curtain/cornice VALUE callback fired (pre-existing
     * contract, depended on by callers that request a render on a truthy
     * result). Availability is a SEPARATE signal on its own callback list --
     * see maybeUpdateCurtainAvailability -- and never changes this return
     * value, so an availability-only flip (no position/cornice change) still
     * correctly reports false here.
     */
    function processFittingUpdate(entityId, haState) {
      const mapping = fittingIndex.get(entityId);
      if (!mapping) return false;
      const { kind, targetId } = mapping;

      if (kind === 'curtain') maybeUpdateCurtainAvailability(entityId, targetId, haState);

      const reading = kind === 'curtain' ? parseCover(haState) : parseCorniceLight(haState);
      if (!reading) return false;
      fittingEntity.set(entityId, reading);
      const resolved = resolveFitting(kind, targetId);
      if (!resolved) return false;
      const key = JSON.stringify(resolved);
      if (fittingResolved[kind].get(targetId) === key) return false;
      fittingResolved[kind].set(targetId, key);
      markFired(kind + ':' + targetId);
      (kind === 'curtain' ? curtainCallbacks : corniceCallbacks).forEach(cb => {
        try { cb(targetId, resolved); } catch (e) { console.warn('HAClient fittingCb:', e); }
      });
      return true;
    }

    /**
     * Curtain availability, independent of the position path above: a
     * slider must disable the moment its motor drops off even though
     * parseCover() is (correctly) holding the last known position rather
     * than firing a change. ANY bound motor unavailable/unknown resolves the
     * WHOLE curtain unavailable -- a multi-motor track cannot honour a
     * position command if only some of its motors can hear it. A motor that
     * has never reported AT ALL counts the same as unavailable, not as
     * available-by-default: curtainEntityAvailable.get(eid) is undefined
     * until a first real reading arrives, and `every(... !== false)` would
     * treat that undefined as passing -- exactly the gap a code review found
     * (round 1), where a bound-but-silent motor left the curtain enabled on
     * the other motor's reading alone, with commands still fanning out to the
     * one entity nobody has ever heard from. `=== true` closes that: only an
     * entity that has explicitly reported available counts. Notifies only on
     * an actual flip, same discipline as every other fitting/sensor path.
     */
    function maybeUpdateCurtainAvailability(entityId, targetId, haState) {
      const available = haState.state !== 'unavailable' && haState.state !== 'unknown';
      if (curtainEntityAvailable.get(entityId) === available) return;
      curtainEntityAvailable.set(entityId, available);
      const group = fittingGroups.curtain[targetId] || [];
      const resolvedAvailable = group.every(eid => curtainEntityAvailable.get(eid) === true);
      if (curtainAvailable.get(targetId) === resolvedAvailable) return;
      curtainAvailable.set(targetId, resolvedAvailable);
      markFired('available:' + targetId);
      curtainAvailabilityCallbacks.forEach(cb => {
        try { cb(targetId, resolvedAvailable); } catch (e) { console.warn('HAClient curtainAvailabilityCb:', e); }
      });
    }

    function sensorCallbacksFor(kind) {
      return kind === 'presence' ? presenceCallbacks : doorCallbacks;
    }

    /**
     * Fold one entity's raw state into its target's OR-ed boolean, and notify
     * ONLY when that boolean actually changed.
     *
     * Returns true if a change was dispatched -- used by the initial sync so
     * it can tell "already correct" from "just changed".
     */
    function processSensorUpdate(entityId, haState) {
      const mapping = sensorIndex.get(entityId);
      if (!mapping) return false;
      const { kind, targetId } = mapping;

      // Status first, and independently of the boolean early-return below:
      // off -> unavailable does not change `on`, but it must change the row.
      maybeUpdateSensorStatus(entityId, kind, targetId, haState.state);

      // HA's convention for both an occupancy/motion sensor and a door/opening
      // contact is the same: 'on' means detected/open. 'unavailable' and
      // 'unknown' are NOT 'on', so a dropped sensor reads as empty/closed
      // rather than sticking at its last value.
      const on = haState.state === 'on';
      if (sensorEntityOn.get(entityId) === on) return false;
      sensorEntityOn.set(entityId, on);

      // OR across every entity bound to this target: any one 'on' wins, which
      // is how a room with two motion sensors should behave.
      const group = sensorGroups[kind][targetId] || [];
      const resolved = group.some(eid => sensorEntityOn.get(eid) === true);

      if (sensorState[kind].get(targetId) === resolved) return false;
      sensorState[kind].set(targetId, resolved);
      markFired(kind + ':' + targetId);

      sensorCallbacksFor(kind).forEach(cb => {
        try { cb(targetId, resolved); } catch (e) { console.warn('HAClient sensorCb:', e); }
      });
      return true;
    }

    function maybeUpdateSensorStatus(entityId, kind, targetId, rawState) {
      const raw = typeof rawState === 'string' ? rawState : undefined;
      if (sensorEntityRaw.has(entityId) && sensorEntityRaw.get(entityId) === raw) return;
      sensorEntityRaw.set(entityId, raw);
      const group = sensorGroups[kind][targetId] || [];
      const status = reduceBinarySensorStates(group.map(eid => sensorEntityRaw.get(eid)));
      if (sensorStatus[kind].get(targetId) === status) return;
      sensorStatus[kind].set(targetId, status);
      markFired('status:' + kind + ':' + targetId);
      sensorStatusCallbacks.forEach(cb => {
        try { cb(kind, targetId, status); } catch (e) { console.warn('HAClient sensorStatusCb:', e); }
      });
    }

    // Last raw { state, attributes } of every bound light / climate entity.
    // Read-only side cache for the tap popovers (src/tap-popovers.js), which
    // need what the folded readings deliberately drop: a light's
    // 'unavailable', and a thermostat's hvac_action (heating vs idle -- kept
    // OUT of parseClimate so its flapping never repaints the sidebar row).
    // Fires nothing; recording here changes no existing behaviour.
    const rawStates = new Map();
    // ...and of every entity a furniture item's tap card reads (rooms.json
    // sensors.items, src/item-cards.js): its media players, lights and
    // readings are shown straight from the raw state, so recording them here
    // is all the fold they need. The card repaints on its own 1 s tick.
    // Curtain covers and cornice lights (fittingIndex) too: the curtains
    // card's cornice-light row needs the light's own 'unavailable'.
    const itemBindingsNorm = normaliseItemBindings(sensors && sensors.items);
    const itemEntityIds = itemBindingEntities(itemBindingsNorm);
    // entity -> the attributes a binding decides on (a TV's art condition
    // reads e.g. a remote's current_activity): a change there fires too.
    const itemWatched = itemWatchedAttributes(itemBindingsNorm);
    // sun.sun -> cb({ azimuth, elevation }), degrees. Every HA install has
    // the entity; the scene points its sun from it. Fired only when either
    // value actually changed.
    const sunCallbacks = [];
    let lastSun = null;
    function processSun(st) {
      const a = st && st.attributes ? st.attributes : {};
      const azimuth = Number(a.azimuth), elevation = Number(a.elevation);
      if (!Number.isFinite(azimuth) || !Number.isFinite(elevation)) return false;
      if (lastSun && lastSun.azimuth === azimuth && lastSun.elevation === elevation) return false;
      lastSun = { azimuth, elevation };
      sunCallbacks.forEach(cb => { try { cb({ azimuth, elevation }); } catch (e) { console.error(e); } });
      return true;
    }

    // cb(entityId, raw) for a sensors.items entity whose STATE STRING changed
    // (first report included) -- a TV's screen follows its set's power -- or
    // one of its WATCHED attributes changed (itemWatched: an art condition's
    // attribute). Any other attribute-only republish (volume, media
    // position) does not fire, so a consumer may repaint on every call.
    const itemEntityCallbacks = [];
    function noteRaw(st) {
      if (!st || !st.entity_id) return;
      if (!entityIndex.has(st.entity_id) && !climateIndex.has(st.entity_id) && !itemEntityIds.has(st.entity_id) &&
        !fittingIndex.has(st.entity_id)) return;
      const prev = rawStates.get(st.entity_id);
      const raw = { state: st.state, attributes: st.attributes || {} };
      rawStates.set(st.entity_id, raw);
      const watched = itemWatched.get(st.entity_id);
      const attrChanged = !!prev && !!watched && watched.some(a => prev.attributes[a] !== raw.attributes[a]);
      if (itemEntityIds.has(st.entity_id) && (!prev || prev.state !== raw.state || attrChanged)) {
        itemEntityCallbacks.forEach(cb => {
          try { cb(st.entity_id, raw); } catch (e) { console.warn('HAClient itemEntityCb:', e); }
        });
      }
    }

    /**
     * Fold one climate entity into every room it is bound to. Notifies only
     * when the parsed reading changed -- hvac_action flapping, or any
     * attribute the row does not show, is not a repaint.
     */
    function processClimateUpdate(entityId, haState) {
      const roomIds = climateIndex.get(entityId);
      if (!roomIds) return false;
      const reading = parseClimate(haState);
      const key = JSON.stringify(reading);
      let fired = false;
      roomIds.forEach(roomId => {
        const prev = climateResolved.get(roomId);
        if (prev && prev.key === key) return;
        climateResolved.set(roomId, { reading, key });
        markFired('climate:' + roomId);
        fired = true;
        climateCallbacks.forEach(cb => {
          try { cb(roomId, reading); } catch (e) { console.warn('HAClient climateCb:', e); }
        });
      });
      return fired;
    }

    /**
     * Fold a vacuum (or its battery sensor) into every robot it serves.
     * Notifies only when the parsed reading changed -- the Dreame
     * integration republishes dozens of attributes (cleaning time, brush
     * life) that the card does not show, and each must not be a repaint.
     */
    function processVacuumUpdate(entityId, haState) {
      const itemIds = vacuumIndex.get(entityId);
      if (!itemIds) return false;
      vacuumState.set(entityId, haState);
      let fired = false;
      itemIds.forEach(itemId => { if (resolveVacuum(itemId)) fired = true; });
      return fired;
    }
    function resolveVacuum(itemId) {
      const b = vacuumBindings.get(itemId);
      const main = b && vacuumState.get(b.entity);
      if (!main) return false;   // the battery arrived first: wait for the robot
      const reading = parseVacuum(main, b.battery ? vacuumState.get(b.battery) : null);
      const key = JSON.stringify(reading);
      const prev = vacuumResolved.get(itemId);
      if (prev && prev.key === key) return false;
      vacuumResolved.set(itemId, { reading, key });
      markFired('vacuum:' + itemId);
      vacuumCallbacks.forEach(cb => {
        try { cb(itemId, reading); } catch (e) { console.warn('HAClient vacuumCb:', e); }
      });
      return true;
    }

    /**
     * Fold one of a plant's entities into every plant it serves. Notifies
     * only when the parsed reading changed (a report that moves only the
     * timestamp still changes `updated`, which the card shows).
     */
    function processPlantUpdate(entityId, haState) {
      const itemIds = plantIndex.get(entityId);
      if (!itemIds) return false;
      plantState.set(entityId, haState);
      let fired = false;
      itemIds.forEach(itemId => { if (resolvePlant(itemId)) fired = true; });
      return fired;
    }
    function resolvePlant(itemId) {
      const b = plantBindings.get(itemId);
      if (!b) return false;
      const get = eid => (eid ? plantState.get(eid) || null : null);
      const reading = parsePlant(b, { moisture: get(b.moisture), battery: get(b.battery), status: get(b.status),
        temperature: get(b.temperature), watering: get(b.watering) });
      if (reading.level == null) return false;   // the main reading has not arrived yet
      const key = JSON.stringify(reading);
      const prev = plantResolved.get(itemId);
      if (prev && prev.key === key) return false;
      plantResolved.set(itemId, { reading, key });
      markFired('plant:' + itemId);
      plantCallbacks.forEach(cb => {
        try { cb(itemId, reading); } catch (e) { console.warn('HAClient plantCb:', e); }
      });
      return true;
    }

    // ---- Full resync on every (re)connect ----
    //
    // Every path above notifies only on a CHANGE of its resolved value, which
    // is right for live events (an attribute-only republish must not become a
    // render) and wrong for a reconnect: if HA's value did not change across
    // an outage, the reconnect snapshot is swallowed as a no-op, and anything
    // the UI showed that HA never confirmed -- an optimistic drag, a tap
    // popover's offline preview -- stays on screen forever ("Open: 30%" while
    // HA says 100%). So after each get_states snapshot, every target that
    // did NOT already fire during that snapshot is re-emitted with its current
    // resolved value, once. On the first connect everything fires during the
    // snapshot, so this re-emits nothing and first-connect behaviour is
    // unchanged. Lights need none of this: processStateUpdate always fires
    // for a snapshot entity (bypassEcho), which is why they already resynced.
    //
    // A resync only ever calls the READ callbacks. It never reaches
    // callService, so it cannot send a command
    // (scripts/test-ha-resync.mjs pins that: zero call_service on reconnect).
    let snapshotFired = null;   // Set of target keys fired during the snapshot
    function markFired(key) { if (snapshotFired) snapshotFired.add(key); }

    function reapplyAll(fired) {
      const emit = (cbs, args, tag) => cbs.forEach(cb => {
        try { cb(...args); } catch (e) { console.warn('HAClient ' + tag + ':', e); }
      });
      ['curtain', 'cornice'].forEach(kind => {
        fittingResolved[kind].forEach((key, targetId) => {
          if (fired.has(kind + ':' + targetId)) return;
          emit(kind === 'curtain' ? curtainCallbacks : corniceCallbacks, [targetId, JSON.parse(key)], 'fittingCb');
        });
      });
      curtainAvailable.forEach((available, targetId) => {
        if (fired.has('available:' + targetId)) return;
        emit(curtainAvailabilityCallbacks, [targetId, available], 'curtainAvailabilityCb');
      });
      ['presence', 'door'].forEach(kind => {
        sensorState[kind].forEach((on, targetId) => {
          if (fired.has(kind + ':' + targetId)) return;
          emit(sensorCallbacksFor(kind), [targetId, on], 'sensorCb');
        });
        sensorStatus[kind].forEach((st, targetId) => {
          if (fired.has('status:' + kind + ':' + targetId)) return;
          emit(sensorStatusCallbacks, [kind, targetId, st], 'sensorStatusCb');
        });
      });
      climateResolved.forEach(({ reading }, roomId) => {
        if (fired.has('climate:' + roomId)) return;
        emit(climateCallbacks, [roomId, reading], 'climateCb');
      });
      vacuumResolved.forEach(({ reading }, itemId) => {
        if (fired.has('vacuum:' + itemId)) return;
        emit(vacuumCallbacks, [itemId, reading], 'vacuumCb');
      });
      plantResolved.forEach(({ reading }, itemId) => {
        if (fired.has('plant:' + itemId)) return;
        emit(plantCallbacks, [itemId, reading], 'plantCb');
      });
    }

    // Echo suppression
    const pendingCommands = new Map();

    function setStatus(s) {
      if (status === s) return;
      status = s;
      statusCallbacks.forEach(cb => { try { cb(s); } catch (e) { console.warn('HAClient statusCb:', e); } });
    }

    // ---- State normalization ----

    function normalizeState(haState, group) {
      const on = haState.state === 'on';
      const attrs = haState.attributes || {};
      const result = { on };

      if (group === 'main') {
        result.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 100 : 0);
        result.temp = (attrs.color_temp_kelvin != null) ? attrs.color_temp_kelvin : 4000;
      } else if (group === 'galaxy') {
        result.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 50 : 0);
      } else if (group === 'ambient') {
        // The room's ambience. Colour from rgb_color, else hs_color (some
        // integrations report only that). ON with no colour reported: the
        // accent default, as before. OFF (HA nulls the colour attributes):
        // no colour at all, so the last known colour stands rather than
        // being overwritten with a made-up default.
        result.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 80 : 0);
        const color = colorFromAttributes(attrs) || (on ? DEFAULT_ACCENT_COLOR : null);
        if (color) result.color = color;
      } else {
        // Any other named channel (a desk strip on its own entity, say) is an
        // accent light like 'ambient': it follows brightness AND colour
        // (rgb_color, else hs_color). With no colour reported the colour is
        // left as it was.
        result.bri = (attrs.brightness != null) ? Math.round(attrs.brightness / 2.55) : (on ? 100 : 0);
        const color = colorFromAttributes(attrs);
        if (color) result.color = color;
      }

      return result;
    }

    function processStateUpdate(entityId, haState, bypassEcho) {
      const mapping = entityIndex.get(entityId);
      if (!mapping) return;

      if (!bypassEcho) {
        const pendingTs = pendingCommands.get(entityId);
        if (pendingTs && (Date.now() - pendingTs) < 2000) return;
      }

      const { roomId, group } = mapping;
      const groupEntities = rooms[roomId]?.[group];
      // TODO: per-bulb tracking. Right now we only propagate the first entity's
      // state and drop the rest, so every 3D bulb in a group renders identical.
      // Future: pass entityId through to stateCallbacks and let the scene map
      // each entity to its own mesh/light. Sidebar/controls stay group-level
      // (callService already targets the whole entity_id list).
      if (!groupEntities || groupEntities[0] !== entityId) return;

      const normalized = normalizeState(haState, group);
      stateCallbacks.forEach(cb => {
        try { cb(roomId, group, normalized); } catch (e) { console.warn('HAClient stateCb:', e); }
      });
    }

    // ---- WebSocket ----

    let getStatesId = null;

    // Race all candidate URLs as WebSocket connections — first to get auth_required wins.
    // No HTTP probe needed; WebSocket has no CORS preflight.
    function openWS(candidate, onWin, onLose) {
      const wsUrl = candidate.replace(/^http/, 'ws') + '/api/websocket';
      let sock;
      try { sock = new WebSocket(wsUrl); } catch(e) { onLose(); return null; }
      sock.onmessage = e => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'auth_required') onWin(sock, candidate);
        } catch(_) {}
      };
      sock.onerror = () => {};
      sock.onclose = () => onLose();
      return sock;
    }

    function connect() {
      if (ws) return;
      clearTimeout(reconnectTimer);

      if (urls.length === 1) {
        // Single URL — open directly
        attachWS(new WebSocket(urls[0].replace(/^http/, 'ws') + '/api/websocket'), urls[0]);
        return;
      }

      // Race all URLs — first to get auth_required wins, others are closed
      let won = false;
      let loseCount = 0;
      const socks = [];
      urls.forEach(candidate => {
        const s = openWS(candidate, (winSock, winUrl) => {
          if (won) { winSock.close(); return; }
          won = true;
          url = winUrl;
          console.log('HAClient: connected via', url);
          setStatus('syncing');
          // Close all other racing sockets
          socks.forEach(other => { if (other !== winSock) try { other.close(); } catch(_){} });
          attachWS(winSock, winUrl, true);
        }, () => {
          loseCount++;
          if (!won && loseCount === urls.length) {
            setStatus('disconnected');
            scheduleReconnect();
          }
        });
        if (s) socks.push(s);
      });
    }

    function attachWS(sock, activeUrl, seenAuthRequired) {
      ws = sock;
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }

        if (msg.type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        } else if (msg.type === 'auth_ok') {
          console.log('HAClient: Authenticated via', activeUrl);
          authed = true;
          setStatus('syncing');
          const id = wsId++;
          getStatesId = id;
          wsSend({ id, type: 'get_states' });
          wsSend({ id: wsId++, type: 'subscribe_events', event_type: 'state_changed' });
        } else if (msg.type === 'auth_invalid') {
          console.error('HAClient: Auth failed');
          setStatus('auth_failed');
          ws.close();
        } else if (msg.type === 'result' && msg.id === getStatesId) {
          if (msg.success && Array.isArray(msg.result)) {
            const fired = snapshotFired = new Set();
            try {
              msg.result.forEach(state => {
                noteRaw(state);
                if (state.entity_id === 'sun.sun') processSun(state);
                if (entityIndex.has(state.entity_id)) processStateUpdate(state.entity_id, state, true);
                // Sensors are folded in from the SAME get_states snapshot, so a
                // room that is already occupied (or a door already open) is
                // correct on first paint rather than only after the sensor
                // happens to change.
                else if (sensorIndex.has(state.entity_id)) processSensorUpdate(state.entity_id, state);
                if (fittingIndex.has(state.entity_id)) processFittingUpdate(state.entity_id, state);
                if (climateIndex.has(state.entity_id)) processClimateUpdate(state.entity_id, state);
                // Vacuums: record only, and resolve once after the loop, so a
                // robot listed before its battery sensor is not reported
                // first with no battery and then again with it.
                if (vacuumIndex.has(state.entity_id)) vacuumState.set(state.entity_id, state);
                if (plantIndex.has(state.entity_id)) plantState.set(state.entity_id, state);
              });
              vacuumBindings.forEach(b => resolveVacuum(b.itemId));
              plantBindings.forEach(b => resolvePlant(b.itemId));
            } finally { snapshotFired = null; }
            // Full resync: re-apply every target the snapshot did not
            // already fire, BEFORE 'connected' re-enables the controls.
            reapplyAll(fired);
            setStatus('connected');
          } else {
            setStatus('sync_failed');
          }
          getStatesId = null;
        } else if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
          const { entity_id, new_state } = msg.event.data;
          if (!new_state) return;
          noteRaw(new_state);
          if (entity_id === 'sun.sun') processSun(new_state);
          if (entityIndex.has(entity_id)) processStateUpdate(entity_id, new_state, false);
          else if (sensorIndex.has(entity_id)) processSensorUpdate(entity_id, new_state);
          if (fittingIndex.has(entity_id)) processFittingUpdate(entity_id, new_state);
          if (climateIndex.has(entity_id)) processClimateUpdate(entity_id, new_state);
          if (vacuumIndex.has(entity_id)) processVacuumUpdate(entity_id, new_state);
          if (plantIndex.has(entity_id)) processPlantUpdate(entity_id, new_state);
        }
      };
      ws.onclose = () => {
        ws = null;
        authed = false;
        // Drop every debounced send still pending: it could only fire into a
        // dead socket now, or -- after a fast reconnect -- replay a value the
        // user set before the outage. The reconnect resync repaints the UI.
        cancelAllDebounced();
        if (status !== 'auth_failed') { setStatus('disconnected'); scheduleReconnect(); }
      };
      ws.onerror = () => {};

      // Race path: the probe handler in openWS() already consumed the one-shot
      // `auth_required` message, so HA won't send it again. Authenticate now.
      if (seenAuthRequired) {
        try { ws.send(JSON.stringify({ type: 'auth', access_token: token })); } catch (_) {}
      }
    }

    function wsSend(data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    }

    function scheduleReconnect() {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (status !== 'auth_failed') connect();
      }, wsReconnectMs);
    }

    function disconnect() {
      clearTimeout(reconnectTimer);
      if (ws) { ws.onclose = null; ws.close(); ws = null; }
      authed = false;
      cancelAllDebounced();
      setStatus('disconnected');
    }

    // ---- Service calls ----

    const debounceTimers = {};

    // Returns true if the command went out, false if it was dropped because
    // the WebSocket is not up. Dropped, NOT queued or sent another way: a
    // queued command replayed after a reconnect would move a curtain or a
    // thermostat to a value the user set seconds or minutes ago, and there is
    // no other way to send it (see "Transport" at the top of create()).
    function callService(domain, service, data, target) {
      if (!authed || !ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('HAClient: not connected; dropped ' + domain + '.' + service + '.');
        return false;
      }
      const entities = target.entity_id;
      const now = Date.now();
      (Array.isArray(entities) ? entities : [entities]).forEach(eid => {
        pendingCommands.set(eid, now);
        setTimeout(() => pendingCommands.delete(eid), 3000);
      });
      wsSend({ id: wsId++, type: 'call_service', domain, service, service_data: data, target });
      return true;
    }

    /**
     * `guard` (optional): re-checked at the moment the command would
     * actually go out -- on the immediate path and, crucially, when a
     * debounced timer fires. A slider value queued 200ms ago must not reach
     * a thermostat that has since gone off (some integrations turn heating
     * back ON when sent a temperature while off) or a cover that has since
     * gone unavailable. Returning false drops the send.
     */
    function callServiceDebounced(domain, service, data, target, debounceKey, delayMs, guard) {
      const fire = () => {
        delete debounceTimers[debounceKey];
        if (typeof guard === 'function' && !guard()) return;
        callService(domain, service, data, target);
      };
      // ALWAYS clear first, even on the immediate (delayMs<=0) path: a caller
      // that debounces on 'input' and then sends immediately on 'change' (the
      // curtain slider does exactly this, to guarantee the final value on a
      // release that lands inside the debounce window) would otherwise get
      // its own pending timer firing ~delayMs later and re-sending the same
      // command a second time. One user action, one command.
      clearTimeout(debounceTimers[debounceKey]);
      if (delayMs <= 0) { fire(); return; }
      debounceTimers[debounceKey] = setTimeout(fire, delayMs);
    }

    /** Drop a debounced send still pending under `debounceKey`, if any.
     *  Returns true if one was pending. */
    function cancelDebounced(debounceKey) {
      const pending = debounceKey in debounceTimers;
      clearTimeout(debounceTimers[debounceKey]);
      delete debounceTimers[debounceKey];
      return pending;
    }

    function cancelAllDebounced() {
      Object.keys(debounceTimers).forEach(cancelDebounced);
    }

    return {
      connect,
      disconnect,
      onStateChange(cb) { stateCallbacks.push(cb); },
      // cb(roomId, occupied) / cb(doorId, open). Fired ONLY when the OR-ed
      // boolean for that target actually changes, never on an attribute-only
      // republish -- the consumer may safely request a render on every call.
      onPresenceChange(cb) { presenceCallbacks.push(cb); },
      onDoorChange(cb) { doorCallbacks.push(cb); },
      // cb(curtainId, { pct, moving }) where moving is 'opening'|'closing'|null
      // and cb(curtainId, { on, bri, color }). Fired only on a real change.
      onCurtainChange(cb) { curtainCallbacks.push(cb); },
      onCorniceChange(cb) { corniceCallbacks.push(cb); },
      // cb(curtainId, available). Fired only when the OR-across-motors
      // availability actually flips -- 'unavailable'/'unknown' on ANY bound
      // motor resolves the whole curtain unavailable, since a slider cannot
      // promise to move a track it can only partly reach. Independent of
      // onCurtainChange: a dropped motor disables the slider immediately even
      // though the last known position keeps being shown (parseCover's
      // "hold, don't invent" contract for position is unaffected).
      onCurtainAvailabilityChange(cb) { curtainAvailabilityCallbacks.push(cb); },
      // Last resolved availability for a curtain id, or null before any
      // reading has arrived (bound but never heard from -- panel should
      // treat "no reading yet" the same as "unavailable": nothing to send to).
      getCurtainAvailable(curtainId) {
        return curtainAvailable.has(curtainId) ? curtainAvailable.get(curtainId) : null;
      },
      // cb(kind, targetId, status): kind 'presence'|'door', status
      // 'on'|'off'|'unavailable' (see reduceBinarySensorStates). Fired only
      // when a target's resolved status actually changes. This is the
      // sidebar's motion tag / door text; the booleans above still drive
      // the 3D scene.
      onSensorStatusChange(cb) { sensorStatusCallbacks.push(cb); },
      getSensorStatus(kind, targetId) {
        const m = sensorStatus[kind];
        return m && m.has(targetId) ? m.get(targetId) : null;
      },
      // cb(roomId, reading) with reading from parseClimate(). Fired only on
      // a real change of the parsed reading.
      onClimateChange(cb) { climateCallbacks.push(cb); },
      // cb({ azimuth, elevation }) from sun.sun, degrees. See processSun.
      onSunChange(cb) { sunCallbacks.push(cb); },
      // Test seam: a sun.sun state object in, true if the callback fired.
      _injectSunState(haState) { return processSun(haState); },
      getClimate(roomId) {
        const r = climateResolved.get(roomId);
        return r ? r.reading : null;
      },
      climateEntityFor(roomId) { return climateByRoom.get(roomId) || null; },
      // cb(itemId, reading) with reading from parseVacuum(). Fired only on a
      // real change of the parsed reading (and once more on a reconnect).
      onVacuumChange(cb) { vacuumCallbacks.push(cb); },
      getVacuum(itemId) {
        const r = vacuumResolved.get(itemId);
        return r ? r.reading : null;
      },
      // The normalised binding for one robot (see vacuum-control.js), or null.
      vacuumBinding(itemId) { return vacuumBindings.get(itemId) || null; },
      // cb(itemId, reading) with reading from parsePlant(). Fired only on a
      // real change of the parsed reading (and once more on a reconnect).
      onPlantChange(cb) { plantCallbacks.push(cb); },
      getPlant(itemId) {
        const r = plantResolved.get(itemId);
        return r ? r.reading : null;
      },
      plantBinding(itemId) { return plantBindings.get(itemId) || null; },
      // Raw { state, attributes } last seen for a bound light / climate
      // entity, or null before it has reported. See rawStates above.
      getRawState(entityId) { return rawStates.get(entityId) || null; },
      // cb(entityId, raw) -- see itemEntityCallbacks above.
      onItemEntityChange(cb) { itemEntityCallbacks.push(cb); },
      onStatusChange(cb) { statusCallbacks.push(cb); },
      // Test/diagnostic seam: drive a sensor without a live HA socket. Returns
      // true if the resolved boolean changed (and callbacks fired).
      _injectSensorState(entityId, state) {
        return processSensorUpdate(entityId, { state });
      },
      // Same seam for a cover or cornice light: pass the full HA state object
      // ({ state, attributes }). Returns true if the curtain/cornice VALUE
      // callback fired. An availability-only flip (see
      // onCurtainAvailabilityChange) still returns false here -- check
      // getCurtainAvailable() or the availability callback for that signal.
      _injectFittingState(entityId, haState) {
        return processFittingUpdate(entityId, haState);
      },
      // Same seam for a climate entity: full HA state object in, true if
      // the climate callback fired.
      _injectClimateState(entityId, haState) {
        return processClimateUpdate(entityId, haState);
      },
      // Same seam for a vacuum or its battery sensor: true if a vacuum
      // callback fired.
      _injectVacuumState(entityId, haState) {
        return processVacuumUpdate(entityId, haState);
      },
      // Same seam for any entity a plant reads: true if a plant callback fired.
      _injectPlantState(entityId, haState) {
        return processPlantUpdate(entityId, haState);
      },
      // Same seam for a room LIGHT entity (rooms.json rooms.<id>.<channel>):
      // full HA state object in; the onStateChange callbacks fire exactly as
      // they would for a live update (echo suppression bypassed).
      _injectLightState(entityId, haState) {
        processStateUpdate(entityId, haState, true);
      },
      callService,
      callServiceDebounced,
      cancelDebounced,
      get status() { return status; },
      get activeUrl() { return url; }
    };
  }


  return {
    create,
    coverPositionCommand,
    coverOpenCloseCommand,
    parseClimate,
    climateTargetCommand,
    reduceBinarySensorStates,
    parseVacuum,
    vacuumCommand,
    vacuumSegmentCommand,
    parsePlant
  };
})();
