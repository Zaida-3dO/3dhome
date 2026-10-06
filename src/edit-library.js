/**
 * edit-library.js -- the furniture library edit mode adds new items from
 * (plan B2). Pure data and arithmetic: no DOM, no THREE, no builder imports.
 *
 * LIBRARY is one entry per thing you can add:
 *
 *   type       the registry type (src/furniture/registry.js)
 *   label      what the palette shows
 *   group      a GROUPS id, for the palette's sections
 *   mount      'floor': placed by `at` + `rotation` where the floor is tapped
 *              'wall':  snapped to the nearest wall of the tapped room
 *                       (`wall` + `centre` + `offset`), facing into it
 *   elevation  cm, floor to the item's bottom (a wall item's hanging height)
 *   preset     a key of the builder's PRESETS: the item starts from that
 *              preset's params (a plant is a species, not a bag of sliders)
 *   kinds      optional per-kind mount overrides: { '<params.kind>': { mount, elevation } }
 *              (a floor-standing speaker is not hung on the wall)
 *   keywords   extra words the search matches
 *
 * placeNew() turns a tap into the raw furniture entry; it returns `axis`
 * ('x'|'y') for a wall item so a placement preview can slide along it.
 *
 * Every registered type with a module is here EXCEPT `model`, which needs a
 * .glb in the profile. scripts/test-edit-library.mjs holds that line, and
 * places one of every entry in the demo house.
 */

import { newItemId, wallPlacement, nearestFit, isWallAnchored } from './edit-ops.js';
import { insidePoly } from './footstep-walk.js';
import { optionValue } from './furniture/controls.js';

export const GROUPS = Object.freeze([
  { id: 'living', label: 'Living room' },
  { id: 'bedroom', label: 'Bedroom' },
  { id: 'dining', label: 'Dining' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'bathroom', label: 'Bathroom' },
  { id: 'office', label: 'Office' },
  { id: 'plants', label: 'Plants' },
  { id: 'decor', label: 'Walls and decor' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'utility', label: 'Utility and outdoor' },
]);

const e = (type, label, group, mount, elevation, more) =>
  Object.freeze(Object.assign({ type, label, group, mount, elevation: elevation || 0 }, more || {}));

