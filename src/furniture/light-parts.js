/**
 * light-parts.js - furniture parts that follow a room light channel.
 *
 * A builder can hand the scene a part that shows a light: a bedside table's
 * drawer-level LED strip and the glow it throws on the drawer front below
 * (cabinet.js, a channel row with `light`). Such a part is a DYNAMIC part
 * (userData.dynamic, never merged -- see merge.js) and carries:
 *
 *   userData.lightChannel  the room light channel it follows ('bedside_top')
 *   userData.lightRole     'strip' -- the LED line itself: shown in the
 *                                     light's colour when on, HIDDEN when off
 *                                     (off leaves just the recess)
 *                          'glow'  -- a band of a front lit by the strip: the
 *                                     light's colour over the front's own
 *                                     colour, stronger with brightness; off,
 *                                     it is plain front again
 *   userData.baseColor     'glow' only: the front's own colour ('#rrggbb')
 *   userData.wash          'glow' only, optional: the part is a WASH -- an
 *                          unlit, vertex-alpha gradient quad over the front
 *                          (cabinet.js addLeaf). On: the light's colour at
 *                          WASH_MAX_OPACITY x brightness; off: hidden.
 *
 * The scene (home3d-scene.js syncLights) calls applyLightPart() for every
 * such part of an item in a room, with that room's channel state
 * { on, bri (0-100), color '#rrggbb' } -- the same state the channel's real
 * light (a room light fixture on that channel) follows. No DOM, no THREE
 * import: materials are driven through their own Color objects, so
 * scripts/test-bedside-strip-channels.mjs drives it directly.
 */

/** How much of the light's colour a lit glow band shows at full brightness. */
export const GLOW_SHARE = 0.55;
/** A lit wash's opacity at full brightness (its gradient fades it from there). */
export const WASH_MAX_OPACITY = 0.85;
/** ...and never below this share of it while on (a dimmed LED still washes). */
export const WASH_MIN_SHARE = 0.2;
/** A lit strip's emissive intensity never drops below this (a dimmed LED still reads as lit). */
export const STRIP_MIN_INTENSITY = 0.25;

const hexToRgb = h => {
  const n = parseInt(String(h || '').replace('#', ''), 16);
  return isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
};
const rgbToHex = c => '#' + c.map(v => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2)).join('');

/** '#rrggbb' of a glow band: `share` of the light's colour over the front's colour. */
export function glowColour(light, base, share) {
  const a = hexToRgb(light), b = hexToRgb(base);
  return rgbToHex(a.map((v, i) => v * share + b[i] * (1 - share)));
}

/** Is this mesh a part that follows a light channel? */
export function isLightPart(mesh) {
  return !!(mesh && mesh.userData && mesh.userData.lightChannel && mesh.userData.lightRole);
}

/**
 * Pose one light-following part for a channel state. Returns false (and
 * touches nothing) for a mesh that is not a light part or a missing state.
 */
export function applyLightPart(mesh, state) {
  if (!isLightPart(mesh) || !state) return false;
  const m = mesh.material;
  const on = !!state.on;
  const k = on ? Math.max(0, Math.min(100, Number(state.bri) || 0)) / 100 : 0;
  if (mesh.userData.lightRole === 'strip') {
    mesh.visible = on;
    if (on) {
      m.color.set(state.color);
      m.emissive.set(state.color);
      m.emissiveIntensity = Math.max(STRIP_MIN_INTENSITY, k);
    }
    return true;
  }
  if (mesh.userData.lightRole === 'glow' && mesh.userData.wash) {
    mesh.visible = on && k > 0;
    if (mesh.visible) {
      m.color.set(state.color);
      m.opacity = WASH_MAX_OPACITY * (WASH_MIN_SHARE + (1 - WASH_MIN_SHARE) * k);
    }
    return true;
  }
  if (mesh.userData.lightRole === 'glow') {
    const base = mesh.userData.baseColor || '#ffffff';
    if (on && k > 0) {
      const c = glowColour(state.color, base, GLOW_SHARE * k);
      m.color.set(c);
      m.emissive.set(c);
      m.emissiveIntensity = 0.35 + 0.65 * k;
    } else {
      m.color.set(base);
      m.emissive.set('#000000');
      m.emissiveIntensity = 0;
    }
    return true;
  }
  return false;
}
