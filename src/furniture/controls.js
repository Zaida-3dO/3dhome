/**
 * controls.js - machine-readable control descriptors for a furniture type.
 *
 * WHY. A builder's DEFAULTS say what a parameter IS; they do not say how far it
 * may be dragged. Until now the slider ranges lived only in the JSX of
 * specs/<Type>Spec.html (TweakSlider / TweakColor / TweakSelect). Edit mode
 * needs them as data, so each builder may export
 *
 *     export const CONTROLS = [ { key, kind, label, ... }, ... ];
 *
 * copied from its spec page, and this PURE module turns (type, DEFAULTS,
 * CONTROLS) into the complete list: the explicit CONTROLS first, in their
 * own order, then an auto-derived fallback for every DEFAULTS key they do not
 * cover. No THREE, no DOM, no I/O.
 *
 * A control descriptor
 *
 *   key      the params key (always a key of DEFAULTS)
 *   kind     'range' | 'color' | 'select' | 'toggle' | 'text' | 'unsupported'
 *   label    human label
 *   range    min, max, step (> 0), optional unit ('cm', '°', '%')
 *   select   options: [ 'a', 'b' ] or [ { value, label } ]  (default is one)
 *   unsupported  reason: 'array' | 'object' | 'null'  (a nested or untyped param)
 *                'derived'  (an output of other params, e.g. an envelope)
 *                'coupled'  (only meaningful together with other params)
 *                'fixed'    (a measured constant the spec page does not expose)
 *   mirror   optional, on a range: other keys to set to the same value (a round
 *            table's one Diameter slider sets both width and depth)
 *
 * Declaring CONTROLS never changes what a builder renders: this file only
 * describes, it is never read by build().
 *
 * AUTO-DERIVED FALLBACKS (plan-review amendment 14)
 *
 *   number, default d > 0   0.5 x d .. 2 x d
 *   number, d === 0         an absolute 0..100 (counts: 0..10)
 *   number, d < 0           symmetric: -2|d| .. 2|d| (a bare 0.5x..2x would
 *                           INVERT, min > max)
 *   count-like key          integer step 1, whole-number min/max. Count-like:
 *                           `count`, `n`, `num*`, `*Count`, `*Counts`, or
 *                           any integer-valued default.
 *   angle-like key          -180..180, step 1, unit '°'. Angle-like:
 *                           deg / angle / yaw / rotation / lean / tilt /
 *                           recline anywhere in the key (widened to still
 *                           contain a default outside +-180).
 *   non-integer default     step 0.1 (0.5 from 10 up, 0.01 below 1)
 *   '#rrggbb' string        a colour
 *   boolean                 a toggle
 *   string with a finish-   a select of the hand-switchable finishes (the
 *   like key (finish,       palette minus glass / mirror / emissive, plus the
 *   *Finish) and a palette  default if it is one of those)
 *   default
 *   any other string        free text
 *   array / object          { kind: 'unsupported', reason }. NOT flattened:
 *                           a nested structure (kitchen modules, cabinet
 *                           fronts, colour lists) needs its own editor, and a
 *                           flat slider list for it would be a lie.
 *   null                    { kind: 'unsupported', reason: 'null' }: the type
 *                           of a null default is unknowable (src, image...).
 *
 * In every derived range min <= default <= max and step > 0 (the tests pin it).
 */

import { FINISHES, KEEP_FINISHES } from './finishes.js';

// The finishes a surface may be switched between by hand. glass / mirror /
// emissive are excluded: they are "kept" finishes (never merged into the house
// palette mesh) and a builder only tags its parts keep:true where it MEANS
// glass, so offering them for, say, a leg finish would hand the merge a part
// it must not fold. A default that is itself one of them stays selectable.
const SELECTABLE_FINISHES = FINISHES.filter(f => KEEP_FINISHES.indexOf(f) === -1);

/** 'upholsteryColor' -> 'Upholstery color'; 'seat_height' -> 'Seat height'. */
export function humanize(key) {
  const s = String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(key);
}

/** True for keys that name a whole-number quantity. */
export function isCountKey(key) {
  const k = String(key);
  return /^(count|n)$/.test(k) || /^num([A-Z_]|$)/.test(k) || /Counts?$/.test(k);
}

