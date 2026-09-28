// render-rig.js -- the ONE lighting and render setup, shared by the house and
// the spec pages.
//
// The live house (src/home3d-scene.js) and every spec page's viewer
// (specs/spec-three.jsx) light a model with what is in this file and nothing
// else: the renderer's tone mapping, exposure, colour space and shadow type;
// the sun (a shadow-casting directional light) and the hemisphere sky fill,
// placed from the time of day by src/sun-position.js; the generic room light
// a spec page switches on at night, built as the house builds a room's; and
// the no-environment-map finish look (src/furniture/finishes.js). A spec page
// therefore shows an item as it will look in the house, and the two cannot
// drift apart: changing a number here changes both.
//
// The one deliberate difference is the SUN'S SHADOW FRUSTUM. The house fits it
// to the house (+-15 m about its centre, as it always has); a spec page fits it
// tightly round the item (fitSunShadow below). The shadow SETTINGS -- map size,
// depth bias, normal bias, near/far and the sun's distance -- are the same
// object for both, so the depth bias is the same few centimetres in the world
// and contact shadows are as strong on a spec page as in the house.
//
// Pure ESM with THREE injected -- no `import 'three'` -- the same convention as
// src/furniture/*, so the house (ES module, import map), the spec pages
// (classic Babel scripts, loaded by dynamic import()) and the Node tests all
// load this exact file.

import { solarPosition, solarNoon, sunDirection, daylightCurve, NIGHT } from './sun-position.js';
import { liveFinishParams, partFinish } from './furniture/finishes.js';
import { collapseEmitters } from './light-merge.js';
// The house's floor and wall finishes, for spec-page backdrops (re-exported so
// the spec harness loads one module).
export { ROOM_FINISH, makeFloorMaterial, makeWallMaterial, applyRoomBackdrops } from './room-finishes.js';

// ---- Renderer ---------------------------------------------------------------

/**
 * Renderer settings. `shadowMapType` and `outputColorSpace` are three r160's
 * own defaults (the house never set them); they are written out here so a spec
 * page cannot quietly differ (the spec viewer used PCFSoft before).
 */
export const RENDER = Object.freeze({
  toneMapping: 'ACESFilmicToneMapping',
  toneMappingExposure: 0.85,
  outputColorSpace: 'SRGBColorSpace',
  shadowMapType: 'PCFShadowMap'
});

/** Apply RENDER to a WebGLRenderer. Does not touch shadowMap.enabled. */
export function applyRendererSettings(THREE, renderer) {
  renderer.toneMapping = THREE[RENDER.toneMapping];
  renderer.toneMappingExposure = RENDER.toneMappingExposure;
  renderer.outputColorSpace = THREE[RENDER.outputColorSpace];
  renderer.shadowMap.type = THREE[RENDER.shadowMapType];
  return renderer;
}

// ---- Sun + sky --------------------------------------------------------------

/** The sky fill and the sun as first built (updateSunlight() then moves them). */
export const SKY = Object.freeze({
  hemiSky: 0xd9d9e6,
  hemiGround: 0xd9d9e6,
  hemiIntensity: 0.12,
  sunColor: 0xffeedd,
  sunIntensity: 0.25
});

/**
 * The sun's shadow. `halfExtent` is the HOUSE frustum (+-15 m about the house
 * centre); a spec page replaces only left/right/top/bottom (fitSunShadow).
 * `lightDistance` is how far from the target the light is placed along the
 * sun direction: with near/far this fixes the depth range (39.5 m), and so what
 * `bias` means in metres (~2 cm), for the house and the spec pages alike.
 */
export const SUN_SHADOW = Object.freeze({
  mapSize: 2048,
  bias: -0.0005,
  normalBias: 0,
  near: 0.5,
  far: 40,
  halfExtent: 15,
  lightDistance: 25
});

/**
 * Build the hemisphere sky fill and the sun. Nothing is added to a scene: the
 * caller adds them (the house adds hemi, then sun.target, then sun -- light
 * order is shader uniform order, so it is kept).
 *
 * @param {Object} THREE
 * @param {{castShadow?: boolean, shadowMapScale?: number}} [opts]
 * @returns {{hemi: THREE.HemisphereLight, sun: THREE.DirectionalLight}}
 */
