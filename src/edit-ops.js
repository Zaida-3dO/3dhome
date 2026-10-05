/**
 * edit-ops.js -- the edits edit mode makes to a house's furniture (plan B1).
 *
 * Every op takes the RAW geometry document (geometry.json as parsed, the
 * draft's `geometry`) and returns a NEW document with one furniture item
 * changed. Untouched items, and every other part of the document, are the
 * SAME objects as in the input (structural sharing, never mutated), so the
 * layout-preserving export (src/json-layout.js) writes them back byte for
 * byte and a move shows up in the diff as one line.
 *
 *   moveItem(doc, id, { at: [x, y] })   free item: its centre, snapped to 1 cm
 *   moveItem(doc, id, { centre: c })    wall-anchored item: along its wall
 *   rotateItem(doc, id, deltaDeg)       free item only; kept in [0, 360)
 *   setParam(doc, id, key, value, o)    params[key] (+ o.mirror keys)
 *   deleteItem(doc, id)
 *
 * The shape check (checkFurnitureItem) is the small JS gate edit mode runs
 * before it keeps an edit; the real gate is the page's own compile of the
 * whole document, and scripts/validate-house.py --strict on export.
 *
 * Also the pure helpers the edit UI needs: confining a move to the item's
 * room polygon, the live (param-dependent) slider bounds a spec page applies,
 * the camera-relative arrow-key nudge, and the Frame panel's log distance
 * scale. No DOM, no THREE. Unit-tested in scripts/test-edit-ops.mjs.
 */

import { insidePoly } from './footstep-walk.js';

/** Moves snap to whole centimetres. */
export const SNAP_CM = 1;

export function snapCm(v) { return Math.round(v / SNAP_CM) * SNAP_CM; }

function furnitureOf(doc) {
  if (!doc || !Array.isArray(doc.furniture)) throw new Error('this profile has no furniture');
  return doc.furniture;
}

/** The raw furniture entry with this id, or null. */
export function findItem(doc, id) {
  const list = doc && Array.isArray(doc.furniture) ? doc.furniture : [];
  return list.find(f => f && f.id === id) || null;
}

/** A copy of `doc` whose item `id` is `fn(item)`; every other value shared. */
function withItem(doc, id, fn) {
  const list = furnitureOf(doc);
  const k = list.findIndex(f => f && f.id === id);
  if (k < 0) throw new Error('no furniture item "' + id + '" in this profile');
  const next = fn(list[k]);
  const furniture = list.slice();
  furniture[k] = next;
  return Object.assign({}, doc, { furniture });
}

/** A shallow copy of `o` with `key` set, keeping key ORDER (a new key goes last). */
function setKey(o, key, value) {
  const out = Object.assign({}, o);
  out[key] = value;
  return out;
}

const num = v => typeof v === 'number' && Number.isFinite(v);

/** Is this item wall-anchored (`wall` + `centre`) rather than free (`at`)? */
export function isWallAnchored(item) { return !!item && item.wall != null; }

/**
 * Move an item. Free items take `{ at: [x, y] }` (house cm); wall-anchored
 * items take `{ centre }` (cm along their wall). Snapped to 1 cm. The other
 * anchor form is refused: a move never re-anchors an item.
 */
export function moveItem(doc, id, pos) {
  return withItem(doc, id, item => {
    if (isWallAnchored(item)) {
      if (!pos || !num(pos.centre)) throw new Error('"' + id + '" is wall-anchored: move it with { centre }');
      return setKey(item, 'centre', snapCm(pos.centre));
    }
    if (!pos || !Array.isArray(pos.at) || !num(pos.at[0]) || !num(pos.at[1])) throw new Error('"' + id + '" is free-standing: move it with { at: [x, y] }');
    return setKey(item, 'at', [snapCm(pos.at[0]), snapCm(pos.at[1])]);
  });
}

/** Fold an angle in degrees into [0, 360), rounded to 0.1 deg. */
export function normDeg(d) {
  const r = Math.round((((d % 360) + 360) % 360) * 10) / 10;
  return r === 360 ? 0 : r;
}

/**
 * Turn a free item by `deltaDeg` (plan rotation is clockwise). A
 * wall-anchored item always faces into its room: refused.
 */
export function rotateItem(doc, id, deltaDeg) {
  return withItem(doc, id, item => {
    if (isWallAnchored(item)) throw new Error('"' + id + '" is wall-anchored: it always faces into its room');
    if (!num(deltaDeg)) throw new Error('rotateItem: deltaDeg must be a number');
    return setKey(item, 'rotation', normDeg((num(item.rotation) ? item.rotation : 0) + deltaDeg));
  });
}

/**
 * Set one builder param. `o.mirror` (a control's `mirror: [keys]`) writes
 * the same value to those keys too -- a round table's one Diameter slider
 * sets width and depth.
 */