/** True for keys that name an angle in degrees. */
export function isAngleKey(key) {
  return /(deg|angle|yaw|rotation|lean|tilt|recline)/i.test(String(key));
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#[0-9a-fA-F]{3}$/;

function isFinishKey(key) {
  return /^finish$/i.test(key) || /Finish$/.test(key);
}

function decimals(n) {
  const s = String(n);
  if (s.indexOf('e') !== -1) return 6;
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/** Trim float noise: 0.1 * 3 -> 0.3. */
function tidy(n) {
  return Number(n.toFixed(6));
}

/**
 * The fallback numeric control for one key. Pure; see the header for the rules.
 * Exposed for the unit tests.
 */
export function deriveNumber(key, d) {
  const count = isCountKey(key) || Number.isInteger(d);
  const out = { key: key, kind: 'range', label: humanize(key) };

  if (isAngleKey(key)) {
    out.min = Math.min(-180, Math.floor(d));
    out.max = Math.max(180, Math.ceil(d));
    out.step = Number.isInteger(d) ? 1 : 0.5;
    out.unit = '°';
    return out;
  }

  let lo, hi;
  if (d === 0) {
    lo = 0;
    hi = isCountKey(key) ? 10 : 100;
  } else if (d < 0) {
    hi = -2 * d;
    lo = 2 * d;
  } else {
    lo = 0.5 * d;
    hi = 2 * d;
  }

  if (count) {
    out.step = 1;
    out.min = Math.floor(lo);
    out.max = Math.ceil(hi);
    if (Number.isInteger(d) === false) {
      // A count-like key holding a fraction: keep the default reachable.
      out.min = Math.min(out.min, Math.floor(d));
      out.max = Math.max(out.max, Math.ceil(d));
    }
  } else {
    const a = Math.abs(d);
    out.step = a >= 10 ? 0.5 : (a < 1 ? 0.01 : 0.1);
    // A finer default (2.25) needs a finer step than the default grid.
    if (decimals(d) > decimals(out.step)) out.step = tidy(Math.pow(10, -Math.min(decimals(d), 4)));
    out.min = tidy(lo);
    out.max = tidy(hi);
  }
  return out;
}

/** The fallback control for one DEFAULTS entry. */
export function deriveControl(key, value) {
  if (value === null || value === undefined) {
    return { key: key, kind: 'unsupported', label: humanize(key), reason: 'null' };
  }
  if (typeof value === 'number' && Number.isFinite(value)) return deriveNumber(key, value);
  if (typeof value === 'boolean') return { key: key, kind: 'toggle', label: humanize(key) };
  if (typeof value === 'string') {
    if (HEX.test(value) || HEX3.test(value)) return { key: key, kind: 'color', label: humanize(key) };
    if (isFinishKey(key) && FINISHES.indexOf(value) !== -1) {
      const opts = KEEP_FINISHES.indexOf(value) === -1 ? SELECTABLE_FINISHES.slice() : [value].concat(SELECTABLE_FINISHES);
      return { key: key, kind: 'select', label: humanize(key), options: opts };
    }
    return { key: key, kind: 'text', label: humanize(key) };
  }
  if (Array.isArray(value)) return { key: key, kind: 'unsupported', label: humanize(key), reason: 'array' };
  if (typeof value === 'object') return { key: key, kind: 'unsupported', label: humanize(key), reason: 'object' };
  return { key: key, kind: 'unsupported', label: humanize(key), reason: 'object' };
}

/**
 * The full control list for a type.
 *
 * @param {string} type        only used to label thrown/diagnostic context
 * @param {Object} DEFAULTS    the builder's DEFAULTS
 * @param {Array}  [CONTROLS]  the builder's explicit CONTROLS, if it has any
 * @returns {Array<Object>} fresh descriptors: explicit entries first (their
 *   own order, a repeated key keeps only its first entry, a key absent from
 *   DEFAULTS is dropped), then one derived entry per uncovered DEFAULTS key in
 *   DEFAULTS order. Never throws on odd input; never mutates it.
 */
export function controlsFor(type, DEFAULTS, CONTROLS) { // eslint-disable-line no-unused-vars
  const defaults = DEFAULTS && typeof DEFAULTS === 'object' ? DEFAULTS : {};
  const out = [];
  const seen = new Set();
  if (Array.isArray(CONTROLS)) {
    CONTROLS.forEach(c => {
      if (!c || typeof c.key !== 'string' || seen.has(c.key)) return;
      if (!Object.prototype.hasOwnProperty.call(defaults, c.key)) return;
      seen.add(c.key);
      const copy = Object.assign({}, c);
      if (Array.isArray(c.options)) copy.options = c.options.slice();
      if (copy.label === undefined) copy.label = humanize(c.key);
      out.push(copy);
    });
  }
  Object.keys(defaults).forEach(key => {
    if (seen.has(key)) return;
    out.push(deriveControl(key, defaults[key]));
  });
  return out;
}

/** The value a select option stands for. */
export function optionValue(o) {
  return o !== null && typeof o === 'object' ? o.value : o;
}

// ---- terse constructors for a builder's CONTROLS table ------------------------
// A builder writes   range('width', 'Width', 120, 360, 1, 'cm')   rather than the
// object literal, so a 20-row table stays one row per control and reads like the
// spec page's TweakSlider line it was copied from.

export const range = (key, label, min, max, step, unit) =>
  (unit ? { key, kind: 'range', label, min, max, step, unit } : { key, kind: 'range', label, min, max, step });
export const color = (key, label) => ({ key, kind: 'color', label });
export const select = (key, label, options) => ({ key, kind: 'select', label, options });
export const toggle = (key, label) => ({ key, kind: 'toggle', label });
export const text = (key, label) => ({ key, kind: 'text', label });
export const unsupported = (key, label, reason) => ({ key, kind: 'unsupported', label, reason });