export function createSkyRig(THREE, opts) {
  const o = opts || {};
  const smScale = o.shadowMapScale || 1;
  const hemi = new THREE.HemisphereLight(SKY.hemiSky, SKY.hemiGround, SKY.hemiIntensity);
  const sun = new THREE.DirectionalLight(SKY.sunColor, SKY.sunIntensity);
  sun.castShadow = !!o.castShadow;
  sun.shadow.mapSize.width = Math.round(SUN_SHADOW.mapSize * smScale);
  sun.shadow.mapSize.height = Math.round(SUN_SHADOW.mapSize * smScale);
  const c = sun.shadow.camera;
  c.left = -SUN_SHADOW.halfExtent;
  c.right = SUN_SHADOW.halfExtent;
  c.top = SUN_SHADOW.halfExtent;
  c.bottom = -SUN_SHADOW.halfExtent;
  c.near = SUN_SHADOW.near;
  c.far = SUN_SHADOW.far;
  sun.shadow.bias = SUN_SHADOW.bias;
  sun.shadow.normalBias = SUN_SHADOW.normalBias;
  return { hemi, sun };
}

/** The time-of-day presets, in the order a control lists them. */
export const SUN_PRESETS = Object.freeze(['morning', 'noon', 'evening', 'night']);

/** Preset suns for a place with no `site` (and so for every spec page). */
export const NO_SITE_PRESETS = Object.freeze({
  morning: Object.freeze({ azimuth: 110, elevation: 16 }),
  noon: Object.freeze({ azimuth: 180, elevation: 50 }),
  evening: Object.freeze({ azimuth: 250, elevation: 16 })
});

/** Hours either side of solar noon for the morning and evening presets. */
export const PRESET_OFFSET_HOURS = 3.5;

/**
 * Where a named preset puts the sun, or null when `mode` is not a preset
 * ('auto', or anything unknown -- the caller then follows the clock).
 *
 * @param {string} mode  'morning' | 'noon' | 'evening' | 'night'
 * @param {{hasSite?: boolean, latitude?: number, longitude?: number, now?: Date}} [place]
 * @returns {?{azimuth: number, elevation: number, source: 'preset'}}
 */
export function presetSun(mode, place) {
  const p = place || {};
  if (mode === 'night') return { azimuth: 0, elevation: -20, source: 'preset' };
  if (mode !== 'morning' && mode !== 'noon' && mode !== 'evening') return null;
  if (!p.hasSite) {
    const s = NO_SITE_PRESETS[mode];
    return { azimuth: s.azimuth, elevation: s.elevation, source: 'preset' };
  }
  // Solar noon, or PRESET_OFFSET_HOURS either side of it: the same sun
  // whatever clock the viewer is on.
  const noon = solarNoon(p.now || new Date(), p.longitude);
  const shift = mode === 'noon' ? 0 : (mode === 'morning' ? -1 : 1) * PRESET_OFFSET_HOURS * 3600000;
  const at = shift ? new Date(noon.getTime() + shift) : noon;
  return Object.assign(solarPosition(at, p.latitude, p.longitude), { source: 'preset' });
}

/**
 * Light the sun and sky for a sun position. Sets the sun's direction,
 * intensity and colour and the hemisphere's colours and intensity; returns the
 * daylightCurve() it used, for the caller's own background, ground and window
 * light.
 *
 * `shadowed` is whether the sun is really casting shadows. Without them nothing
 * stops a low sun lighting walls from behind, so it is held steep (60 deg);
 * with them it is held above 3 deg, so the shadow camera is never edge-on.
 *
 * @param {{hemi, sun}} rig  createSkyRig()
 * @param {{azimuth: number, elevation: number}} s
 * @param {{northOffset?: number, centre?: number[], shadowed?: boolean}} [opts]
 *   centre is [x, z] in world metres (the sun's target, on y = 0)
 */
export function applyDaylight(rig, s, opts) {
  const o = opts || {};
  const cx = o.centre ? o.centre[0] : 0, cz = o.centre ? o.centre[1] : 0;
  const c = daylightCurve(s.elevation);
  const lightEl = o.shadowed ? Math.max(s.elevation, 3) : Math.max(s.elevation, 60);
  const ld = sunDirection(s.azimuth, lightEl, o.northOffset || 0);
  const d = SUN_SHADOW.lightDistance;
  rig.sun.position.set(cx + ld[0] * d, ld[1] * d, cz + ld[2] * d);
  rig.sun.intensity = c.sunIntensity;
  rig.sun.color.setRGB(c.sun[0], c.sun[1], c.sun[2]);
  rig.hemi.intensity = c.fill;
  rig.hemi.color.setRGB(c.sky[0], c.sky[1], c.sky[2]);
  rig.hemi.groundColor.setRGB(c.bounce[0], c.bounce[1], c.bounce[2]);
  return c;
}

