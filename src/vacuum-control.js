/**
 * vacuum-control.js -- the robot vacuum's Home Assistant control, as pure
 * functions: binding normalisation, the reading, which actions are allowed,
 * and the service call each action makes. No DOM, no socket, no THREE:
 * src/ha-client.js folds states into readings with parseVacuum, and the tap
 * popover (src/tap-popovers.js) and the sidebar block (index.html) both build
 * their buttons from vacuumActions and send vacuumCommand /
 * vacuumSegmentCommand through the client's own callService -- the one HA
 * write path the app has. Unit-tested in scripts/test-vacuum-control.mjs.
 *
 * THE BINDING (rooms.json `sensors.vacuums`, schemaVersion 1.4) is keyed by
 * the FURNITURE ITEM id of the robot's dock (geometry.json `furniture[].id`),
 * which is what makes the model clickable:
 *
 *   vacuums: {
 *     kitchen_robot: {
 *       entity:   <the vacuum.* entity id>,
 *       battery:  <a sensor.* battery entity id>,        // optional
 *       segments: { kitchen: 7, lounge: 8 },              // optional
 *       segmentService: 'dreame_vacuum.vacuum_clean_segment' // optional
 *     }
 *   }
 *
 * (docs/house-profile.md has the JSON.)
 * `segments` maps a ROOM id to the integration's own room (segment) number,
 * for "clean this room". Without it the card has no room buttons. The
 * segment service defaults to the Dreame integration's; another integration
 * names its own.
 */

/** HA's vacuum states (the `vacuum` entity's state string). */
export const VACUUM_STATES = Object.freeze(['cleaning', 'docked', 'paused', 'returning', 'idle', 'error']);
export const DEFAULT_SEGMENT_SERVICE = 'dreame_vacuum.vacuum_clean_segment';

const isEntity = (v, domain) => typeof v === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(v) &&
  (!domain || v.indexOf(domain + '.') === 0);

/**
 * rooms.json `sensors.vacuums` -> Map itemId -> { itemId, entity, battery,
 * segments: [{ roomId, segment }], segmentService }. An entry without a
 * `vacuum.*` entity is dropped (it could never be controlled); a segment
 * that is not a non-negative integer is dropped; a malformed segmentService
 * falls back to the default.
 */
export function normaliseVacuumBindings(vacuums) {
  const out = new Map();
  if (!vacuums || typeof vacuums !== 'object') return out;
  Object.keys(vacuums).forEach(itemId => {
    const b = vacuums[itemId];
    if (!b || typeof b !== 'object' || !isEntity(b.entity, 'vacuum')) return;
    const segments = [];
    if (b.segments && typeof b.segments === 'object') {
      Object.keys(b.segments).forEach(roomId => {
        const n = b.segments[roomId];
        if (Number.isInteger(n) && n >= 0) segments.push({ roomId, segment: n });
      });
    }
    const svc = typeof b.segmentService === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(b.segmentService)
      ? b.segmentService : DEFAULT_SEGMENT_SERVICE;
    out.set(itemId, {
      itemId,
      entity: b.entity,
      battery: isEntity(b.battery, 'sensor') ? b.battery : null,
      segments,
      segmentService: svc
    });
  });
  return out;
}

/**
 * The vacuum's HA state (and, optionally, its battery sensor's) -> the
 * reading every surface shows:
 *   { available, state, status, battery, error }
 * `state` is one of VACUUM_STATES, or null when unavailable/unknown or a
 * state HA does not define. `status` is the integration's finer-grained
 * `status` attribute when it gives one ('charging_completed', 'washing'),
 * else null. `battery` is 0..100 or null: the sensor wins over the entity's
 * own `battery_level` attribute (which HA is phasing out). `error` is the
 * `error` attribute when the state is 'error' or the attribute names a real
 * fault ('no_error' and friends are not errors).
 */
export function parseVacuum(haState, batteryState) {
  const st = haState ? haState.state : undefined;
  const available = typeof st === 'string' && st !== 'unavailable' && st !== 'unknown';
  const a = (haState && haState.attributes) || {};
  const state = available && VACUUM_STATES.indexOf(st) !== -1 ? st : null;
  const status = typeof a.status === 'string' && a.status ? a.status : null;
  let battery = null;
  const bs = batteryState ? +batteryState.state : NaN;
  if (batteryState && batteryState.state !== '' && isFinite(bs)) battery = bs;
  else if (typeof a.battery_level === 'number' && isFinite(a.battery_level)) battery = a.battery_level;
  if (battery !== null) battery = Math.max(0, Math.min(100, Math.round(battery)));
  const rawErr = typeof a.error === 'string' ? a.error : null;
  const error = rawErr && !/^(no[_ ]?error|none|ok|)$/i.test(rawErr) ? rawErr : (state === 'error' ? 'error' : null);
  return { available, state, status, battery, error };
}

