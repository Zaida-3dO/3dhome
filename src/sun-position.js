// sun-position.js -- where the sun is, and what daylight that makes.
//
// Pure maths: no THREE, no DOM, so `node scripts/test-sun-position.mjs` can
// exercise every function here directly. home3d-scene.js owns the lights and
// meshes; this file only answers "which way, how bright, what colour, and
// which patch of floor does a window's sun land on".
//
// Axes. Plan space has x = east and y = SOUTH (plan north is -y); the scene
// maps plan x -> world +x and plan y -> world +z, with world +y up. So in
// world terms east = +x, south = +z, north = -z.

const DEG = Math.PI / 180;

/**
 * Solar azimuth and elevation for an instant and a place.
 *
 * The low-precision almanac formula (the one the Astronomical Almanac prints
 * for 1950-2050): about 0.01 deg in declination, far below anything a room's
 * light can show. No refraction correction -- it only matters within a
 * degree of the horizon, where the light is already fading out.
 *
 * @param {Date} date     the instant (its UTC value is what counts)
 * @param {number} latDeg degrees north
 * @param {number} lonDeg degrees east
 * @returns {{ azimuth: number, elevation: number, declination: number }}
 *   azimuth in degrees clockwise from true north (0..360), elevation in
 *   degrees above the horizon (-90..90), declination in degrees.
 */