export function setParam(doc, id, key, value, o) {
  if (typeof key !== 'string' || !key) throw new Error('setParam: key required');
  const keys = [key].concat(o && Array.isArray(o.mirror) ? o.mirror.filter(k => typeof k === 'string' && k !== key) : []);
  return withItem(doc, id, item => {
    let params = item.params && typeof item.params === 'object' ? item.params : {};
    keys.forEach(k => { params = setKey(params, k, value); });
    return setKey(item, 'params', params);
  });
}

/** Remove an item. */
export function deleteItem(doc, id) {
  const list = furnitureOf(doc);
  if (!list.some(f => f && f.id === id)) throw new Error('no furniture item "' + id + '" in this profile');
  return Object.assign({}, doc, { furniture: list.filter(f => !(f && f.id === id)) });
}

/** The rooms.json maps keyed by a furniture item id (its tap card, plant, robot). */
export const ITEM_BINDING_MAPS = Object.freeze(['items', 'plants', 'vacuums']);

/**
 * A rooms.json document without the bindings of a deleted item
 * (`sensors.items|plants|vacuums[id]`): the validator refuses a binding to
 * an item that no longer exists. The SAME object back when it has none, so
 * an export of rooms.json stays byte-identical.
 */
export function dropItemBindings(rooms, id) {
  const sensors = rooms && rooms.sensors;
  if (!sensors) return rooms;
  let next = null;
  ITEM_BINDING_MAPS.forEach(k => {
    const m = (next || sensors)[k];
    if (!m || typeof m !== 'object' || !Object.prototype.hasOwnProperty.call(m, id)) return;
    const copy = Object.assign({}, m);
    delete copy[id];
    next = Object.assign({}, next || sensors, { [k]: copy });
  });
  return next ? Object.assign({}, rooms, { sensors: next }) : rooms;
}

/**
 * The small shape check edit mode runs on an edited item before keeping it.
 * Returns a list of problems ([] when fine). Mirrors the loader's own skips.
 */
export function checkFurnitureItem(item) {
  const out = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ['not an object'];
  if (typeof item.id !== 'string' || !item.id) out.push('id must be a non-empty string');
  if (typeof item.type !== 'string' || !item.type) out.push('type must be a string');
  if (typeof item.room !== 'string' || !item.room) out.push('room must be a string');
  const hasAt = item.at != null, hasWall = item.wall != null;
  if (hasAt === hasWall) out.push('exactly one of at / wall');
  if (hasAt && !(Array.isArray(item.at) && item.at.length === 2 && num(item.at[0]) && num(item.at[1]))) out.push('at must be [x, y]');
  if (hasWall && !num(item.centre)) out.push('a wall-anchored item needs a numeric centre');
  if (hasWall && item.rotation != null) out.push('a wall-anchored item takes no rotation');
  if (item.rotation != null && !num(item.rotation)) out.push('rotation must be a number');
  if (item.params != null && (typeof item.params !== 'object' || Array.isArray(item.params))) out.push('params must be an object');
  return out;
}

// ---- Moves confined to the room -------------------------------------------

/**
 * Where a free item's centre may go, dragged from `from` toward `to` (both
 * house cm [x, y]) inside `poly` (its room's polygon). Tries the target,
 * then each axis alone (so a drag into a wall slides along it, which is what
 * an L-shaped room needs), else stays at `from`. `from` itself may be
 * outside (an item authored over a wall line): then any inside point wins,
 * and if none does the target is refused only if it moves FURTHER out --
 * here simply: it stays.
 */
export function confineToPoly(poly, from, to) {
  if (!Array.isArray(poly) || poly.length < 3) return to.slice();
  const ok = p => insidePoly(poly, p[0], p[1]);
  if (ok(to)) return to.slice();
  const xOnly = [to[0], from[1]], yOnly = [from[0], to[1]];
  const dx = Math.abs(to[0] - from[0]), dy = Math.abs(to[1] - from[1]);
  // The larger component first: the drag's main direction is kept.
  const order = dx >= dy ? [xOnly, yOnly] : [yOnly, xOnly];
  for (const p of order) if (ok(p)) return p;
  return from.slice();
}

/**
 * The span a wall-anchored item's `centre` may take on its wall: the
 * wall's own extent along its axis (the loader's rule), narrowed to the part
 * whose room-side point lies inside the item's room -- a wall shared by two
 * rooms keeps the item on its own room's stretch.
 *
 * @param wall   compiled wall { x1, y1, x2, y2 }
 * @param poly   the item's room polygon (house cm)
 * @param perp   the item's compiled perpendicular coordinate (its back on the
 *               room face: compiled y for a horizontal wall, x for a vertical one)
 * @param inDir  +1 / -1, the direction into the room along the other axis
 * @returns { lo, hi, axis: 'x'|'y' }
 */