/** The sun switched off: no sun, the night sky fill (NIGHT). */
export function applyNight(rig) {
  rig.sun.intensity = 0;
  rig.hemi.intensity = NIGHT.fill;
  rig.hemi.color.setRGB(NIGHT.fillColor[0], NIGHT.fillColor[1], NIGHT.fillColor[2]);
  rig.hemi.groundColor.copy(rig.hemi.color);
}

// ---- Spec-page sun shadow frustum -------------------------------------------

/** Margin round the fitted frustum (m). */
export const SHADOW_FIT_MARGIN = 0.05;

/**
 * Fit the sun's orthographic shadow camera tightly round `points` -- the
 * corners of every shadow-casting box. Only left/right/top/bottom change;
 * near, far and the bias are SUN_SHADOW's, as in the house. The shadows the
 * casters throw need no extra room: a shadow lies along the sun ray from its
 * caster, i.e. straight down the light's view axis, so it has the caster's
 * own light-space x and y (only its depth differs, and near/far span 39.5 m).
 * Pure maths on the light's view basis (the same lookAt, up = +y, that
 * three's DirectionalLightShadow uses), so it runs in Node too.
 *
 * @param {Object} sun      a DirectionalLight whose position/target are set
 * @param {number[][]} points  world [x, y, z]
 * @param {{margin?: number}} [opts]
 * @returns {{left, right, top, bottom}}  what was written to the camera
 */
export function fitSunShadow(sun, points, opts) {
  const o = opts || {};
  const margin = o.margin != null ? o.margin : SHADOW_FIT_MARGIN;
  const p0 = sun.position, t0 = sun.target.position;
  // Light-view basis: forward f (light -> target), right r = f x up, up u = r x f.
  let fx = t0.x - p0.x, fy = t0.y - p0.y, fz = t0.z - p0.z;
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = -fz, rz = fx; // f x (0,1,0)
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-6) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const add = (x, y, z) => {
    const dx = x - p0.x, dy = y - p0.y, dz = z - p0.z;
    const a = dx * rx + dz * rz, b = dx * ux + dy * uy + dz * uz;
    if (a < minX) minX = a; if (a > maxX) maxX = a;
    if (b < minY) minY = b; if (b > maxY) maxY = b;
  };
  for (const p of points) add(p[0], p[1], p[2]);
  const cam = sun.shadow.camera;
  if (!(minX <= maxX)) {
    minX = minY = -SUN_SHADOW.halfExtent; maxX = maxY = SUN_SHADOW.halfExtent;
  }
  cam.left = minX - margin; cam.right = maxX + margin;
  cam.bottom = minY - margin; cam.top = maxY + margin;
  cam.near = SUN_SHADOW.near; cam.far = SUN_SHADOW.far;
  if (cam.updateProjectionMatrix) cam.updateProjectionMatrix();
  return { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom };
}

// ---- Room lights ------------------------------------------------------------

/** A colour temperature (K) as the hex a room light is drawn in. */
export function kelvinToHex(k) {
  const t = Math.max(0, Math.min(1, (k - 2700) / 3800));
  return (Math.round(255 - t * 30) << 16) | (Math.round(215 + t * 30) << 8) | Math.round(160 + t * 90);
}

/**
 * A room's lights. `mainGain` is a main-channel light's intensity per fixture
 * at 100% brightness (syncLights: bri/100 * mainGain * gain). The shadow
 * spot is the invisible downward light that gives a room its wall and floor
 * occlusion; its `intensity`/`color` are only its build values -- syncLights
 * drives it with the main channel.
 */