export const LIBRARY = Object.freeze([
  e('sofa', 'Sofa', 'living', 'floor', 0, { keywords: 'couch settee chaise' }),
  e('ottoman', 'Ottoman', 'living', 'floor', 0, { keywords: 'footstool pouffe' }),
  e('tv', 'TV', 'living', 'wall', 100, { keywords: 'television screen' }),
  e('speaker', 'Speaker', 'living', 'wall', 150, { keywords: 'audio sound',
    kinds: { 'floor-standing': { mount: 'floor', elevation: 0 }, centre: { mount: 'floor', elevation: 0 } } }),
  e('smart-display', 'Smart display / Nest speaker', 'living', 'floor', 40, { keywords: 'google nest hub max mini stand screen assistant tabletop' }),
  e('subwoofer', 'Subwoofer', 'living', 'floor', 0, { keywords: 'audio bass' }),
  e('cabinet', 'Cabinet / sideboard', 'living', 'wall', 0, { keywords: 'cupboard storage tv console drawers' }),
  e('digital-piano', 'Digital piano', 'living', 'wall', 0, { keywords: 'music keyboard' }),
  e('piano-bench', 'Piano bench', 'living', 'floor', 0, { keywords: 'music stool seat' }),

  e('bed', 'Bed', 'bedroom', 'wall', 0, { keywords: 'double king mattress' }),

  e('dining-table', 'Dining table', 'dining', 'floor', 0, { keywords: 'round table' }),
  e('dining-chair', 'Dining chair', 'dining', 'floor', 0, { keywords: 'seat' }),

  e('kitchen-base-run', 'Kitchen base units', 'kitchen', 'wall', 0, { keywords: 'worktop counter cupboards' }),
  e('kitchen-wall-run', 'Kitchen wall units', 'kitchen', 'wall', 145, { keywords: 'cupboards' }),
  e('fridge-freezer', 'Fridge freezer', 'kitchen', 'wall', 0, { keywords: 'refrigerator appliance' }),

  e('bathtub', 'Bathtub', 'bathroom', 'floor', 0, { keywords: 'bath' }),
  e('shower-tray', 'Shower tray', 'bathroom', 'floor', 0),
  e('shower-screen', 'Shower screen', 'bathroom', 'floor', 4.5, { keywords: 'glass' }),
  e('shower-set', 'Shower valve and riser', 'bathroom', 'wall', 60, { keywords: 'mixer head' }),
  e('toilet', 'Toilet', 'bathroom', 'wall', 0, { keywords: 'wc loo' }),
  e('towel-rail', 'Heated towel rail', 'bathroom', 'wall', 30, { keywords: 'radiator ladder' }),
  e('vanity-counter', 'Vanity unit', 'bathroom', 'wall', 0, { keywords: 'basin sink counter' }),

  e('standing-desk', 'Standing desk', 'office', 'floor', 0, { keywords: 'sit stand table' }),
  e('gaming-chair', 'Desk chair', 'office', 'floor', 0, { keywords: 'gaming office seat' }),
  e('monitor', 'Monitor', 'office', 'floor', 75, { keywords: 'screen display' }),
  e('pc-tower', 'PC tower', 'office', 'floor', 0, { keywords: 'computer case' }),

  e('plant', 'Corn plant (tall)', 'plants', 'floor', 0, { preset: 'corn-plant-tall', keywords: 'dracaena' }),
  e('plant', 'Peace lily (glass vase)', 'plants', 'floor', 0, { preset: 'peace-lily-glass-vase' }),
  e('plant', 'Snake plant', 'plants', 'floor', 0, { preset: 'snake-plant-small', keywords: 'sansevieria' }),
  e('plant', 'Pothos', 'plants', 'floor', 0, { preset: 'pothos-upright-ribbed-pot' }),
  e('plant', 'Trailing pothos', 'plants', 'floor', 0, { preset: 'pothos-trailing' }),
  e('plant', 'Ficus', 'plants', 'floor', 0, { preset: 'ficus-bowl-pot', keywords: 'tree' }),
  e('plant', 'Jade', 'plants', 'floor', 0, { preset: 'jade-small', keywords: 'succulent' }),
  e('plant', 'Wall planter', 'plants', 'wall', 140, { preset: 'wall-planter-large', keywords: 'hanging' }),

  e('mirror', 'Mirror', 'decor', 'wall', 120),
  e('photo-frame', 'Photo frames', 'decor', 'wall', 130, { keywords: 'picture art' }),
  e('wall-clock', 'Wall clock', 'decor', 'wall', 170, { keywords: 'time' }),
  e('wall-sign', 'Wall sign', 'decor', 'wall', 160, { keywords: 'text lettering' }),
  e('slat-panel', 'Slat panelling', 'decor', 'wall', 0, { keywords: 'acoustic wood' }),
  e('hex-panel-cluster', 'Hexagon panels', 'decor', 'wall', 80, { keywords: 'hex acoustic' }),
  e('shelf', 'Wall shelf', 'decor', 'wall', 120, { keywords: 'floating' }),
  e('coat-rack', 'Coat rack', 'decor', 'wall', 160, { keywords: 'hooks' }),

  e('wall-sconce', 'Wall light', 'lighting', 'wall', 150, { keywords: 'sconce lamp' }),
  e('tube-floor-lamp', 'Tube floor lamp', 'lighting', 'floor', 0, { keywords: 'led' }),

  e('radiator', 'Radiator', 'utility', 'wall', 15, { keywords: 'heating' }),
  e('robot-vacuum', 'Robot vacuum', 'utility', 'wall', 0, { keywords: 'hoover dock' }),
  e('dog-crate', 'Dog crate', 'utility', 'floor', 0, { keywords: 'pet cage' }),
  e('box', 'Plain box', 'utility', 'floor', 0, { keywords: 'block placeholder' }),
  e('balcony', 'Balcony', 'utility', 'floor', 0, { keywords: 'deck outdoor terrace' }),
]);

/** Types that are never offered (they need more than sliders). */
export const EXCLUDED_TYPES = Object.freeze(['model']);

/** A stable key for an entry (a type can appear more than once, by preset). */
export function entryKey(entry) { return entry.type + (entry.preset ? ':' + entry.preset : ''); }

export function findEntry(key) { return LIBRARY.find(x => entryKey(x) === key) || null; }

/**
 * The palette: GROUPS in order, each with its entries matching `query`
 * (every word must appear in the label, type, group label or keywords;
 * case-insensitive). Empty groups are dropped.
 */
export function paletteGroups(query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return GROUPS.map(g => ({
    id: g.id, label: g.label,
    entries: LIBRARY.filter(x => x.group === g.id).filter(x => {
      if (!words.length) return true;
      const hay = (x.label + ' ' + x.type + ' ' + g.label + ' ' + (x.keywords || '')).toLowerCase();
      return words.every(w => hay.indexOf(w) !== -1);
    }),
  })).filter(g => g.entries.length);
}

