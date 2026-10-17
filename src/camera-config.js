/**
 * camera-config.js -- the house profile's optional `camera` block: how the
 * camera MOVES (room-to-room walks, the preview's rise and fall, flight
 * durations), tunable by editing geometry.json and reloading -- no rebuild.
 *
 * PURE: no DOM, no THREE, no globals. resolveCameraConfig(raw, warn) returns
 * a complete, frozen config; every key absent (or no block at all) resolves
 * to exactly the value the engine always used, so a profile without the
 * block behaves byte-identically. A non-numeric / out-of-range value warns
 * once and falls back to its default -- it never throws and never breaks the
 * page. Internal safety margins (ceiling gap, wall clearance, the pillar
 * allowance) are deliberately NOT here.
 *
 * Consumers (all take the resolved config as a plain parameter):
 *   walkOptions(cfg)        the `options` doorway-walk.js planWalk / planGlide /
 *                           outsideView read (merged over its WALK table)
 *   sharedSpotOptions(cfg)  sharedVantage's ratio / reach, or null when off
 *   previewOptions(cfg)     the extra fields previewPose(t, g) reads
 *   previewRotateSpeed()    rad/s, URL > profile > default
 * Tested in scripts/test-camera-config.mjs. Documented in docs/house-profile.md.
 */

const WALK_SPEED_DEFAULT = 5.5;   // m/s
const WALK_ACCEL_DEFAULT = 30;    // m/s^2: the ramp 0 -> 5.5 m/s takes 5.5 / 30 = 0.183 s

/** key -> [default, min, max]. */
export const CAMERA_SPEC = Object.freeze({
  walk: Object.freeze({
    speedMps: [WALK_SPEED_DEFAULT, 0.5, 30],
    easeSec: [WALK_SPEED_DEFAULT / WALK_ACCEL_DEFAULT, 0.02, 2],
    maxTurnDegPerSec: [500, 30, 2000],
    minMoveMs: [330, 50, 3000],
    maxMoveMs: [3000, 500, 20000],
    minTurnMs: [300, 50, 3000],
    lookAheadM: [1.6, 0.2, 6],
    lookDownDeg: [6, 0, 30],
    eyeHeightM: [1.6, 0.5, 2.4]
  }),
  sharedSpot: Object.freeze({
    maxDistM: [1, 0, 5],
    minCoverage: [0.75, 0.3, 1]
  }),
  preview: Object.freeze({
    rotateSecPerLap: [120, 10, 3600],
    topHoldLaps: [1, 0, 10],
    descentLaps: [0.4, 0.05, 5],
    eyeLevelLaps: [1, 0, 10],
    ascentLaps: [1 / 3, 0.05, 5],
    eyeHeightM: [1.7, 0.5, 3],
    eyeLevelDistanceFactor: [1.5, 1.05, 4],
    eyeLevelExtraM: [3, 0, 20]
  }),
  flight: Object.freeze({
    homeToRoomMs: [1200, 100, 10000],
    betweenOutsideViewsMs: [700, 100, 10000]
  })
});

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

function readSection(raw, spec, path, warn, extraKnown) {
  const out = {};
  const src = isObj(raw) ? raw : {};
  if (raw !== undefined && !isObj(raw)) warn(path + ' must be an object -- ignored');
  Object.keys(src).forEach(k => {
    if (!(k in spec) && !(extraKnown || []).includes(k)) warn(path + '.' + k + ' is not a camera setting -- ignored');
  });
  Object.keys(spec).forEach(k => {
    const [def, lo, hi] = spec[k];
    const v = src[k];
    if (v === undefined) { out[k] = def; return; }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) {
      warn(path + '.' + k + ' = ' + JSON.stringify(v) + ' is not a number between ' + lo + ' and ' + hi + ' -- using the default ' + def);
      out[k] = def;
      return;
    }
    out[k] = v;
  });
  return out;
}

/**
 * @param raw   geometry.camera (anything; undefined = no block)
 * @param warn  (msg) => void, called once per bad value (default: console.warn)
 * @returns frozen { walk: { ..., sharedSpot: { enabled, maxDistM, minCoverage } }, preview, flight }
 */