export function solarPosition(date, latDeg, lonDeg) {
  // Days since J2000.0 (2000-01-01 12:00 UTC).
  const n = date.getTime() / 86400000 - 10957.5;
  const L = (280.460 + 0.9856474 * n) * DEG;           // mean longitude
  const g = (357.528 + 0.9856003 * n) * DEG;           // mean anomaly
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * DEG;          // obliquity
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  // Greenwich mean sidereal time, hours -> local hour angle.
  const gmst = 18.697374558 + 24.06570982441908 * n;
  const lst = (gmst * 15 + lonDeg) * DEG;
  const H = lst - ra;
  const phi = latDeg * DEG;
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  // Azimuth measured from north, clockwise (east = 90).
  const az = Math.atan2(-Math.sin(H), Math.tan(decl) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  let azDeg = az / DEG;
  azDeg = ((azDeg % 360) + 360) % 360;
  return { azimuth: azDeg, elevation: el / DEG, declination: decl / DEG };
}

/**
 * Local solar noon for `date`'s calendar day, as a Date. Used by the Settings
 * presets ("noon" = solar noon, "morning" = a few hours before it) so a
 * preset shows the SAME sun wherever the viewer's clock is.
 */
export function solarNoon(date, lonDeg) {
  // Equation of time is at most ~16 min; ignored -- the presets are named
  // moments, not an ephemeris.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0));
  return new Date(d.getTime() - (lonDeg / 15) * 3600000);
}

/**
 * Unit vector from the house TOWARD the sun, in world axes [x, y, z].
 *
 * northOffsetDegrees follows houses/schema.json: the rotation from plan-north
 * to true north, clockwise. True north sits at plan bearing `offset`, so a sun
 * at true azimuth A sits at plan bearing A + offset.
 */
export function sunDirection(azimuthDeg, elevationDeg, northOffsetDegrees) {
  const b = (azimuthDeg + (northOffsetDegrees || 0)) * DEG;
  const el = elevationDeg * DEG;
  const h = Math.cos(el);
  // Plan bearing b: east component sin(b), north component cos(b).
  // World: east = +x, north = -z.
  return [Math.sin(b) * h, Math.sin(el), -Math.cos(b) * h];
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Sun colour against elevation (deg): a continuous warm-to-white ramp,
// roughly 2000 K at the horizon to ~5500 K high up. Replaces the old single
// gold->white snap at a sun factor of 0.7.
const SUN_RAMP = [
  [0, [1.00, 0.52, 0.28]],
  [3, [1.00, 0.62, 0.36]],
  [8, [1.00, 0.74, 0.50]],
  [15, [1.00, 0.84, 0.66]],
  [25, [1.00, 0.90, 0.78]],
  [40, [1.00, 0.94, 0.87]]
];

export function sunColor(elevationDeg) {
  if (elevationDeg <= SUN_RAMP[0][0]) return SUN_RAMP[0][1].slice();
  for (let i = 1; i < SUN_RAMP.length; i++) {
    const [e1, c1] = SUN_RAMP[i];
    if (elevationDeg <= e1) {
      const [e0, c0] = SUN_RAMP[i - 1];
      return lerp3(c0, c1, (elevationDeg - e0) / (e1 - e0));
    }
  }
  return SUN_RAMP[SUN_RAMP.length - 1][1].slice();
}

// Night values. These are EXACTLY the rig's old sun-factor-0 state, so night
// (and the sun switched off) looks as it always has: the room lights carry it.
export const NIGHT = Object.freeze({
  fill: 0.12,
  fillColor: Object.freeze([0.85, 0.85, 0.9]),
  ground: Object.freeze([0x18 / 255, 0x18 / 255, 0x18 / 255]),
  background: Object.freeze([0x0f / 255, 0x0f / 255, 0x1a / 255])
});

// Daytime targets.
const DAY_SKY_FILL = [0.86, 0.92, 1.00];     // cool light from above
const DAY_BOUNCE_FILL = [0.86, 0.76, 0.62];  // warm floor bounce from below
const LOW_SUN_FILL = [1.00, 0.84, 0.68];     // what a low sun turns both toward
const DAY_FILL_GAIN = 0.44;                  // on top of NIGHT.fill; was 0.58 flat
const DAY_GROUND = [0.24, 0.30, 0.19];
const DAY_BACKGROUND = [0.32, 0.45, 0.64];   // midday sky
const DUSK_BACKGROUND = [0.42, 0.30, 0.30];  // low-sun sky
const SUN_PEAK = 0.9;

/**
 * Everything the daylight rig sets, as a function of solar elevation (deg).
 *
 *   day      0..1, how much daytime there is (sky, fill). Rises through civil
 *            twilight (-6 deg) and is full by 10 deg.
 *   direct   0..1, how much DIRECT sun there is: 0 below the horizon.
 *   sun      directional light colour; sunIntensity its intensity.
 *   sky / bounce / fill   the hemisphere light: colour from above, colour
 *            from below, intensity. At night sky == bounce, which makes the
 *            hemisphere light identical to the old flat ambient.
 *   background, ground    the clear colour and the ground plane.
 */
export function daylightCurve(elevationDeg) {
  const el = elevationDeg;
  const day = smoothstep(-6, 10, el);
  const direct = smoothstep(-0.5, 4, el);
  const high = Math.max(0, Math.min(1, Math.sin(Math.max(0, el) * DEG) / Math.sin(40 * DEG)));
  const sun = sunColor(el);
  const sunIntensity = SUN_PEAK * direct * (0.45 + 0.55 * high);
  const fill = NIGHT.fill + DAY_FILL_GAIN * day;
  // Low sun warms the sky (and so the rooms); a high one leaves it blue.
  const warm = day * (1 - smoothstep(4, 22, el));
  const sky = lerp3(NIGHT.fillColor, lerp3(DAY_SKY_FILL, LOW_SUN_FILL, 0.7 * warm), day);
  const bounce = lerp3(NIGHT.fillColor, lerp3(DAY_BOUNCE_FILL, LOW_SUN_FILL, 0.5 * warm), day);
  const dayBg = lerp3(DAY_BACKGROUND, DUSK_BACKGROUND, warm);
  const background = lerp3(NIGHT.background, dayBg, day);
  const ground = lerp3(NIGHT.ground, DAY_GROUND, day);
  return { elevation: el, day, direct, high, sun, sunIntensity, sky, bounce, fill, background, ground };
}

// ---- Window sun pools --------------------------------------------------------

/**
 * Project a world point along the sun ray down to the plane y = floorY.
 * `toSun` is the unit vector toward the sun (sunDirection()); light travels
 * along -toSun. Returns [x, z].
 */
export function projectToFloor(p, toSun, floorY) {
  const t = (p[1] - floorY) / toSun[1];
  return [p[0] - toSun[0] * t, p[2] - toSun[2] * t];
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Sutherland-Hodgman: clip `subject` (any simple polygon) by `clip`, which
 * MUST be convex. Points are [x, z]. Returns the clipped polygon (possibly
 * empty). A concave subject (an L-shaped room) is fine; the clip side is the
 * convex window pool.
 */
export function clipPolygon(subject, clip) {
  if (clip.length < 3 || subject.length < 3) return [];
  const s = signedArea(clip) >= 0 ? 1 : -1;
  const inside = (p, a, b) => s * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= -1e-9;
  const cross = (p, q, a, b) => {
    const a1 = b[1] - a[1], b1 = a[0] - b[0], c1 = a1 * a[0] + b1 * a[1];
    const a2 = q[1] - p[1], b2 = p[0] - q[0], c2 = a2 * p[0] + b2 * p[1];
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-12) return p.slice();
    return [(b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det];
  };
  let out = subject.slice();
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const pin = inside(p, a, b), qin = inside(q, a, b);
      if (pin) {
        out.push(p);
        if (!qin) out.push(cross(p, q, a, b));
      } else if (qin) {
        out.push(cross(p, q, a, b));
      }
    }
  }
  return out;
}

export function polygonArea(poly) {
  return Math.abs(signedArea(poly));
}

/**
 * The patch of floor a window's direct sun lands on.
 *
 * @param {object} o
 * @param {number[][]} o.outer  the opening's 4 corners on the OUTSIDE face of
 *                              the wall, world [x, y, z], in order round the rect
 * @param {number[][]} o.inner  the same 4 corners on the ROOM face
 * @param {number[]} o.inward   world [x, z] unit vector pointing into the room
 * @param {number[]} o.toSun    sunDirection()
 * @param {number[][]} o.room   the room's floor polygon, world [x, z]
 * @param {number} [o.floorY=0]
 * @returns {number[][]|null} the lit polygon on the floor ([x, z] points), or
 *   null when no direct sun comes in through this window: the sun is down, or
 *   on the far side of this wall.
 *
 * Sun through a hole in a thick wall is the part of BOTH faces' shadows that
 * overlaps -- the reveal shades one side of the pool when the sun is oblique --
 * so the two projected faces are intersected, then clipped to the room so a
 * pool never runs through a wall into the next room.
 */
export function windowSunPool(o) {
  const toSun = o.toSun, floorY = o.floorY || 0;
  if (!(toSun[1] > 0.02)) return null;
  // The sun must be OUTSIDE: light travels along -toSun, which must point
  // into the room.
  const inDot = -(toSun[0] * o.inward[0] + toSun[2] * o.inward[1]);
  if (!(inDot > 1e-3)) return null;
  const pOut = o.outer.map(p => projectToFloor(p, toSun, floorY));
  const pIn = o.inner.map(p => projectToFloor(p, toSun, floorY));
  const beam = clipPolygon(pOut, pIn);   // both are parallelograms: convex
  if (beam.length < 3 || polygonArea(beam) < 1e-4) return null;
  const lit = clipPolygon(o.room, beam);
  if (lit.length < 3 || polygonArea(lit) < 1e-4) return null;
  return lit;
}

/**
 * The ?time= / &date= URL override, as a Date in the viewer's local time, or
 * null when neither is given or either is malformed (a bad value is ignored,
 * never guessed at).
 *
 *   time  HH:MM, 24-hour (e.g. 09:00, 17:45). Alone: that time today.
 *   date  YYYY-MM-DD. Alone: that day at the current clock time.
 */
export function parseSunTime(time, date, now) {
  const base = now ? new Date(now.getTime()) : new Date();
  if (!time && !date) return null;
  let y = base.getFullYear(), mo = base.getMonth(), d = base.getDate();
  let h = base.getHours(), mi = base.getMinutes();
  if (date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    if (!m) return null;
    y = +m[1]; mo = +m[2] - 1; d = +m[3];
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  }
  if (time) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(time));
    if (!m) return null;
    h = +m[1]; mi = +m[2];
    if (h > 23 || mi > 59) return null;
  }
  const out = new Date(y, mo, d, h, mi, 0, 0);
  // Reject a day the month does not have (2026-02-30 rolls into March).
  if (out.getDate() !== d || out.getMonth() !== mo) return null;
  return out;
}