/** The mount ({ mount, elevation }) for an entry given the params chosen (its kind). */
export function mountFor(entry, params) {
  const k = params && entry.kinds ? entry.kinds[params.kind] : null;
  return k ? { mount: k.mount, elevation: k.elevation || 0 } : { mount: entry.mount, elevation: entry.elevation || 0 };
}

/**
 * The raw furniture entry a tap places, or { error } in words.
 *
 * @param o.doc       the raw geometry document (for a unique id)
 * @param o.compiled  the compiled house (rooms, wallsById)
 * @param o.entry     a LIBRARY entry
 * @param o.room      the tapped room's id (roomAt)
 * @param o.point     the tap on the floor, house cm [x, y]
 * @param o.params    the params to write (what was set in the panel; may be {})
 * @param o.size      the RESOLVED { width, depth } (defaults + params)
 * @param o.label     optional label
 */
export function placeNew(o) {
  if (!o.room) return { error: 'Tap the floor inside a room to place it.' };
  const { mount, elevation } = mountFor(o.entry, o.params);
  const id = newItemId(o.doc, o.room, o.entry.type);
  const item = { id, room: o.room, type: o.entry.type };
  let axis = null;
  if (mount === 'wall') {
    const w = wallPlacement(o.compiled, o.room, o.point, o.size.width);
    if (!w) return { error: 'No wall of this room is long enough for it here. Make it narrower, or tap nearer another wall.' };
    item.wall = w.wall; item.centre = w.centre; item.offset = 0;
    axis = w.axis;
  } else {
    const r = o.compiled.rooms[o.room];
    const poly = r.poly || [[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2]];
    const at = nearestFit(poly, o.point, { width: o.size.width, depth: o.size.depth, rotation: 0 });
    if (!at) return { error: 'It is too big for this room. Make it smaller first, or pick a bigger room.' };
    item.at = at; item.rotation = 0;
  }
  if (elevation) item.elevation = elevation;
  if (o.params && Object.keys(o.params).length) item.params = o.params;
  if (o.label) item.label = o.label;
  return { item, wallAnchored: isWallAnchored(item), axis };
}

/** The room (id) of the compiled house whose polygon holds `point` (house cm), or null. */
export function roomAtPoint(compiled, point) {
  if (!compiled || !compiled.rooms || !point) return null;
  const ids = Array.isArray(compiled.roomOrder) && compiled.roomOrder.length ? compiled.roomOrder : Object.keys(compiled.rooms);
  for (const id of ids) {
    const r = compiled.rooms[id];
    if (!r) continue;
    const poly = r.poly || [[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2]];
    if (insidePoly(poly, point[0], point[1])) return id;
  }
  return null;
}

/**
 * Where a placing tap lands: the room the scene's picker chose (a wall tap
 * resolves to the side tapped) and a point inside it -- the floor-plane
 * point when that is inside the room, else the picker's own point (a wall
 * hit stepped back off its face). B2 review finding 1: a straight-down
 * projection alone put a tap at a wall's base or top in the wall strip, or
 * through the wall into the neighbour.
 * @param pick  { room, point } from home.placementPick, or null
 * @param plan  the floor-plane point of the tap (house cm), or null
 */
export function resolvePlacement(compiled, pick, plan) {
  const room = pick && pick.room && compiled && compiled.rooms && compiled.rooms[pick.room] ? pick.room : null;
  if (!room) return { room: null, point: plan || null };
  const r = compiled.rooms[room];
  const poly = r.poly || [[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2]];
  if (plan && insidePoly(poly, plan[0], plan[1])) return { room, point: plan };
  return { room, point: (pick && pick.point) || plan || null };
}

/** The `kind` values that change how an item MOUNTS, per type (the rest mount as BASE_MOUNT says). */
export const MOUNT_KINDS = Object.freeze({ plant: { 'wall-planter': 'wall' }, speaker: { 'floor-standing': 'floor', centre: 'floor' } });
const BASE_MOUNT = { plant: 'floor', speaker: 'wall' };

/**
 * The options a select offers. For a `kind` whose values change how the
 * item mounts, a PLACED item is offered only the kinds of its own mount
 * (B2 review: a floor plant listed wall-planter) -- its current value is
 * always kept. `ctx` { mount: 'wall'|'floor' } (null: every option).
 */
export function kindOptionsFor(type, control, values, ctx) {
  const opts = control.options || [];
  const kinds = MOUNT_KINDS[type];
  if (control.key !== 'kind' || !kinds || !ctx || !ctx.mount) return opts;
  return opts.filter(o => {
    const v = optionValue(o);
    return (kinds[v] || BASE_MOUNT[type]) === ctx.mount || (values && v === values.kind);
  });
}