export function resolveCameraConfig(raw, warn) {
  const w = typeof warn === 'function' ? warn : (m => console.warn('[camera] ' + m));
  if (raw !== undefined && !isObj(raw)) w('camera must be an object -- ignored');
  const src = isObj(raw) ? raw : {};
  Object.keys(src).forEach(k => { if (!(k in CAMERA_SPEC) || k === 'sharedSpot') w('camera.' + k + ' is not a camera setting -- ignored'); });
  const walk = readSection(src.walk, CAMERA_SPEC.walk, 'camera.walk', w, ['sharedSpot']);
  const ss = isObj(src.walk) ? src.walk.sharedSpot : undefined;
  const sharedSpot = readSection(ss, CAMERA_SPEC.sharedSpot, 'camera.walk.sharedSpot', w, ['enabled']);
  sharedSpot.enabled = true;
  if (isObj(ss) && ss.enabled !== undefined) {
    if (typeof ss.enabled === 'boolean') sharedSpot.enabled = ss.enabled;
    else w('camera.walk.sharedSpot.enabled = ' + JSON.stringify(ss.enabled) + ' is not true or false -- using the default true');
  }
  walk.sharedSpot = Object.freeze(sharedSpot);
  // A slowest hop shorter than the quickest is contradictory: the quickest wins.
  if (walk.maxMoveMs < walk.minMoveMs) {
    w('camera.walk.maxMoveMs (' + walk.maxMoveMs + ') is below minMoveMs (' + walk.minMoveMs + ') -- using minMoveMs');
    walk.maxMoveMs = walk.minMoveMs;
  }
  return Object.freeze({
    walk: Object.freeze(walk),
    preview: Object.freeze(readSection(src.preview, CAMERA_SPEC.preview, 'camera.preview', w)),
    flight: Object.freeze(readSection(src.flight, CAMERA_SPEC.flight, 'camera.flight', w))
  });
}

/** The unset config: every default. */
export const DEFAULT_CAMERA = resolveCameraConfig(undefined, () => {});

/**
 * doorway-walk options. easeSec is the ramp's duration, so the acceleration is
 * speed / easeSec; at the defaults that is the engine's own 30 m/s^2 exactly.
 */
export function walkOptions(cfg) {
  const c = (cfg || DEFAULT_CAMERA).walk;
  const accel = c.speedMps === WALK_SPEED_DEFAULT && c.easeSec === CAMERA_SPEC.walk.easeSec[0] ? WALK_ACCEL_DEFAULT : c.speedMps / c.easeSec;
  return {
    walkSpeed: c.speedMps, accel, maxYawRate: c.maxTurnDegPerSec,
    minMs: c.minMoveMs, maxMs: c.maxMoveMs, turnMinMs: c.minTurnMs,
    lookChord: c.lookAheadM, travelPitchDeg: c.lookDownDeg, eyeY: c.eyeHeightM
  };
}

/** sharedVantage's `ratio` / `reach`, or null when sharing is switched off. */
export function sharedSpotOptions(cfg) {
  const s = (cfg || DEFAULT_CAMERA).walk.sharedSpot;
  return s.enabled ? { ratio: s.minCoverage, reach: s.maxDistM } : null;
}

/** Fields previewPose(t, g) reads on top of the scene's geometry. */
export function previewOptions(cfg) {
  const p = (cfg || DEFAULT_CAMERA).preview;
  return {
    topHoldLaps: p.topHoldLaps, descentLaps: p.descentLaps, eyeLevelLaps: p.eyeLevelLaps, ascentLaps: p.ascentLaps,
    eyeHeightM: p.eyeHeightM, eyeLevelDistanceFactor: p.eyeLevelDistanceFactor, eyeLevelExtraM: p.eyeLevelExtraM
  };
}

/**
 * Preview rotation, rad/s. URL > profile > default: a finite ?rotateSpeed
 * (0 = frozen) always wins; else the profile's rotateSecPerLap; else 2*pi/120.
 * @param urlValue  the raw query-string value (string | null)
 */
export function previewRotateSpeed(urlValue, cfg) {
  const u = urlValue == null ? NaN : parseFloat(urlValue);
  if (Number.isFinite(u)) return u;
  return (Math.PI * 2) / (cfg || DEFAULT_CAMERA).preview.rotateSecPerLap;
}
