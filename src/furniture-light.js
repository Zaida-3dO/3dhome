/**
 * furniture-light.js - a furniture item whose glowing parts follow a light.
 *
 * The binding lives in rooms.json, beside the cornice lights, because an
 * entity id is runtime config and never part of a house's geometry:
 *
 *   "sensors": { "furnitureLights": { "<furniture item id>": ["<light entity>"] } }
 *
 * ha-client indexes it as its `furnitureLight` fitting kind and fires
 * onFurnitureLightChange(itemId, { on, bri, color }) on a real change. The
 * scene paints that onto the item's bound parts with lightLook() and
 * applyLightLook(). Which parts: those the builder tagged
 * `userData.ledStrip` (a standing desk's LED strip) when it tagged any,
 * otherwise every emissive part.
 *
 * Emissive only, by design: a bound item never adds a real light (perf
 * budget -- a light per desk is a fragment-uniform cost on every pixel).
 *
 * Pure ESM, no THREE import: materials are driven through their own
 * .color/.emissive objects, so the Node tests run the same code the scene does.
 */

/** What an "off" strip reads as: a dim grey line, not a coloured one (the
 * same rule the cornice strip follows). */
export const OFF_COLOR = '#2a2a2a';
/** Brightness floor while on, so 1% still reads as lit (cornice rule). */
export const MIN_ON_LEVEL = 0.05;
/** An ambient fixture mounted lower than this (cm) is on the floor. */
export const FLOOR_LEVEL_MAX_CM = 50;

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * The look a light state gives a bound part.
 *
 * @param {?{on, bri, color}} state  bri 0..100; color '#rrggbb' or null. null
 *        state = no reading yet: the part shows its authored rest colour, lit.
 * @param {string} restColor '#rrggbb' -- the builder's own colour (ledColor)
 * @returns {{ on: boolean, level: number, color: string, shown: string }}
 *   level 0..1 (0 when off); color is the light's hue; shown is what the
 *   part should actually display (the hue scaled by level, or OFF_COLOR).
 */
export function lightLook(state, restColor) {
  const rest = HEX6.test(restColor || '') ? restColor.toLowerCase() : '#ffffff';
  if (!state) return { on: true, level: 1, color: rest, shown: rest };
  const on = !!state.on;
  const bri = state.bri != null && isFinite(+state.bri) ? +state.bri : 100;
  const color = HEX6.test(state.color || '') ? state.color.toLowerCase() : rest;
  const level = on ? Math.max(MIN_ON_LEVEL, Math.min(1, bri / 100)) : 0;
  return { on, level, color, shown: on ? scaleHex(color, level) : OFF_COLOR };
}

/** '#rrggbb' * k (0..1), rounded, as '#rrggbb'. */
export function scaleHex(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.round(v * k));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * The parts of a built item a binding drives: the builder's ledStrip-tagged
 * meshes if it tagged any, else every mesh with an emissive material.
 */
export function boundParts(meshes) {
  const list = (meshes || []).filter(m => m && m.material);
  const tagged = list.filter(m => m.userData && m.userData.ledStrip);
  if (tagged.length) return tagged;
  return list.filter(m => {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    return mat && mat.userData && mat.userData.finish === 'emissive';
  });
}

/**
 * Paint a look onto meshes. Works for both material kinds a glowing part can
 * end up with: a lit emissive MeshStandardMaterial (emissive = the hue,
 * emissiveIntensity = level, base colour = the hue, or grey when off) and an
 * unlit MeshBasicMaterial (colour = what is shown). Returns true if anything
 * changed, so the caller requests a frame only on a real change.
 */
export function applyLightLook(meshes, look) {
  let changed = false;
  (meshes || []).forEach(m => {
    (Array.isArray(m.material) ? m.material : [m.material]).forEach(mat => {
      if (!mat || !mat.color) return;
      if (mat.emissive) {
        const base = look.on ? look.color : OFF_COLOR;
        const emi = look.on ? look.color : '#000000';
        if (hexOf(mat.color) !== base) { mat.color.set(base); changed = true; }
        if (hexOf(mat.emissive) !== emi) { mat.emissive.set(emi); changed = true; }
        if (mat.emissiveIntensity !== look.level) { mat.emissiveIntensity = look.level; changed = true; }
      } else if (hexOf(mat.color) !== look.shown) {
        mat.color.set(look.shown);
        changed = true;
      }
    });
  });
  return changed;
}

function hexOf(c) {
  return c && typeof c.getHexString === 'function' ? '#' + c.getHexString() : null;
}

/**
 * Everything that glows as a room's AMBIENT light, from the two profile files
 * as authored (no WebGL): what a reviewer, a test or a private-house check can
 * count without rendering.
 *
 *   emitters       [{ kind: 'fixture'|'cornice'|'furniture', id, entities }]
 *                  -- one per ambient fixture position in geometry.lights, one
 *                  per lit cornice, one per furniture item with an LED strip.
 *                  `entities` is what it follows: a fixture follows the room's
 *                  ambient channel, a cornice its corniceLights entry, a
 *                  furniture strip its furnitureLights entry ([] if unbound).
 *   floorFixtures  the ambient fixture positions below FLOOR_LEVEL_MAX_CM
 *   ambientRows    how many Ambient rows the sidebar shows (0 or 1)
 *
 * @param {Object} geometry  geometry.json as parsed
 * @param {?Object} roomsDoc rooms.json as parsed (null when absent)
 * @param {string} roomId
 * @param {function(?Object, string, boolean): boolean} hasAmbientRow  from room-panel.js
 */
export function roomAmbientSummary(geometry, roomsDoc, roomId, hasAmbientRow) {
  const g = geometry || {};
  const rooms = roomsDoc && roomsDoc.rooms ? roomsDoc.rooms : null;
  const sensors = (roomsDoc && roomsDoc.sensors) || {};
  const channelEntities = (rooms && rooms[roomId] && rooms[roomId].ambient) || [];
  const emitters = [], floorFixtures = [];
  let hasGeometryChannel = false;
  (g.lights || []).filter(l => l.room === roomId).forEach(l => {
    (l.fixtures || []).filter(f => f.channel === 'ambient').forEach(f => {
      hasGeometryChannel = true;
      (f.positions || []).forEach((pos, i) => {
        const id = pos.label || ('ambient#' + i);
        emitters.push({ kind: 'fixture', id, entities: channelEntities.slice() });
        if (pos.heightCm != null && pos.heightCm < FLOOR_LEVEL_MAX_CM) floorFixtures.push({ id, heightCm: pos.heightCm, at: pos.at });
      });
    });
  });
  (g.curtains || []).filter(c => c.room === roomId).forEach(c => {
    // A curtain has a lit cornice unless it says otherwise (house-loader's
    // own defaults: an absent `cornice` is a default cornice, lit).
    const cn = c.cornice || {};
    if (cn.enabled === false || cn.light === false) return;
    emitters.push({ kind: 'cornice', id: c.id, entities: ((sensors.corniceLights || {})[c.id] || []).slice() });
  });
  (g.furniture || []).filter(f => f.room === roomId).forEach(f => {
    if (!(f.params && f.params.ledStrip)) return;
    emitters.push({ kind: 'furniture', id: f.id, entities: ((sensors.furnitureLights || {})[f.id] || []).slice() });
  });
  return { emitters, floorFixtures, ambientRows: hasAmbientRow(rooms, roomId, hasGeometryChannel) ? 1 : 0 };
}