export const ROOM_LIGHT = Object.freeze({
  mainGain: 0.6,
  defaultTemp: 4000,
  downlightDistanceK: 1.8,  // x the room's longer side
  downlightDecay: 1.8,
  downlightDrop: 0.08,      // below the ceiling
  // A room's spot cluster shares ONE PointLight (home3d-scene.js addSpotMesh):
  spotClusterDistanceK: 2,  // x the room's longer side
  spotClusterDecay: 1.5,
  spotClusterDrop: 0.18,    // below the ceiling
  shadow: Object.freeze({
    color: 0xfff4cc,
    intensity: 0.4,
    rangeK: 1.2,            // x the room's longer side
    drop: 0.15,             // below the ceiling
    maxAngle: 1.40,
    penumbra: 0.8,
    decay: 1.5,
    mapSize: 1024,
    bias: -0.0008,
    near: 0.1
  })
});

/**
 * The room shadow light, exactly as the house builds one per room: a downward
 * SpotLight at the ceiling over (cx, cz), its cone covering the room's
 * w x d floor plan. Not added to a scene; its target must be (three reads
 * target.matrixWorld).
 */
export function createRoomShadowLight(THREE, o) {
  const S = ROOM_LIGHT.shadow;
  const floorY = o.floorY || 0;
  const smScale = o.shadowMapScale || 1;
  const range = Math.max(o.w, o.d) * S.rangeK;
  const spotY = floorY + o.ceiling - S.drop;
  const halfDiag = Math.sqrt(o.w * o.w + o.d * o.d) / 2;
  const angle = Math.min(Math.atan2(halfDiag * 1.15, spotY), S.maxAngle);
  const l = new THREE.SpotLight(S.color, S.intensity, range, angle, S.penumbra, S.decay);
  l.position.set(o.cx, spotY, o.cz);
  l.target.position.set(o.cx, floorY, o.cz);
  l.castShadow = true;
  l.shadow.mapSize.width = Math.round(S.mapSize * smScale);
  l.shadow.mapSize.height = Math.round(S.mapSize * smScale);
  l.shadow.bias = S.bias;
  l.shadow.camera.near = S.near;
  l.shadow.camera.far = range;
  return l;
}

/**
 * The rooms a spec page's item can stand in at night: the house's two kinds
 * of room lighting, laid out as the house lays them out relative to its
 * furniture, with the item's front face at z = 0 facing +z and its centre at
 * x = 0. Lights directly OVER the item would leave every front face unlit
 * (review 88739b91); a real room's lights hang in front of it.
 *
 *   spots      one ceiling spot cluster, which the house lights with ONE
 *              PointLight (home3d-scene.js addSpotMesh), 1.0 m in front of
 *              the item and 0.9 m aside -- a bedroom's main light relative
 *              to its bedside table.
 *   downlights six flush downlights on a 2 x 3 grid (1.3 m out from the
 *              wall, 1.35 m along it), merged by collapseEmitters exactly as
 *              the house merges a channel's fixtures -- a living room's main
 *              light relative to its TV console.
 *
 * Both are 2.5 m high, with the room shadow spot at the room centre. All
 * figures are illustrative round numbers for a typical room.
 */
export const GENERIC_ROOMS = Object.freeze({
  spots: Object.freeze({ w: 2.8, d: 4.4, ceiling: 2.5, centre: Object.freeze([0.9, 1.0]),
    // the room's floor, relative to the item: x along the wall, z out from it
    box: Object.freeze([-1.3, 3.1, -0.4, 2.4]) }),
  downlights: Object.freeze({ w: 3.4, d: 4.4, ceiling: 2.5, centre: Object.freeze([0, 1.3]),
    box: Object.freeze([-2.2, 2.2, -0.4, 3.0]),
    grid: Object.freeze({ along: Object.freeze([-1.35, 0, 1.35]), out: Object.freeze([0.55, 1.85]) }) })
});
export const GENERIC_ROOM_KINDS = Object.freeze(Object.keys(GENERIC_ROOMS));

/**
 * A spec page's night room lights, built exactly as the house builds a room's
 * main channel and driven as syncLights drives it (ON at `bri`%, `temp` K):
 * the room's main light(s) and the room shadow spot. Positions are relative
 * to the item (front face at z = 0, centre x = 0); placeGenericRoomLights
 * moves them onto the item. Not added to a scene.
 * @param {string} [o.kind]  'spots' (default) | 'downlights'
 * @returns {Array<THREE.Light>}  main light(s), then the shadow spot
 */