export function wallSpan(wall, poly, perp, inDir) {
  const horiz = Math.abs(wall.y1 - wall.y2) < Math.abs(wall.x1 - wall.x2);
  const axis = horiz ? 'x' : 'y';
  let lo = Math.min(horiz ? wall.x1 : wall.y1, horiz ? wall.x2 : wall.y2);
  let hi = Math.max(horiz ? wall.x1 : wall.y1, horiz ? wall.x2 : wall.y2);
  if (Array.isArray(poly) && poly.length >= 3) {
    const probe = perp + (inDir || 1) * 2;   // 2 cm into the room
    const inside = c => (horiz ? insidePoly(poly, c, probe) : insidePoly(poly, probe, c));
    // Walk the span in 1 cm steps; keep the run of inside points (the room's
    // own stretch of this wall). Spans are metres, so this is a few hundred tests.
    let best = null, run = null;
    for (let c = Math.ceil(lo); c <= Math.floor(hi); c++) {
      if (inside(c)) { if (!run) run = [c, c]; else run[1] = c; }
      else if (run) { if (!best || run[1] - run[0] > best[1] - best[0]) best = run; run = null; }
    }
    if (run && (!best || run[1] - run[0] > best[1] - best[0])) best = run;
    if (best) { lo = best[0]; hi = best[1]; }
  }
  return { lo, hi, axis };
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- Live slider bounds ---------------------------------------------------

/**
 * Bounds a spec page takes from OTHER params (its JSX `min={t.minHeight}`).
 * The static CONTROLS carry the union of the possible ranges; the panel
 * narrows each to the live value. type -> key -> { min?: key, max?: key }.
 */
export const LIVE_BOUNDS = Object.freeze({
  'standing-desk': { topHeight: { min: 'minHeight', max: 'maxHeight' } },
  'slat-panel': { pitch: { min: 'slatWidth' } },
  'hex-panel-cluster': { bevelDepth: { max: 'thickness' } },
  'wall-sign': { panelDepth: { max: 'depth' } },
});

/** A range control's effective { min, max } given the item's current params. */
export function liveRange(type, control, params) {
  let min = control.min, max = control.max;
  const rule = (LIVE_BOUNDS[type] || {})[control.key];
  const p = params || {};
  if (rule && rule.min && num(p[rule.min])) min = Math.max(min, p[rule.min]);
  if (rule && rule.max && num(p[rule.max])) max = Math.min(max, p[rule.max]);
  if (min > max) max = min;
  return { min, max };
}

/**
 * The params to write when `key` is set to `value`: the value clamped to its
 * live range, plus every param whose live range depends on `key` re-clamped
 * (raising a desk's minHeight above its topHeight lifts the top with it).
 * @returns { [key]: value, ... } -- only keys that change
 */
export function paramWrites(type, controls, params, key, value) {
  const byKey = new Map((controls || []).map(c => [c.key, c]));
  const out = {};
  const c = byKey.get(key);
  let v = value;
  if (c && c.kind === 'range' && num(v)) { const r = liveRange(type, c, params); v = clamp(v, r.min, r.max); }
  out[key] = v;
  const next = Object.assign({}, params, out);
  const rules = LIVE_BOUNDS[type] || {};
  Object.keys(rules).forEach(dep => {
    const r = rules[dep];
    if (r.min !== key && r.max !== key) return;
    const dc = byKey.get(dep);
    if (!dc || !num(next[dep])) return;
    const lr = liveRange(type, dc, next);
    const cv = clamp(next[dep], lr.min, lr.max);
    if (cv !== next[dep]) out[dep] = cv;
  });
  return out;
}

// ---- Arrow-key nudge ------------------------------------------------------

/**
 * The plan-cm direction an arrow key moves an item, relative to the camera
 * (azimuth `th`, the orbit angle): Up is "away from the viewer", Right is
 * screen right, each snapped to the nearest plan axis so a nudge changes
 * one coordinate. Plan y runs south, the same way as world z.
 * @returns [dx, dy] unit, or null for another key
 */
export function nudgeDir(key, th) {
  // Camera -> target along the floor, in world (x, z) == plan (x, y).
  const fwd = [-Math.cos(th), -Math.sin(th)];
  const right = [Math.sin(th), -Math.cos(th)];
  const v = key === 'ArrowUp' ? fwd : key === 'ArrowDown' ? [-fwd[0], -fwd[1]]
    : key === 'ArrowRight' ? right : key === 'ArrowLeft' ? [-right[0], -right[1]] : null;
  if (!v) return null;
  return Math.abs(v[0]) >= Math.abs(v[1]) ? [Math.sign(v[0]) || 1, 0] : [0, Math.sign(v[1]) || 1];
}

// ---- Frame-the-view distance scale ------------------------------------------

/** The Distance slider's ends (metres) and its resolution (positions). */
export const DIST_MIN = 0.5, DIST_MAX = 30, DIST_STEPS = 1000;

/** Metres -> slider position, LOGARITHMIC: 1-10 m gets ~56% of the travel, not 15%. */
export function distToSlider(r) {
  const c = clamp(r, DIST_MIN, DIST_MAX);
  return Math.round(Math.log(c / DIST_MIN) / Math.log(DIST_MAX / DIST_MIN) * DIST_STEPS);
}

/** Slider position -> metres (2 dp). */
export function sliderToDist(s) {
  const t = clamp(s, 0, DIST_STEPS) / DIST_STEPS;
  return Math.round(DIST_MIN * Math.pow(DIST_MAX / DIST_MIN, t) * 100) / 100;
}