/**
 * Which of the three buttons can act on this reading. Each one is enabled
 * only when it would change something, so a stray tap cannot, say, send a
 * docked robot home again or start one that is already cleaning:
 *   start   not cleaning (paused -> this RESUMES, so the label says so)
 *   pause   cleaning or returning
 *   dock    anything but docked
 * An unavailable vacuum, or no reading at all, enables nothing.
 */
export function vacuumActions(reading) {
  const r = reading;
  if (!r || !r.available || !r.state) return { start: false, pause: false, dock: false, resume: false, rooms: false };
  const s = r.state;
  return {
    start: s !== 'cleaning',
    resume: s === 'paused',
    pause: s === 'cleaning' || s === 'returning',
    dock: s !== 'docked',
    // A room clean starts a new job: allowed whenever the robot is not
    // already cleaning (the integration refuses one mid-job anyway).
    rooms: s !== 'cleaning'
  };
}

const SERVICE = { start: 'start', pause: 'pause', dock: 'return_to_base' };

/**
 * Button -> the service call, or null (send nothing) when the action is not
 * one of start/pause/dock, the entity is not a vacuum, or vacuumActions says
 * the action cannot apply to this reading. The last guard duplicates the
 * disabled button on purpose: this drives a physical robot.
 */
export function vacuumCommand(action, entityId, reading) {
  const service = SERVICE[action];
  if (!service || !isEntity(entityId, 'vacuum')) return null;
  if (!vacuumActions(reading)[action]) return null;
  return { domain: 'vacuum', service, data: {}, target: { entity_id: entityId } };
}

/**
 * "Clean this room" -> the integration's segment service. Null when the
 * segment is not a non-negative integer, the entity is not a vacuum, the
 * service name is malformed, or the robot cannot take a new job now.
 */
export function vacuumSegmentCommand(entityId, segment, reading, service) {
  if (!isEntity(entityId, 'vacuum') || !Number.isInteger(segment) || segment < 0) return null;
  if (!vacuumActions(reading).rooms) return null;
  const svc = typeof service === 'string' && service ? service : DEFAULT_SEGMENT_SERVICE;
  const m = /^([a-z_]+)\.([a-z0-9_]+)$/.exec(svc);
  if (!m) return null;
  return { domain: m[1], service: m[2], data: { segments: [segment] }, target: { entity_id: entityId } };
}

/** 'charging_completed' -> 'Charging completed'. */
export function humanise(s) {
  if (typeof s !== 'string' || !s) return '';
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The one-line status every surface shows: the integration's own status when
 * it is more specific than the HA state, else the state. 'Unavailable' when
 * there is no usable reading.
 */
export function vacuumStatusText(reading) {
  if (!reading || !reading.available || !reading.state) return 'Unavailable';
  if (reading.state === 'error') return 'Error' + (reading.error && reading.error !== 'error' ? ': ' + humanise(reading.error) : '');
  if (reading.status && reading.status !== reading.state) return humanise(reading.status);
  return humanise(reading.state);
}

/**
 * Sample readings for a house with no Home Assistant (the demo) and for the
 * spec page's control preview. Clearly marked as samples wherever shown.
 */
export const MOCK_VACUUM_READINGS = Object.freeze({
  docked: Object.freeze({ available: true, state: 'docked', status: 'charging_completed', battery: 100, error: null }),
  cleaning: Object.freeze({ available: true, state: 'cleaning', status: 'sweeping', battery: 72, error: null }),
  paused: Object.freeze({ available: true, state: 'paused', status: 'paused', battery: 64, error: null }),
  returning: Object.freeze({ available: true, state: 'returning', status: 'returning', battery: 41, error: null }),
  error: Object.freeze({ available: true, state: 'error', status: 'error', battery: 57, error: 'right_wheel_motor' }),
  unavailable: Object.freeze({ available: false, state: null, status: null, battery: null, error: null })
});

/**
 * What a mock (no-HA) robot does when a button is pressed: the state the
 * preview moves to. Null when the action does not apply.
 */
export function mockVacuumAfter(action, reading) {
  if (!vacuumActions(reading)[action === 'room' ? 'rooms' : action]) return null;
  const base = Object.assign({}, reading, { error: null });
  if (action === 'start' || action === 'room') return Object.assign(base, { state: 'cleaning', status: action === 'room' ? 'room_cleaning' : 'sweeping' });
  if (action === 'pause') return Object.assign(base, { state: 'paused', status: 'paused' });
  if (action === 'dock') return Object.assign(base, { state: 'returning', status: 'returning' });
  return null;
}