export function createGenericRoomLights(THREE, o) {
  const p = Object.assign({ kind: 'spots', temp: ROOM_LIGHT.defaultTemp, bri: 100 }, o || {});
  const room = GENERIC_ROOMS[p.kind] || GENERIC_ROOMS.spots;
  const col = kelvinToHex(p.temp);
  const mb = p.bri / 100;
  const long = Math.max(room.w, room.d);
  const lights = [];
  if (room.grid) {
    const emitters = [];
    for (const x of room.grid.along) for (const z of room.grid.out) {
      emitters.push({ x, y: room.ceiling - ROOM_LIGHT.downlightDrop, z, intensity: 1,
        distance: long * ROOM_LIGHT.downlightDistanceK, decay: ROOM_LIGHT.downlightDecay });
    }
    const [x0, x1, z0, z1] = room.box;
    collapseEmitters(emitters, { minX: x0, maxX: x1, minZ: z0, maxZ: z1 }, { merge: true, floorY: 0 }).forEach(m => {
      const l = new THREE.PointLight(col, mb * ROOM_LIGHT.mainGain * m.intensity, m.distance, m.decay);
      l.position.set(m.x, m.y, m.z);
      l.userData.gain = m.intensity;
      lights.push(l);
    });
  } else {
    const l = new THREE.PointLight(col, mb * ROOM_LIGHT.mainGain, long * ROOM_LIGHT.spotClusterDistanceK, ROOM_LIGHT.spotClusterDecay);
    l.position.set(room.centre[0], room.ceiling - ROOM_LIGHT.spotClusterDrop, room.centre[1]);
    lights.push(l);
  }
  const spot = createRoomShadowLight(THREE, { cx: room.centre[0], cz: room.centre[1], w: room.w, d: room.d, ceiling: room.ceiling });
  spot.intensity = mb * ROOM_LIGHT.mainGain;
  spot.color.setHex(col);
  lights.push(spot);
  for (const l of lights) l.userData.rel = [l.position.x, l.position.z];
  return lights;
}

/**
 * Move the generic room's lights onto an item whose front face is at
 * z = frontZ, centred on x = cx. The shadow spot keeps aiming straight down.
 */
export function placeGenericRoomLights(lights, cx, frontZ) {
  for (const l of lights) {
    const r = l.userData.rel || [0, 0];
    l.position.x = cx + r[0]; l.position.z = frontZ + r[1];
    if (l.target) l.target.position.set(l.position.x, l.target.position.y, l.position.z);
  }
}

// ---- Finishes ---------------------------------------------------------------

/**
 * The roughness and metalness the house draws `finish` with: liveFinishParams
 * (no environment map, so metal and mirror are made mostly diffuse) at the
 * 8-bit precision of the palette texture the house's merged furniture reads
 * (src/furniture/merge.js makePaletteTexture).
 */
export function liveFinishTexel(finish) {
  const p = liveFinishParams(finish);
  if (!p) return null;
  const q = v => Math.round((typeof v === 'number' ? v : 0) * 255) / 255;
  return { roughness: q(typeof p.roughness === 'number' ? p.roughness : 1), metalness: q(p.metalness) };
}

/** Finishes the house draws from the palette (never glass or emissive). */
export const LIVE_PALETTE_FINISHES = Object.freeze(['matte', 'gloss', 'satin', 'metal', 'mirror']);

/**
 * Give every palette-finish material under `root` the house's look
 * (liveFinishTexel). A material is changed once (userData.liveFinish records
 * it), so a page that reuses materials across rebuilds is not re-quantised.
 * Materials with no finish tag (hand-made fittings) are left alone, as the
 * house builds those with their own materials too.
 * @returns {number} how many materials were changed
 */
export function applyLiveFinishes(root) {
  let n = 0;
  const seen = new Set();
  root.traverse(o => {
    if (!o.isMesh || !o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m) || !m.isMeshStandardMaterial) continue;
      seen.add(m);
      if (m.userData && m.userData.liveFinish) continue;
      const f = partFinish(o, m).finish;
      if (!f || LIVE_PALETTE_FINISHES.indexOf(f) === -1) continue;
      const t = liveFinishTexel(f);
      m.roughness = t.roughness;
      m.metalness = t.metalness;
      m.userData.liveFinish = f;
      m.needsUpdate = true;
      n++;
    }
  });
  return n;
}
