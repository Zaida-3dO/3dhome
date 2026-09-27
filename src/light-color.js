/**
 * light-color.js -- colour helpers for the accent (ambient) light channels.
 * Pure, no DOM: unit-tested in scripts/test-light-color.mjs.
 *
 * Home Assistant reports a colour light's colour as `rgb_color` ([r, g, b],
 * 0-255) and, depending on the integration and colour mode, `hs_color`
 * ([hue 0-360, saturation 0-100]). A light that is off reports neither. The
 * app keeps colours as '#rrggbb' strings (what <input type="color"> takes).
 */

/** The display default for an accent channel whose colour is unknown -- the
 *  scene's own default (home3d-scene.js lightState), so the swatch matches
 *  the model. A display default, not a fact about the house. */
export const DEFAULT_ACCENT_COLOR = '#ff3300';

/**
 * Channels that carry a colour the user can set: every accent channel
 * except the galaxy projector (whose row has never had one). 'main' is
 * white-tunable (colour temperature), not colour.
 */
export function isColorChannel(channel) {
  return !!channel && channel !== 'main' && channel !== 'galaxy';
}

/** HA colour modes that take a colour (the rest are white-only). */
export const COLOR_MODES = Object.freeze(['hs', 'xy', 'rgb', 'rgbw', 'rgbww']);

/**
 * Can this light entity take a colour? From HA's `supported_color_modes`:
 * true when it lists any of COLOR_MODES. A white-only strip (brightness /
 * color_temp / onoff) gets no colour square.
 *
 * Unknown -- no raw state yet (no Home Assistant configured, or the entity
 * has not reported), or an entity that reports no supported_color_modes --
 * is TRUE: the square stays, as it always has for the ambient row, rather
 * than vanishing on the demo house or before the first snapshot lands.
 *
 * @param attrs  the entity's raw `attributes`, or null
 */
export function supportsColor(attrs) {
  const modes = attrs && attrs.supported_color_modes;
  if (!Array.isArray(modes)) return true;
  return modes.some(m => COLOR_MODES.indexOf(m) !== -1);
}

const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));

/** [r, g, b] -> '#rrggbb', or null for anything that is not three numbers. */
export function rgbToHex(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) return null;
  if (!rgb.slice(0, 3).every(c => typeof c === 'number' && isFinite(c))) return null;
  return '#' + rgb.slice(0, 3).map(c => clamp255(c).toString(16).padStart(2, '0')).join('');
}

/** '#rrggbb' (or '#rgb') -> [r, g, b], or null. */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

/**
 * HA hs_color -> [r, g, b] at full value (HA's own convention: brightness is
 * a separate attribute). Hue wraps; saturation clamps to 0-100.
 */
export function hsToRgb(hue, sat) {
  if (typeof hue !== 'number' || typeof sat !== 'number' || !isFinite(hue) || !isFinite(sat)) return null;
  const h = ((hue % 360) + 360) % 360 / 60;
  const s = Math.max(0, Math.min(100, sat)) / 100;
  const c = s;                      // chroma at value 1
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = 1 - c;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m].map(v => clamp255(v * 255));
}

/**
 * A light entity's attributes -> '#rrggbb', or null when it reports no
 * colour (off, or a white-only light). rgb_color wins; hs_color is the
 * fallback.
 */
export function colorFromAttributes(attrs) {
  const a = attrs || {};
  const fromRgb = rgbToHex(a.rgb_color);
  if (fromRgb) return fromRgb;
  if (Array.isArray(a.hs_color) && a.hs_color.length >= 2) {
    const rgb = hsToRgb(a.hs_color[0], a.hs_color[1]);
    if (rgb) return rgbToHex(rgb);
  }
  return null;
}

/**
 * What the colour square shows: the channel's current colour, normalised to
 * the lowercase '#rrggbb' an <input type="color"> requires (it silently
 * shows black for anything else), or the default when it is unknown.
 */
export function swatchColor(color) {
  const rgb = hexToRgb(color);
  return rgb ? rgbToHex(rgb) : DEFAULT_ACCENT_COLOR;
}
