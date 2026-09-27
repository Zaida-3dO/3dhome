/**
 * kitchen.js - fitted kitchen builders. A MULTI-TYPE module:
 *
 *   kitchen-base-run   floor units under one continuous worktop
 *   kitchen-wall-run   wall units, mixed heights, with an extractor hood
 *   fridge-freezer     a full-height two-door unit
 *
 * Builder contract: see box.js and docs/house-profile.md ("Furniture"). Pure
 * ESM, THREE injected, local frame in metres with y = 0 at the bottom, x
 * centred along the width, the BACK at z = 0 and the front facing +z. Every
 * material comes from makeFinish().
 *
 * MODULES. A run is an ordered list of modules, LEFT TO RIGHT AS YOU STAND
 * FACING THE RUN, which is the builder's local +x. Wall orientation is the
 * placer's business, never the author's.
 *
 *   base run:  { kind, width }  kind = cabinet | drawers | oven | hob | sink |
 *              dishwasher | washer | filler | corner | gap
 *     cabinet / sink            hinge: 'left' | 'right' | 'top' | 'bottom' --
 *                               one door (a lift-up flap for 'top', a
 *                               drop-down front for 'bottom') whatever its
 *                               width, handle on the opening edge and a
 *                               hinge line on the other. With no hinge, over
 *                               60 cm wide gets two doors.
 *     gap                       a bare space under the worktop: no carcass,
 *                               front or plinth (a freestanding appliance)
 *     oven                      hob: true puts a hob in the worktop above it
 *     sink                      a sink centred on this one module (bowl,
 *                               drainer, tap as for the run-level `sink`)
 *     any                       plinthLed: true -- an LED strip on the
 *                               plinth under this module (see ledStrips())
 *
 *   base run `sink`: { at, width, depth, bowl, drainer, tap } -- a sink
 *              placed along the RUN, not inside a module, so a 90 cm inset
 *              sink can span a cabinet and the dishwasher beside it. `at` is
 *              cm from the run's left end to the sink's centre.
 *
 *   wall run:  { kind, width, height?, at? }  kind = cabinet | open | hood |
 *              filler | gap. Wall runs do NOT corner: each unit hangs whole
 *              on its own wall (a `corner` param or module is ignored, with a
 *              warning). A wall run need not be full: `at` places a module
 *              (cm from the run's left end), and unused width is BARE wall
 *              unless `fill: 'filler'`. See layoutWallModules().
 *              `height` defaults to the run's height and may
 *              differ per module (70 next to 55, say). Module TOPS align at
 *              the run's top and each module's bottom follows from its own
 *              height; the placer sets `elevation` for the run's bottom (the
 *              bottom of its tallest module) -- elevationForTop() turns a
 *              top line into that number.
 *     cabinet                   hinge: 'left' | 'right' | 'top' | 'bottom',
 *                               as on a base run; the side handle sits low
 *     any                       alignTo: { run, module } -- centre it over a
 *                               base run's module as drawn (resolveAlignment)
 *     cabinet / filler          underLed: true (a strip under it, lighting
 *                               the worktop), topLed: true (one on top)
 *     hood                      splashback: <cm> -- a metal panel hung on
 *                               the wall under the hood, down toward the
 *                               worktop. It is part of the wall run, so the
 *                               run's height reaches down to its bottom;
 *                               give every module its own `height` then.
 *     hood                      style: 'chimney' | 'canopy',
 *                               visor: 'smoked' | 'glass' | 'metal'
 *                               (chimney only). 'smoked' is dark gloss and
 *                               merges; 'glass' is a real transparent part
 *                               and costs the kitchen a draw of its own.
 *
 * WIDTH IS AUTHORITATIVE. `params.width` is the run's footprint (the
 * validator reads it too, so a run cannot quietly be wider than it says).
 * On a BASE run, when the modules add up to less, a filler closes the gap
 * at the end away from the corner; when they add up to more, every module is
 * scaled down to fit. Either way a warning names the mismatch. A WALL run
 * leaves unused width bare, so its drawn parts can be narrower than `width`
 * -- always INSIDE it, never outside: the envelope still contains everything
 * drawn, it is just not full.
 *
 * CORNERS. `corner: 'left' | 'right'` says this run OWNS the corner at that
 * end: it ends in a blind corner unit (a `corner` module, whose blind panel
 * faces that end) and its worktop runs right to the wall. The other run of an
 * L is authored to stop at the owner's front face, so their worktops meet
 * without overlapping or gapping even when the two runs differ in depth (a
 * 60 leg and a 62 leg, say). The owner is told the other run's depth in
 * `cornerDepth`: that is how much of its blind corner is hidden, and where
 * its plinth return (and LED) turns. A run that does not own a corner is
 * `'none'`. Each run's worktop is exactly its own `depth` deep.
 *
 * WHICH LEG OWNS IT. Exactly one leg of an L owns the corner: the one whose
 * worktop runs into the corner to the side wall, with the blind unit under
 * it. Author the OTHER leg to start at the owner's front face (its own
 * `corner: 'none'`). Its carcass then sits in front of the owner's corner
 * module, so that module must be at least `cornerDepth` wide -- the builder
 * guarantees it, widening a narrower one from its neighbour with a warning
 * (a 58 cm corner module against a 60 cm leg is drawn 60), so the two legs
 * cannot clash.
 *
 * HEIGHT IS THE ENVELOPE, always: every run's bounding box is exactly its
 * width x depth x height, whatever its modules -- save that a wall run with
 * bare wall in it is CONTAINED by that box rather than filling its width
 * (nothing is ever drawn outside it). A base run's worktop top is
 * `worktopHeight`; when a sink has a tap, the tap rises from the worktop to
 * exactly `height` (baseRunHeight() gives worktopHeight + TAP_RISE), and
 * with no tap the worktop is drawn at `height`. A wall run's `height` runs
 * from the bottom of whatever hangs lowest -- a module, or a hood's
 * splashback -- to its top line.
 *
 * DRAWS. A kitchen is drawn in four palette finishes -- `matte` (worktop,
 * hob burners), `gloss` (fronts, carcass, plinth, oven door, hob glass, a
 * smoked hood visor), `metal` (handles, oven fascia, sink, tap, hood,
 * splashback) and kept `emissive` for the LED strips. Kept parts keep a real
 * material, so each distinct LED COLOUR is a draw: with every strip in one
 * colour (the defaults) the whole merged L is four draws, whatever
 * `frontFinish` is. Each further LED colour, and a `glass` hood visor, costs
 * one more -- a choice the author makes knowingly, named where it lives.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

const CM = 0.01;

// ---- shared helpers ------------------------------------------------------------

function deepFreeze(o) {
  Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
}

let quiet = 0;
function warn(msg) { if (!quiet) console.warn('[furniture:kitchen] ' + msg); }

function resolve(defaults, params) {
  const p = Object.assign({}, defaults);
  if (params && typeof params === 'object') {
    Object.keys(params).forEach(k => { if (params[k] !== undefined) p[k] = params[k]; });
  }
  return p;
}

/** An axis-aligned box in CENTIMETRES, or null if it is degenerate. */
function box(THREE, mat, x0, x1, y0, y1, z0, z1, name) {
  const w = x1 - x0, h = y1 - y0, d = z1 - z0;
  if (!(w > 0.01 && h > 0.01 && d > 0.01)) return null;
  const g = new THREE.BoxGeometry(w * CM, h * CM, d * CM);
  g.translate((x0 + x1) / 2 * CM, (y0 + y1) / 2 * CM, (z0 + z1) / 2 * CM);
  const mesh = new THREE.Mesh(g, mat);
  if (name) mesh.name = name;
  if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
  return mesh;
}

/** A vertical cylinder in centimetres. */
function cyl(THREE, mat, x, z, y0, y1, r, segs, name) {
  const g = new THREE.CylinderGeometry(r * CM, r * CM, (y1 - y0) * CM, segs);
  g.translate(x * CM, (y0 + y1) / 2 * CM, z * CM);
  const mesh = new THREE.Mesh(g, mat);
  if (name) mesh.name = name;
  if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
  return mesh;
}

function add(group, mesh) { if (mesh) group.add(mesh); return mesh; }

const HANDLE_STYLES = ['bar', 'knob', 'rail', 'none'];
const FRONT_FINISHES = ['matte', 'gloss', 'metal'];

function materials(THREE, p) {
  let frontFinish = p.frontFinish;
  if (FRONT_FINISHES.indexOf(frontFinish) === -1) {
    warn('frontFinish ' + JSON.stringify(frontFinish) + ' is not one of ' + FRONT_FINISHES.join('/') + ' -- using "gloss"');
    frontFinish = 'gloss';
  }
  return {
    front: makeFinish(THREE, frontFinish, p.frontColor),
    worktop: makeFinish(THREE, 'matte', p.worktopColor || '#8c8b88'),
    handle: makeFinish(THREE, 'metal', p.handleColor),
    steel: makeFinish(THREE, 'metal', '#c3c6c9'),
    dark: makeFinish(THREE, 'gloss', '#141518'),
    burner: makeFinish(THREE, 'matte', '#303134'),
    seam: makeFinish(THREE, 'matte', '#5c5a55'),
    glass: makeFinish(THREE, 'glass', '#d6e6ea'),
    smoked: makeFinish(THREE, 'gloss', '#3a3f44'),
    led: makeFinish(THREE, 'emissive', p.ledColor || '#ffb45a'),
    underLed: makeFinish(THREE, 'emissive', p.underLedColor || '#ffb45a'),
    topLed: makeFinish(THREE, 'emissive', p.topLedColor || '#ffb45a'),
  };
}

function handleStyleOf(p) {
  if (HANDLE_STYLES.indexOf(p.handleStyle) !== -1) return p.handleStyle;
  warn('handleStyle ' + JSON.stringify(p.handleStyle) + ' is not one of ' + HANDLE_STYLES.join('/') + ' -- using "bar"');
  return 'bar';
}

/**
 * Lay `modules` out left to right across `W` cm starting at -W/2, fitting
 * them to W (see WIDTH IS AUTHORITATIVE above). Unknown kinds fall back to
 * `fallback`; entries with no usable width are dropped. Never throws.
 */
export function layoutModules(modules, W, opts) {
  const o = opts || {};
  const kinds = o.kinds || [];
  const fallback = o.fallback || 'cabinet';
  const list = [];
  (Array.isArray(modules) ? modules : []).forEach((m, i) => {
    if (!m || typeof m !== 'object' || !(typeof m.width === 'number' && m.width > 0)) {
      warn((o.type || 'run') + ': module ' + i + ' has no positive width -- skipped');
      return;
    }
    let kind = m.kind;
    if (kinds.indexOf(kind) === -1) {
      warn((o.type || 'run') + ': module ' + i + ' kind ' + JSON.stringify(kind) + ' is unknown -- drawn as "' + fallback + '"');
      kind = fallback;
    }
    list.push(Object.assign({}, m, { kind: kind }));
  });
  const sum = list.reduce((s, m) => s + m.width, 0);
  if (list.length === 0) {
    list.push({ kind: 'filler', width: W });
  } else if (sum > W + 0.05) {
    warn((o.type || 'run') + ': modules add up to ' + sum + ' cm but width is ' + W + ' cm -- scaled to fit');
    const k = W / sum;
    list.forEach(m => { m.width *= k; });
  } else if (sum < W - 0.05) {
    warn((o.type || 'run') + ': modules add up to ' + sum + ' cm but width is ' + W + ' cm -- a filler closes the gap');
    const filler = { kind: 'filler', width: W - sum };
    if (o.corner === 'right') list.unshift(filler); else list.push(filler);
  }
  let x = -W / 2;
  list.forEach((m, i) => {
    m.x0 = x;
    m.x1 = i === list.length - 1 ? W / 2 : x + m.width;
    x = m.x1;
  });
  return list;
}

/**
 * Handles for a door or drawer front. `where` is one of:
 *   'v-top'  vertical bar near the top of the front (base doors)
 *   'v-bot'  vertical bar near the bottom (wall doors)
 *   'h-top'  horizontal bar centred near the top (drawers, appliances)
 * `edge` is 'left' | 'right' | 'centre' for the vertical bars.
 */
function addHandle(THREE, g, mats, style, f, where, edge, zFace) {
  if (style === 'none' || style === 'rail') return;
  const w = f.x1 - f.x0, h = f.y1 - f.y0;
  const inset = Math.max(2.2, Math.min(4, w / 6));
  let x;
  if (edge === 'left') x = f.x0 + inset;
  else if (edge === 'right') x = f.x1 - inset;
  else x = (f.x0 + f.x1) / 2;
  if (style === 'knob') {
    const y = where === 'v-bot' || where === 'h-bot' ? f.y0 + 5 : f.y1 - 5;
    add(g, box(THREE, mats.handle, x - 0.9, x + 0.9, y - 0.9, y + 0.9, zFace, zFace + 2.2, 'handle'));
    return;
  }
  if (where === 'h-top' || where === 'h-bot') {
    const len = Math.min(24, w * 0.5);
    const y = where === 'h-bot' ? f.y0 + Math.min(4, h / 4) : f.y1 - Math.min(4, h / 4);
    add(g, box(THREE, mats.handle, x - len / 2, x + len / 2, y - 0.6, y + 0.6, zFace, zFace + 2.2, 'handle'));
    return;
  }
  const len = Math.min(16, h / 3);
  const y1 = where === 'v-bot' ? f.y0 + 3 + len : f.y1 - 3;
  add(g, box(THREE, mats.handle, x - 0.6, x + 0.6, y1 - len, y1, zFace, zFace + 2.2, 'handle'));
}

const GAP = 0.15;   // half the 3 mm shadow gap between fronts

/** One front panel, gapped, between two z planes. */
function frontPanel(THREE, g, mat, x0, x1, y0, y1, z0, z1, name) {
  return add(g, box(THREE, mat, x0 + GAP, x1 - GAP, y0 + GAP, y1 - GAP, z0, z1, name || 'front'));
}

/**
 * The door(s) of a cabinet-like module: one door up to 60 cm wide (handle on
 * the edge away from the hinge), two over it (handles at the meeting edges).
 * Narrow doors -- a half-width 30, even a 15 -- keep the handle inset
 * proportional so it never crosses the door's edge.
 */
/**
 * The hinge cue: a thin dark line on the face of a door along the edge it
 * hangs from -- the door-gap shadow that reads, at a distance, as "this edge
 * does not open". Paired with the handle on the opening edge, it says which
 * way every door swings, on base and wall runs alike.
 */
function hingeLine(THREE, g, mats, f, edge, zFace) {
  const t = 0.5;
  let b;
  if (edge === 'left') b = [f.x0 + GAP, f.x0 + GAP + t, f.y0 + GAP, f.y1 - GAP];
  else if (edge === 'right') b = [f.x1 - GAP - t, f.x1 - GAP, f.y0 + GAP, f.y1 - GAP];
  else if (edge === 'bottom') b = [f.x0 + GAP, f.x1 - GAP, f.y0 + GAP, f.y0 + GAP + t];
  else b = [f.x0 + GAP, f.x1 - GAP, f.y1 - GAP - t, f.y1 - GAP];     // top
  add(g, box(THREE, mats.seam, b[0], b[1], b[2], b[3], zFace, zFace + 0.1, 'door-gap'));
}

const HINGES = ['left', 'right', 'top', 'bottom'];

/**
 * The door(s) of a cabinet-like module.
 *   hinge 'left' | 'right'  one door, whatever its width: handle on the
 *                           opening edge, hinge line on the other.
 *   hinge 'top'             one lift-up flap: handle along its bottom edge,
 *                           hinge line along its top.
 *   hinge 'bottom'          one drop-down front: handle along its TOP edge
 *                           (as on a dishwasher), hinge line along its
 *                           bottom.
 *   no hinge                one door up to 60 cm (hung left); two doors over
 *                           it, handles at the meeting edges.
 * Narrow doors -- a half-width 30, even a 15 -- keep the handle inset
 * proportional so it never crosses the door's edge. `where` places a side
 * handle near the door's top ('v-top', base units) or bottom ('v-bot', wall
 * units).
 */
function doors(THREE, g, mats, style, detail, m, y0, y1, z0, z1, where) {
  const full = detail !== 'low';
  const f = { x0: m.x0, x1: m.x1, y0: y0, y1: y1 };
  let hinge = m.hinge;
  if (hinge !== undefined && HINGES.indexOf(hinge) === -1) {
    warn('hinge ' + JSON.stringify(hinge) + ' is not left/right/top/bottom -- using "left"');
    hinge = 'left';
  }
  if (hinge === undefined && m.x1 - m.x0 > 60.5) {
    const xm = (m.x0 + m.x1) / 2;
    frontPanel(THREE, g, mats.front, m.x0, xm, y0, y1, z0, z1, 'door');
    frontPanel(THREE, g, mats.front, xm, m.x1, y0, y1, z0, z1, 'door');
    if (full) {
      addHandle(THREE, g, mats, style, { x0: m.x0, x1: xm, y0: y0, y1: y1 }, where, 'right', z1);
      addHandle(THREE, g, mats, style, { x0: xm, x1: m.x1, y0: y0, y1: y1 }, where, 'left', z1);
      hingeLine(THREE, g, mats, { x0: m.x0, x1: xm, y0: y0, y1: y1 }, 'left', z1);
      hingeLine(THREE, g, mats, { x0: xm, x1: m.x1, y0: y0, y1: y1 }, 'right', z1);
    }
    return;
  }
  hinge = hinge || 'left';
  frontPanel(THREE, g, mats.front, m.x0, m.x1, y0, y1, z0, z1,
    hinge === 'top' ? 'flap' : hinge === 'bottom' ? 'drop-front' : 'door');
  if (!full) return;
  if (hinge === 'top') {
    addHandle(THREE, g, mats, style, f, 'h-bot', 'centre', z1);
    hingeLine(THREE, g, mats, f, 'top', z1);
  } else if (hinge === 'bottom') {
    addHandle(THREE, g, mats, style, f, 'h-top', 'centre', z1);
    hingeLine(THREE, g, mats, f, 'bottom', z1);
  } else {
    addHandle(THREE, g, mats, style, f, where, hinge === 'right' ? 'left' : 'right', z1);
    hingeLine(THREE, g, mats, f, hinge, z1);
  }
}

/**
 * A blind corner front: a plain blind panel on the corner side (hidden by the
 * other run of the L, `hidden` cm deep) and a door on the rest. A door
 * narrower than 20 cm is not worth hanging, so below that the whole front is
 * blind panel.
 */
function blindCorner(THREE, g, mats, style, detail, m, side, hidden, y0, y1, z0, z1, where) {
  const w = m.x1 - m.x0;
  const door = w - hidden >= 20 ? w - hidden : 0;
  const blind = w - door;
  if (side === 'right') {
    frontPanel(THREE, g, mats.front, m.x1 - blind, m.x1, y0, y1, z0, z1, 'blind-panel');
    if (door > 0.5) {
      frontPanel(THREE, g, mats.front, m.x0, m.x0 + door, y0, y1, z0, z1, 'door');
      if (detail !== 'low') addHandle(THREE, g, mats, style, { x0: m.x0, x1: m.x0 + door, y0: y0, y1: y1 }, where, 'left', z1);
    }
  } else {
    frontPanel(THREE, g, mats.front, m.x0, m.x0 + blind, y0, y1, z0, z1, 'blind-panel');
    if (door > 0.5) {
      frontPanel(THREE, g, mats.front, m.x0 + blind, m.x1, y0, y1, z0, z1, 'door');
      if (detail !== 'low') addHandle(THREE, g, mats, style, { x0: m.x0 + blind, x1: m.x1, y0: y0, y1: y1 }, where, 'right', z1);
    }
  }
}

/** Which way a corner module's blind panel faces when the run owns no corner: toward its nearer end. */
function blindSide(m, corner) {
  if (corner === 'left' || corner === 'right') return corner;
  return (m.x0 + m.x1) / 2 < 0 ? 'left' : 'right';
}

function checkCorner(corner, type) {
  if (corner === 'left' || corner === 'right' || corner === 'none') return corner;
  warn(type + ': corner ' + JSON.stringify(corner) + ' is not left/right/none -- using "none"');
  return 'none';
}

// ---- kitchen-base-run ----------------------------------------------------------

const BASE_KINDS = ['cabinet', 'drawers', 'oven', 'hob', 'sink', 'dishwasher', 'washer', 'filler', 'corner', 'gap'];

// Kept equal to houses/schema.json $defs/furnitureParams_kitchen-base-run by
// scripts/test-furniture-defaults.mjs.
const BASE_DEFAULTS = deepFreeze({
  width: 180,
  depth: 60,
  height: 88.5,
  worktopHeight: 88.5,
  modules: [
    { kind: 'cabinet', width: 60, hinge: 'left' },
    { kind: 'oven', width: 60, hob: true },
    { kind: 'drawers', width: 60 },
  ],
  corner: 'none',
  cornerDepth: 60,
  frontColor: '#f2f0ea',
  frontFinish: 'gloss',
  worktopColor: '#8e8c88',
  handleStyle: 'bar',
  handleColor: '#c9cccf',
  worktopThickness: 2.5,
  plinthHeight: 13,
  ledColor: '#ffb45a',
  sink: null,
});

/** A module that carries a hob in the worktop above it. */
function hasHob(m) { return m.kind === 'hob' || (m.kind === 'oven' && m.hob === true); }

/**
 * The worktop, in pieces around the cut-outs (hob, sink) so a flush hob and a
 * sunken bowl actually read from above. Pieces tile [-W/2, W/2] x [0, D]
 * exactly; every piece is named 'worktop'.
 */
function worktop(THREE, g, mat, W, D, yb, yt, cutouts) {
  let x = -W / 2;
  cutouts.slice().sort((a, b) => a.x0 - b.x0).forEach(c => {
    add(g, box(THREE, mat, x, c.x0, yb, yt, 0, D, 'worktop'));
    add(g, box(THREE, mat, c.x0, c.x1, yb, yt, 0, c.z0, 'worktop'));
    add(g, box(THREE, mat, c.x0, c.x1, yb, yt, c.z1, D, 'worktop'));
    x = c.x1;
  });
  add(g, box(THREE, mat, x, W / 2, yb, yt, 0, D, 'worktop'));
}

/**
 * The plinth return a corner-owning run closes its plinth recess with, at the
 * line where the other run's plinth face will be -- `cornerDepth`, the other
 * run's depth, less its 8 cm plinth set-back -- so the kickboards meet at the
 * inside corner.
 */
function plinthReturn(THREE, g, mats, corner, cornerDepth, W, D, P) {
  if (P <= 0 || (corner !== 'left' && corner !== 'right')) return;
  const t = 1.8, xr = cornerLine(corner, cornerDepth - 8, W);
  add(g, corner === 'left'
    ? box(THREE, mats.front, xr - t, xr, 0, P, D - 8, D, 'plinth-return')
    : box(THREE, mats.front, xr, xr + t, 0, P, D - 8, D, 'plinth-return'));
}

/** The x (local) of a line `reach` cm in from the corner end, or null. */
function cornerLine(corner, reach, W) {
  if (corner === 'left') return -W / 2 + reach;
  if (corner === 'right') return W / 2 - reach;
  return null;
}

/**
 * LED STRIPS. A strip is a thin emissive, kept line under every module
 * flagged for it -- `plinthLed` on a base run, `underLed` / `topLed` on a
 * wall run. Adjacent flagged modules share one strip (a strip breaks where
 * the flagged modules' strip heights differ, e.g. under a 70 next to a 55).
 * A subset of modules -- "from the third to the corner" -- is just those
 * modules flagged.
 *
 * ROUND THE CORNER. When the owner's corner module is flagged, its strip
 * stops at the line where the other run's strip will run (`cornerDepth` less
 * the strip's own set-back from the front) and turns along it to the owner's
 * front edge -- exactly where the other run's strip, flagged up to its own
 * corner end, picks up. The line is continuous and neither run draws outside
 * its box.
 *
 * @param {Object} o  { mat, flag, name, zBack (strip's set-back from the
 *   front, cm), dz (its thickness in z), yOf(m) -> [y0, y1] }
 */
function ledStrips(THREE, g, mods, corner, cornerDepth, W, D, o) {
  const zF = D - o.zBack;
  const xr = cornerLine(corner, cornerDepth - o.zBack, W);
  const spans = [];
  mods.forEach(m => {
    if (m[o.flag] !== true) return;
    const y = o.yOf(m);
    if (!y) return;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last.x1 - m.x0) < 0.01 && Math.abs(last.y[0] - y[0]) < 0.01 && Math.abs(last.y[1] - y[1]) < 0.01) {
      last.x1 = m.x1; last.mods.push(m);
    } else spans.push({ x0: m.x0, x1: m.x1, y: y, mods: [m] });
  });
  spans.forEach(sp => {
    let x0 = sp.x0, x1 = sp.x1, turn = false;
    if (corner === 'left' && Math.abs(x0 + W / 2) < 0.01 && sp.mods[0].kind === 'corner') { x0 = xr; turn = true; }
    if (corner === 'right' && Math.abs(x1 - W / 2) < 0.01 && sp.mods[sp.mods.length - 1].kind === 'corner') { x1 = xr; turn = true; }
    const [y0, y1] = sp.y;
    if (x1 - x0 > 0.5) add(g, box(THREE, o.mat, x0, x1, y0, y1, zF, zF + o.dz, o.name));
    if (turn) {
      add(g, corner === 'left'
        ? box(THREE, o.mat, xr, xr + o.dz, y0, y1, zF, D, o.name)
        : box(THREE, o.mat, xr - o.dz, xr, y0, y1, zF, D, o.name));
    }
  });
}

/**
 * A sink, drawn from a run-level spec in run-local cm:
 *   { cx, width, depth, bowl: 'inset'|'undermount', drainer: 'left'|'right'|'none', tap }
 * Inset: one metal plate flush with the worktop (a drainer beside the bowl
 * when there is one), the bowl sunk into it. Undermount: the bowl alone under
 * the worktop's cut edge. Returns the worktop cut-out it needs.
 */
function drawSink(THREE, g, mats, sk, D, H, yW, full, tapTop) {
  const inset = sk.bowl !== 'undermount';
  const z0 = Math.max(1, (D - sk.depth) / 2), z1 = Math.min(D - 1, z0 + sk.depth);
  const x0 = sk.cx - sk.width / 2, x1 = sk.cx + sk.width / 2;
  // The bowl: the whole sink when undermount or without a drainer, else the
  // part away from the drainer.
  const rim = inset ? 2 : 0;
  const drainer = inset && sk.drainer !== 'none' && sk.width >= 70 ? sk.drainer || 'right' : 'none';
  let bx0 = x0 + rim, bx1 = x1 - rim;
  const bw = Math.min(50, (x1 - x0) * 0.55);
  if (drainer === 'right') bx1 = bx0 + bw;
  if (drainer === 'left') bx0 = bx1 - bw;
  const bz0 = z0 + rim, bz1 = z1 - rim;
  const bottom = H - SINK_DEPTH;
  const cx = (bx0 + bx1) / 2;
  const tz = Math.max(2, z0 / 2 + 0.5);
  if (!full) {
    // Low detail: the sink as one steel block sunk 6 mm into its cut-out,
    // and the tap (when there is one) as one post, so the envelope holds.
    add(g, box(THREE, mats.steel, x0, x1, bottom, H - 0.6, z0, z1, 'sink'));
    if (tapTop !== null) {
      const q = box(THREE, mats.steel, cx - 1.4, cx + 1.4, H, tapTop, tz - 1.4, tz + 1.4, 'tap');
      q.userData.aboveWorktop = true;
      g.add(q);
    }
    return { x0: x0, x1: x1, z0: z0, z1: z1 };
  }
  const top = inset ? H - 0.6 : yW, t = 0.6;
  add(g, box(THREE, mats.steel, bx0, bx1, bottom, bottom + t, bz0, bz1, 'sink'));
  add(g, box(THREE, mats.steel, bx0, bx0 + t, bottom, top, bz0, bz1, 'sink'));
  add(g, box(THREE, mats.steel, bx1 - t, bx1, bottom, top, bz0, bz1, 'sink'));
  add(g, box(THREE, mats.steel, bx0, bx1, bottom, top, bz0, bz0 + t, 'sink'));
  add(g, box(THREE, mats.steel, bx0, bx1, bottom, top, bz1 - t, bz1, 'sink'));
  if (inset) {
    // The plate: everything in the sink's outline except the bowl's opening.
    const plate = (a, b, c, d) => add(g, box(THREE, mats.steel, a, b, H - 0.6, H, c, d, 'sink-rim'));
    plate(x0, x1, z0, bz0);
    plate(x0, x1, bz1, z1);
    plate(x0, bx0, bz0, bz1);
    plate(bx1, x1, bz0, bz1);
  }
  if (tapTop !== null) {
    // A swan-neck tap whose top is exactly `tapTop` (the run's height).
    const rise = tapTop - H, reach = Math.min(20, (bz0 + bz1) / 2 - tz);
    const parts = [cyl(THREE, mats.steel, cx, tz, H, tapTop, 1.4, 12, 'tap')];
    if (rise > 4) {
      parts.push(box(THREE, mats.steel, cx - 1, cx + 1, tapTop - 2, tapTop, tz, tz + reach, 'tap'));
      parts.push(box(THREE, mats.steel, cx - 1, cx + 1, Math.max(H, tapTop - 6), tapTop - 2, tz + reach - 2, tz + reach, 'tap'));
    }
    parts.forEach(q => { q.userData.aboveWorktop = true; g.add(q); });
  }
  return { x0: x0, x1: x1, z0: z0, z1: z1 };
}

// How far a sink's bowl sinks below the worktop top.
const SINK_DEPTH = 20;

// The tap rise the spec page (and baseRunHeight) allows for above the worktop.
export const TAP_RISE = 30;

/** The run-level sink spec, or null. `at` is cm from the run's LEFT end to the sink's centre. */
function sinkSpec(raw, W, D) {
  if (!raw || typeof raw !== 'object') return null;
  const width = Math.max(20, Math.min(W, typeof raw.width === 'number' ? raw.width : 90));
  const depth = Math.max(20, Math.min(D - 4, typeof raw.depth === 'number' ? raw.depth : 50));
  let at = typeof raw.at === 'number' ? raw.at : W / 2;
  const lo = width / 2, hi = W - width / 2;
  if (at < lo || at > hi) {
    warn('kitchen-base-run: sink at ' + at + ' cm does not fit the ' + W + ' cm run -- moved inside it');
    at = Math.max(lo, Math.min(hi, at));
  }
  return { cx: -W / 2 + at, width: width, depth: depth, bowl: raw.bowl, drainer: raw.drainer, tap: raw.tap };
}

/**
 * The params a base run needs its `height` to be: the worktop top, plus the
 * tap's rise when a sink with a tap is present. What the spec page sets.
 */
export function baseRunHeight(params) {
  const p = resolve(BASE_DEFAULTS, params);
  const wt = typeof p.worktopHeight === 'number' ? p.worktopHeight : p.height;
  const tap = (p.sink && typeof p.sink === 'object' && p.sink.tap !== false) ||
    (Array.isArray(p.modules) && p.modules.some(m => m && m.kind === 'sink' && m.tap !== false));
  return wt + (tap ? TAP_RISE : 0);
}

/**
 * An owner's corner module must be at least as wide as the other run is
 * deep, or the other run's carcass lands on the next module's door. So it is
 * grown to `cornerDepth`, taking the difference from its neighbour, with a
 * warning -- the clash cannot be drawn.
 */
function growCorner(mods, corner, cornerDepth, type) {
  if (corner !== 'left' && corner !== 'right') return;
  const i = corner === 'left' ? 0 : mods.length - 1;
  const m = mods[i];
  if (!m || m.kind !== 'corner') {
    warn(type + ': the run owns the ' + corner + ' corner but does not end in a `corner` module there');
    return;
  }
  const short = cornerDepth - (m.x1 - m.x0);
  const j = corner === 'left' ? 1 : mods.length - 2;
  const n = mods[j];
  if (short <= 0.01 || !n) return;
  const give = Math.min(short, Math.max(0, (n.x1 - n.x0) - 10));
  warn(type + ': the corner module is ' + (m.x1 - m.x0) + ' cm but the other run is ' + cornerDepth +
    ' cm deep -- widened by ' + give + ' cm from its neighbour so the other run cannot clash with it');
  if (corner === 'left') { m.x1 += give; n.x0 += give; } else { m.x0 -= give; n.x1 -= give; }
}

function buildBaseRun(THREE, params, opts) {
  const p = resolve(BASE_DEFAULTS, params);
  const detail = opts && opts.detail === 'low' ? 'low' : 'full';
  const full = detail === 'full';
  const W = p.width, D = p.depth;
  const T = Math.max(1, Math.min(10, p.worktopThickness));
  const P = Math.max(0, Math.min(30, p.plinthHeight));
  const corner = checkCorner(p.corner, 'kitchen-base-run');
  const cornerDepth = Math.max(10, Math.min(W, typeof p.cornerDepth === 'number' ? p.cornerDepth : 60));
  const style = handleStyleOf(p);
  const mats = materials(THREE, p);
  const mods = layoutModules(p.modules, W, { kinds: BASE_KINDS, type: 'kitchen-base-run', corner: corner });
  growCorner(mods, corner, cornerDepth, 'kitchen-base-run');

  // The sinks, first: they decide the tap and where the carcass is cut.
  const sinks = [];
  mods.forEach(m => {
    if (m.kind !== 'sink') return;
    const w = m.x1 - m.x0;
    // The module shorthand for a sink centred on one module; a sink that
    // spans modules is the run-level `sink`.
    sinks.push({ cx: (m.x0 + m.x1) / 2, width: Math.max(20, Math.min(w - 6, 90)), depth: Math.min(50, D - 10),
      bowl: m.bowl, drainer: w - 6 >= 70 ? m.drainer : 'none', tap: m.tap });
  });
  const runSink = sinkSpec(p.sink, W, D);
  if (runSink) sinks.push(runSink);
  mods.forEach(m => {
    if (typeof m.splashback === 'number' && m.splashback > 0) {
      warn('kitchen-base-run: `splashback` belongs to the wall run\'s hood module now -- ignored here');
    }
  });

  // HEIGHT IS THE ENVELOPE. The worktop's top is `worktopHeight`; a tap, if
  // there is one, rises from it to exactly `height`. With no tap there is
  // nothing above the worktop, so the worktop is drawn at `height`.
  const hasTap = sinks.some(sk => sk.tap !== false);
  let H = typeof p.worktopHeight === 'number' ? p.worktopHeight : p.height;
  let tapTop = null;
  if (H > p.height) {
    warn('kitchen-base-run: worktopHeight ' + H + ' is above height ' + p.height + ' -- the worktop is drawn at height');
    H = p.height;
  }
  if (hasTap) {
    if (p.height - H > 0.01) tapTop = p.height;
    else warn('kitchen-base-run: a sink has a tap but height leaves no room above the worktop -- set height to worktopHeight + the tap (' + TAP_RISE + ' cm); tap omitted');
  } else if (p.height - H > 0.01) {
    warn('kitchen-base-run: height ' + p.height + ' is above worktopHeight ' + H + ' with no tap to fill it -- the worktop is drawn at height');
    H = p.height;
  }

  const g = new THREE.Group();
  g.name = 'furniture:kitchen-base-run';

  // Depth stack, back to front: carcass | 2 cm fronts | 3 cm worktop nosing,
  // which is where the handles stand (they never pass the worktop's edge).
  const zF1 = D - 3, zF0 = D - 5;
  const yW = H - T;                                     // worktop underside
  const fTop = style === 'rail' ? yW - 4 : yW;          // fronts' top edge
  const fBot = P;

  // The carcass and plinth, in intervals along the run: none under a `gap`
  // (a bare space under the worktop, e.g. for a freestanding appliance), cut
  // down under a sink so the bowl reads from above, full height elsewhere.
  const gapX = mods.filter(m => m.kind === 'gap').map(m => [m.x0, m.x1]);
  const sinkX = sinks.map(sk => [Math.max(-W / 2, sk.cx - sk.width / 2), Math.min(W / 2, sk.cx + sk.width / 2)]);
  const cuts = [-W / 2, W / 2];
  gapX.concat(sinkX).forEach(([a, b]) => cuts.push(a, b));
  const xs = Array.from(new Set(cuts.map(v => Math.round(v * 1000) / 1000))).sort((a, b) => a - b);
  const within = (list, x) => list.some(([a, b]) => x > a && x < b);
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], b = xs[i + 1], mid = (a + b) / 2;
    if (b - a < 0.01 || within(gapX, mid)) continue;
    const top = within(sinkX, mid) ? Math.max(P + 1, H - SINK_DEPTH - 1) : yW;
    add(g, box(THREE, mats.front, a, b, P, top, 0, zF0, 'carcass'));
    add(g, box(THREE, mats.front, a, b, 0, P, 0, D - 8, 'plinth'));
  }
  if (style === 'rail' && full) {
    // Handleless: one continuous recessed metal J-rail under the worktop.
    add(g, box(THREE, mats.handle, -W / 2, W / 2, fTop + 0.5, yW - 0.5, zF0 - 1, zF0, 'handle-rail'));
  }

  const cutouts = [];
  mods.forEach(m => {
    const w = m.x1 - m.x0;
    if (m.kind === 'drawers' || m.kind === 'hob') {
      const split = m.kind === 'hob' ? [0.35, 0.65] : [0.2, 0.4, 0.4];
      let y = fTop;
      split.forEach(fr => {
        const y0 = y - (fTop - fBot) * fr;
        frontPanel(THREE, g, mats.front, m.x0, m.x1, y0, y, zF0, zF1, 'drawer');
        if (full) addHandle(THREE, g, mats, style, { x0: m.x0, x1: m.x1, y0: y0, y1: y }, 'h-top', 'centre', zF1);
        y = y0;
      });
    } else if (m.kind === 'oven') {
      // Built-in single oven, set 1 cm back from the fronts: a metal control
      // fascia over a dark glass door, and a plain panel below to the plinth.
      const zo1 = zF1 - 1, zo0 = zF0 - 1;
      const yFas = fTop - 9, yDoor = yFas - 50;
      add(g, box(THREE, mats.steel, m.x0 + GAP, m.x1 - GAP, yFas, fTop - GAP, zo0, zo1, 'oven-fascia'));
      add(g, box(THREE, mats.dark, m.x0 + GAP, m.x1 - GAP, Math.max(fBot, yDoor), yFas, zo0, zo1, 'oven-door'));
      if (yDoor - fBot > 1) frontPanel(THREE, g, mats.front, m.x0, m.x1, fBot, yDoor, zF0, zF1, 'oven-panel');
      if (full) {
        const hy = yFas - 5;
        add(g, box(THREE, mats.steel, m.x0 + 6, m.x1 - 6, hy - 0.6, hy + 0.6, zo1, zo1 + 2.2, 'handle'));
        add(g, box(THREE, mats.dark, m.x0 + w / 2 - 5, m.x0 + w / 2 + 5, yFas + 3, yFas + 7, zo1, zo1 + 0.3, 'oven-display'));
      }
    } else if (m.kind === 'dishwasher' || m.kind === 'washer') {
      frontPanel(THREE, g, mats.front, m.x0, m.x1, fBot, fTop, zF0, zF1, m.kind);
      if (full) addHandle(THREE, g, mats, style, { x0: m.x0, x1: m.x1, y0: fBot, y1: fTop }, 'h-top', 'centre', zF1);
    } else if (m.kind === 'filler') {
      frontPanel(THREE, g, mats.front, m.x0, m.x1, fBot, fTop, zF0, zF1, 'filler');
    } else if (m.kind === 'corner') {
      blindCorner(THREE, g, mats, style, detail, m, blindSide(m, corner), cornerDepth, fBot, fTop, zF0, zF1, 'v-top');
    } else if (m.kind === 'gap') {
      // Nothing: the worktop runs over a bare space.
    } else {  // cabinet, sink
      doors(THREE, g, mats, style, detail, m, fBot, fTop, zF0, zF1, 'v-top');
    }

    if (hasHob(m)) {
      // Flush ceramic hob: the glass fills its cut-out, its top 1 mm under
      // the worktop's, burner rings just proud of the glass.
      const c = { x0: m.x0 + Math.min(3, w / 10), x1: m.x1 - Math.min(3, w / 10), z0: 5, z1: Math.min(D - 6, 57) };
      cutouts.push(c);
      add(g, box(THREE, mats.dark, c.x0, c.x1, H - 0.8, H - 0.1, c.z0, c.z1, 'hob'));
      if (full) {
        const cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
        const dx = (c.x1 - c.x0) / 4, dz = (c.z1 - c.z0) / 4;
        [[-1, -1, 8], [1, -1, 6], [-1, 1, 6], [1, 1, 9]].forEach(b => {
          add(g, cyl(THREE, mats.burner, cx + b[0] * dx, cz + b[1] * dz, H - 0.1, H - 0.02, Math.min(b[2], dx * 0.9, dz * 0.9), 16, 'hob-ring'));
        });
      }
    }

  });

  sinks.forEach(sk => {
    const c = drawSink(THREE, g, mats, sk, D, H, yW, full, sk.tap !== false ? tapTop : null);
    const clash = cutouts.find(o => o.x0 < c.x1 && o.x1 > c.x0);
    if (clash) warn('kitchen-base-run: a sink overlaps the hob along the run -- the worktop is cut for the hob only');
    else cutouts.push(c);
  });

  plinthReturn(THREE, g, mats, corner, cornerDepth, W, D, P);
  if (P > 0) {
    ledStrips(THREE, g, mods, corner, cornerDepth, W, D, {
      mat: mats.led, flag: 'plinthLed', name: 'plinth-led', zBack: 8, dz: 0.4,
      yOf: () => [Math.max(0, P - 1.4), P - 0.4],
    });
  }
  worktop(THREE, g, mats.worktop, W, D, yW, H, cutouts);
  return g;
}

// ---- kitchen-wall-run ----------------------------------------------------------

/**
 * Lay out a WALL run's modules. Unlike a base run, a wall run need not be
 * full: a hood alone on a stretch of bare wall is normal. So:
 *   - a module may give `at` (cm from the run's left end to its left edge);
 *     one without `at` follows the module before it (the first starts at 0);
 *   - kind `gap` takes up width and draws nothing;
 *   - width the modules leave unused is BARE by default (`fill: 'bare'`),
 *     or closed with filler panels (`fill: 'filler'`).
 * A module that would overlap the one before it is pushed right; one that
 * would run past the end is cut short. Both warn. Never throws.
 */
export function layoutWallModules(modules, W, fill) {
  const list = [];
  (Array.isArray(modules) ? modules : []).forEach((m, i) => {
    if (!m || typeof m !== 'object' || !(typeof m.width === 'number' && m.width > 0)) {
      warn('kitchen-wall-run: module ' + i + ' has no positive width -- skipped');
      return;
    }
    let kind = m.kind;
    if (kind === 'corner') {
      warn('kitchen-wall-run: wall runs do not corner -- module ' + i + ' is drawn as a cabinet');
      kind = 'cabinet';
    } else if (WALL_KINDS.indexOf(kind) === -1) {
      warn('kitchen-wall-run: module ' + i + ' kind ' + JSON.stringify(kind) + ' is unknown -- drawn as "cabinet"');
      kind = 'cabinet';
    }
    list.push(Object.assign({}, m, { kind: kind }));
  });
  const out = [];
  let cursor = -W / 2;
  list.forEach(m => {
    let x0 = typeof m.at === 'number' ? -W / 2 + m.at : cursor;
    if (x0 < cursor - 0.01) {
      warn('kitchen-wall-run: a ' + m.kind + ' at ' + m.at + ' cm overlaps the module before it -- moved to ' + (cursor + W / 2) + ' cm');
      x0 = cursor;
    }
    let x1 = x0 + m.width;
    if (x1 > W / 2 + 0.01) {
      warn('kitchen-wall-run: a ' + m.kind + ' runs past the end of the ' + W + ' cm run -- cut short');
      x1 = W / 2;
    }
    if (x1 - x0 < 0.5) return;
    if (fill === 'filler' && x0 - cursor > 0.05) out.push({ kind: 'filler', width: x0 - cursor, x0: cursor, x1: x0 });
    out.push(Object.assign(m, { x0: x0, x1: x1 }));
    cursor = x1;
  });
  if (fill === 'filler' && W / 2 - cursor > 0.05) out.push({ kind: 'filler', width: W / 2 - cursor, x0: cursor, x1: W / 2 });
  return out;
}


const WALL_KINDS = ['cabinet', 'open', 'hood', 'filler', 'gap'];

// Kept equal to houses/schema.json $defs/furnitureParams_kitchen-wall-run.
const WALL_DEFAULTS = deepFreeze({
  width: 180,
  depth: 30,
  height: 70,
  modules: [
    { kind: 'cabinet', width: 60, hinge: 'left' },
    { kind: 'hood', width: 60, style: 'chimney', visor: 'smoked' },
    { kind: 'cabinet', width: 60, hinge: 'right' },
  ],
  fill: 'bare',
  frontColor: '#f2f0ea',
  frontFinish: 'gloss',
  handleStyle: 'bar',
  handleColor: '#c9cccf',
  underLedColor: '#ffb45a',
  topLedColor: '#ffb45a',
});

/**
 * The elevation that puts a wall run's TOP at `topCm` above the floor. Wall
 * runs line up by their tops: a 70 cm unit 50 cm over a 90 cm worktop and a
 * 55 cm unit 65 cm over it share the top line 210. A run's modules
 * already hang from its top (each module's bottom follows from its own
 * height), so the placer needs only this one number per run -- and a
 * fridge-freezer that should meet the same line takes `height: topCm`.
 */
export function elevationForTop(topCm, wallParams) {
  const p = resolve(WALL_DEFAULTS, wallParams);
  return topCm - p.height;
}

function buildWallRun(THREE, params, opts) {
  const p = resolve(WALL_DEFAULTS, params);
  const detail = opts && opts.detail === 'low' ? 'low' : 'full';
  const full = detail === 'full';
  const W = p.width, D = p.depth, H = p.height;
  // Wall units do not corner: each hangs whole on its own wall, however the
  // base runs below them meet. A `corner` given here is ignored.
  if (p.corner !== undefined && p.corner !== 'none') {
    warn('kitchen-wall-run: wall runs do not corner -- `corner` ' + JSON.stringify(p.corner) + ' is ignored');
  }
  const corner = 'none', cornerDepth = 0;
  let style = handleStyleOf(p);
  if (style === 'rail') style = 'none';   // wall units have no J-rail: handleless
  const mats = materials(THREE, p);
  const mods = layoutWallModules(p.modules, W, p.fill === 'filler' ? 'filler' : 'bare');

  const g = new THREE.Group();
  g.name = 'furniture:kitchen-wall-run';
  // Handles stand 2.5 cm proud of the fronts; without handles the fronts
  // come forward to the run's front plane.
  const zF1 = D - (style === 'bar' || style === 'knob' ? 2.5 : 0.1), zF0 = zF1 - 2;

  mods.forEach(m => {
    let mh = typeof m.height === 'number' && m.height > 0 ? m.height : H;
    if (mh > H) {
      warn('kitchen-wall-run: a ' + m.kind + ' module is ' + mh + ' cm tall but the run is ' + H + ' cm -- clamped');
      mh = H;
    }
    const y0 = H - mh, w = m.x1 - m.x0;

    if (m.kind === 'gap') return;       // bare wall

    if (m.kind === 'hood') {
      // A splashback hangs on the wall under the hood, down to the worktop.
      // It is part of this run, so the run's height reaches down to it.
      const sb = typeof m.splashback === 'number' && m.splashback > 0 ? Math.min(m.splashback, y0) : 0;
      if (typeof m.splashback === 'number' && m.splashback > y0 + 0.01) {
        warn('kitchen-wall-run: the splashback is ' + m.splashback + ' cm but only ' + y0 + ' cm fits under the hood in a ' + H + ' cm run -- raise the run\'s height');
      }
      if (sb > 0) add(g, box(THREE, mats.steel, m.x0, m.x1, y0 - sb, y0, 0, 0.4, 'splashback'));
      if (m.style === 'canopy') {
        // Integrated canopy: a slim metal hood under a short cabinet.
        const yc = y0 + Math.min(14, mh);
        add(g, box(THREE, mats.steel, m.x0 + GAP, m.x1 - GAP, y0, yc, 0, zF1, 'hood'));
        if (H - yc > 1) {
          add(g, box(THREE, mats.front, m.x0, m.x1, yc, H, 0, zF0, 'carcass'));
          doors(THREE, g, mats, style, detail, m, yc, H, zF0, zF1, 'v-bot');
        }
      } else {
        // Chimney: a flue up to the run's top over a canopy at the bottom,
        // with a flat visor out to the run's front edge.
        const fw = Math.min(28, w - 4), fd = Math.min(24, D - 4), cx = (m.x0 + m.x1) / 2;
        add(g, box(THREE, mats.steel, cx - fw / 2, cx + fw / 2, y0 + 4, H, 0, fd, 'hood-flue'));
        add(g, box(THREE, mats.steel, m.x0, m.x1, y0, y0 + 4, 0, D * 0.7, 'hood'));
        const visor = m.visor === 'glass' ? mats.glass : m.visor === 'metal' ? mats.steel : mats.smoked;
        add(g, box(THREE, visor, m.x0, m.x1, y0 + 4, y0 + 4.8, 0, D, 'hood-visor'));
      }
      return;
    }

    if (m.kind === 'open') {
      // An open shelf unit: back, sides, top, bottom and one shelf.
      const t = 1.8;
      add(g, box(THREE, mats.front, m.x0, m.x1, y0, H, 0, t, 'open-back'));
      add(g, box(THREE, mats.front, m.x0, m.x0 + t, y0, H, t, D, 'open-side'));
      add(g, box(THREE, mats.front, m.x1 - t, m.x1, y0, H, t, D, 'open-side'));
      add(g, box(THREE, mats.front, m.x0 + t, m.x1 - t, y0, y0 + t, t, zF1, 'open-shelf'));
      add(g, box(THREE, mats.front, m.x0 + t, m.x1 - t, H - t, H, t, zF1, 'open-shelf'));
      if (full && mh > 30) add(g, box(THREE, mats.front, m.x0 + t, m.x1 - t, (y0 + H) / 2 - t / 2, (y0 + H) / 2 + t / 2, t, zF1 - 1, 'open-shelf'));
      return;
    }

    // A flagged LED sits in a 1 cm recess under the carcass (behind the
    // fronts' lip) or a 0.5 cm one on top of it.
    const cy0 = y0 + (m.underLed === true ? 1 : 0), cy1 = H - (m.topLed === true ? 0.5 : 0);
    add(g, box(THREE, mats.front, m.x0, m.x1, cy0, cy1, 0, zF0, 'carcass'));
    if (m.kind === 'filler') frontPanel(THREE, g, mats.front, m.x0, m.x1, y0, H, zF0, zF1, 'filler');
    else doors(THREE, g, mats, style, detail, m, y0, H, zF0, zF1, 'v-bot');
  });

  // LEDs only where there is a carcass to recess them into.
  const lit = mods.filter(m => m.kind === 'cabinet' || m.kind === 'filler');
  const hOf = m => Math.min(H, typeof m.height === 'number' && m.height > 0 ? m.height : H);
  const zBack = D - zF0 + 1.5;
  ledStrips(THREE, g, lit, corner, cornerDepth, W, D, {
    mat: mats.underLed, flag: 'underLed', name: 'under-led', zBack: zBack, dz: 1,
    yOf: m => [H - hOf(m) + 0.5, H - hOf(m) + 0.9],
  });
  ledStrips(THREE, g, lit, corner, cornerDepth, W, D, {
    mat: mats.topLed, flag: 'topLed', name: 'top-led', zBack: zBack, dz: 1,
    yOf: () => [H - 0.4, H],
  });

  // Bar handles stop 0.3 cm short of the front plane (inside the contract's
  // 0.5 cm); open units' sides and a chimney visor reach it.
  return g;
}

// ---- fridge-freezer --------------------------------------------------------------

// Kept equal to houses/schema.json $defs/furnitureParams_fridge-freezer.
// The default height is a typical wall units' top line, 210: an integrated
// tall unit meets it. For another line, set `height` to it.
const FRIDGE_DEFAULTS = deepFreeze({
  width: 60,
  depth: 60,
  height: 210,
  frontColor: '#f2f0ea',
  frontFinish: 'gloss',
  handleStyle: 'bar',
  handleColor: '#c9cccf',
  freezer: 'bottom',
  freezerHeight: 90,
  plinthHeight: 13,
  hinge: 'right',
  plinthLed: false,
  ledColor: '#ffb45a',
  topLed: false,
  topLedColor: '#ffb45a',
});

/**
 * A full-height two-door fridge-freezer housing: carcass on the same recessed
 * plinth as the base runs, a freezer door `freezerHeight` tall (bottom or
 * top) and the fridge door taking the rest.
 */
function buildFridge(THREE, params, opts) {
  const p = resolve(FRIDGE_DEFAULTS, params);
  const full = !(opts && opts.detail === 'low');
  const W = p.width, D = p.depth, H = p.height;
  const style = handleStyleOf(p);
  const mats = materials(THREE, p);
  const g = new THREE.Group();
  g.name = 'furniture:fridge-freezer';

  const P = Math.max(0, Math.min(30, typeof p.plinthHeight === 'number' ? p.plinthHeight : 13));
  const zF1 = D - (style === 'bar' || style === 'knob' ? 2.5 : 0), zF0 = zF1 - 2;
  const lit = p.topLed === true;
  add(g, box(THREE, mats.front, -W / 2, W / 2, P, H - (lit ? 0.5 : 0), 0, zF0, 'cabinet'));
  // A strip on top, behind the doors -- to carry a wall run's top strip over it.
  if (lit) add(g, box(THREE, mats.topLed, -W / 2, W / 2, H - 0.4, H, zF0 - 2.5, zF0 - 1.5, 'top-led'));
  if (P > 0) {
    add(g, box(THREE, mats.front, -W / 2, W / 2, 0, P, 0, D - 8, 'plinth'));
    if (p.plinthLed === true) add(g, box(THREE, mats.led, -W / 2, W / 2, Math.max(0, P - 1.4), P - 0.4, D - 8, D - 7.6, 'plinth-led'));
  }
  const span = H - P;
  const fz = Math.max(20, Math.min(span - 20, typeof p.freezerHeight === 'number' ? p.freezerHeight : 90));
  const split = p.freezer === 'top' ? H - fz : P + fz;
  const lower = { x0: -W / 2, x1: W / 2, y0: P, y1: split };
  const upper = { x0: -W / 2, x1: W / 2, y0: split, y1: H };
  frontPanel(THREE, g, mats.front, lower.x0, lower.x1, lower.y0, lower.y1, zF0, zF1, 'door');
  frontPanel(THREE, g, mats.front, upper.x0, upper.x1, upper.y0, upper.y1, zF0, zF1, 'door');
  if (full && (style === 'bar' || style === 'knob')) {
    const edge = p.hinge === 'left' ? 'right' : 'left';
    const x = edge === 'left' ? -W / 2 + 4 : W / 2 - 4;
    [lower, upper].forEach(d => {
      // Short vertical bars either side of the split, where a hand goes for either door.
      const len = style === 'knob' ? 2 : Math.min(16, (d.y1 - d.y0) * 0.4);
      const y1 = d === lower ? d.y1 - 6 : d.y0 + 6 + len;
      add(g, box(THREE, mats.handle, x - 0.6, x + 0.6, y1 - len, y1, zF1, D, 'handle'));
    });
  }
  return g;
}

// ---- exports ---------------------------------------------------------------------

export const TYPES = Object.freeze({
  'kitchen-base-run': Object.freeze({ DEFAULTS: BASE_DEFAULTS, build: buildBaseRun }),
  'kitchen-wall-run': Object.freeze({ DEFAULTS: WALL_DEFAULTS, build: buildWallRun }),
  'fridge-freezer': Object.freeze({ DEFAULTS: FRIDGE_DEFAULTS, build: buildFridge }),
});

export { buildBaseRun, buildWallRun, buildFridge };
export const BASE_MODULE_KINDS = Object.freeze(BASE_KINDS.slice());
export const WALL_MODULE_KINDS = Object.freeze(WALL_KINDS.slice());

/**
 * A generic L-shaped kitchen, as the spec page previews it and the kitchen
 * test checks it: the owning base run A along the back wall (corner at its
 * LEFT end, against the left wall), base run B along the left wall stopping
 * at A's front face, a wall run over each (the one over A owns the wall
 * corner), and a fridge-freezer at A's far end.
 *
 * Returns poses in the frame the spec page uses: centimetres, the inside
 * corner of the two walls at the origin, the back wall along +x (items on it
 * face +z) and the left wall along +z (items on it face +x). `rotY` is a
 * three.js rotation about y, in radians. Placement in a real house is the
 * placer's job; this exists so the page and the test share one L.
 *
 * @param {{a, b, wall, wallB, fridge: Object, wallTop?: number}} items
 *   each a params object (merged over its type's DEFAULTS); `wallTop` is the
 *   wall units' top line in cm (default 210)
 */
export function exampleLPoses(items) {
  const a = resolve(BASE_DEFAULTS, items.a), b = resolve(BASE_DEFAULTS, items.b);
  const w = resolve(WALL_DEFAULTS, items.wall), wb = resolve(WALL_DEFAULTS, items.wallB);
  const f = resolve(FRIDGE_DEFAULTS, items.fridge);
  const top = typeof items.wallTop === 'number' ? items.wallTop : 210;
  return {
    a: { type: 'kitchen-base-run', x: a.width / 2, y: 0, z: 0, rotY: 0 },
    b: { type: 'kitchen-base-run', x: 0, y: 0, z: a.depth + b.width / 2, rotY: Math.PI / 2 },
    wall: { type: 'kitchen-wall-run', x: w.width / 2, y: elevationForTop(top, w), z: 0, rotY: 0 },
    // Each wall run measured from the same (left) end as the base run under
    // it, so a module's `at` lines up with the base modules below.
    wallB: { type: 'kitchen-wall-run', x: 0, y: elevationForTop(top, wb), z: a.depth + b.width - wb.width / 2, rotY: Math.PI / 2 },
    fridge: { type: 'fridge-freezer', x: a.width + 1 + f.width / 2, y: 0, z: 0, rotY: 0 },
  };
}

/**
 * The generic L the spec page opens on and the kitchen test builds. Invented
 * sizes in standard widths -- not any real kitchen.
 */
export const EXAMPLE_L = deepFreeze({
  a: {
    width: 240,
    corner: 'left',
    cornerDepth: 62,
    modules: [
      { kind: 'corner', width: 70, plinthLed: true },
      { kind: 'drawers', width: 50, plinthLed: true },
      { kind: 'oven', width: 60, hob: true },
      { kind: 'cabinet', width: 60, hinge: 'top' },
    ],
  },
  b: {
    width: 180,
    depth: 62,
    // Worktop 88.5 plus the tap's 30: the run's envelope.
    height: 118.5,
    modules: [
      { kind: 'cabinet', width: 30, hinge: 'left', plinthLed: true },
      { kind: 'cabinet', width: 60, hinge: 'right', plinthLed: true },
      { kind: 'dishwasher', width: 60, plinthLed: true },
      { kind: 'cabinet', width: 30, hinge: 'right', plinthLed: true },
    ],
    // One 90 cm inset sink spanning the 60 cabinet and the dishwasher.
    sink: { at: 80, width: 90, depth: 50, bowl: 'inset', drainer: 'right' },
  },
  wall: {
    width: 240,
    // From the worktop (the splashback's bottom) to the 210 top line.
    height: 121.5,
    modules: [
      // One 70 cm door from the wall: a hinge given means one door.
      { kind: 'cabinet', width: 70, height: 70, hinge: 'left', underLed: true, topLed: true },
      { kind: 'cabinet', width: 50, height: 70, hinge: 'right', underLed: true, topLed: true },
      { kind: 'hood', width: 60, height: 60, style: 'chimney', visor: 'smoked', splashback: 61.5 },
      { kind: 'cabinet', width: 60, height: 55, hinge: 'top', underLed: true, topLed: true },
    ],
  },
  wallB: {
    width: 160,
    // Two cabinets with 40 cm of bare wall between them (`at`, no filler).
    modules: [
      { kind: 'cabinet', width: 60, height: 55, hinge: 'left', underLed: true, topLed: true },
      { kind: 'cabinet', width: 60, at: 100, hinge: 'right', underLed: true, topLed: true },
    ],
  },
  fridge: { topLed: true },
  // The line every wall unit's top, and the fridge-freezer's, meets.
  wallTop: 210,
});

/**
 * A full L kitchen as measured: the preset KitchenSpec opens on.
 * Dimensions only. Run A (65 deep) owns the corner; run B (60 deep, 214
 * long: 60/60/60/34) starts at A's front face, so the leg along B's wall is
 * 65 + 214 = 279. A's `cornerDepth` is B's 60 -- the square B hides -- which
 * is exactly its 60 cm corner module. Every run's modules fill its width,
 * so it builds with no warnings at all.
 */
export const FULL_RUN_L = deepFreeze({
  a: {
    width: 290,
    depth: 65,
    height: 118.5,
    modules: [
      {kind: 'corner', width: 60, plinthLed: true},
      {kind: 'cabinet', width: 50, plinthLed: true},
      {kind: 'cabinet', width: 60, plinthLed: true},
      {kind: 'dishwasher', width: 60, plinthLed: true},
      {kind: 'cabinet', width: 60, hinge: 'bottom', plinthLed: true},
    ],
    corner: 'left',
    cornerDepth: 60,
    sink: {at: 120, width: 90, depth: 50, bowl: 'inset', drainer: 'right'},
  },
  b: {
    width: 214,
    depth: 60,
    modules: [
      {kind: 'cabinet', width: 60, hinge: 'left'},
      {kind: 'oven', width: 60, hob: true},
      {kind: 'cabinet', width: 60, plinthLed: true, hinge: 'right'},
      {kind: 'cabinet', width: 34, hinge: 'right', plinthLed: true},
    ],
  },
  wall: {
    width: 290,
    height: 121.5,
    modules: [
      {kind: 'cabinet', width: 65, underLed: true, topLed: true, height: 70, hinge: 'left'},
      {kind: 'cabinet', width: 45, height: 70, underLed: true, topLed: true, hinge: 'left'},
      {kind: 'cabinet', width: 60, height: 55, hinge: 'right', underLed: true, topLed: true},
      {kind: 'cabinet', width: 60, underLed: true, topLed: true, height: 55},
      {kind: 'cabinet', width: 60, height: 70, hinge: 'right', underLed: true, topLed: true},
    ],
  },
  wallB: {
    width: 160,
    height: 121.5,
    modules: [
      // Centred over the oven (base run B, module 1) as drawn: see resolveAlignment().
      {kind: 'hood', width: 60, style: 'chimney', visor: 'smoked', splashback: 61.5, height: 60, alignTo: {run: 'b', module: 1}},
    ],
  },
  fridge: {
    width: 65,
    plinthLed: true,
    topLed: true,
  },
  wallTop: 210,
});

/** The presets KitchenSpec offers, the first being the one it opens on. */
export const KITCHEN_PRESETS = Object.freeze([
  Object.freeze({ id: 'l-full-run', label: 'L kitchen, full run', items: FULL_RUN_L }),
  Object.freeze({ id: 'l-example', label: 'Generic example L', items: EXAMPLE_L }),
]);
export const DEFAULT_PRESET = 'l-full-run';

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => sameValue(a[k], b[k]));
}

/**
 * The params that differ from `type`'s DEFAULTS -- what the spec page's
 * Copy JSON emits, since anything left out falls back to DEFAULTS anyway.
 * `width` is always kept for a run: it is the footprint, and a reader should
 * never have to know the default to see how long a run is.
 */
export function paramsDiff(type, params) {
  const impl = TYPES[type];
  if (!impl) return null;
  const out = {};
  Object.keys(params || {}).forEach(k => {
    const v = params[k];
    if (v === undefined) return;
    const keepWidth = k === 'width' && type !== 'fridge-freezer';
    if (keepWidth || !sameValue(v, impl.DEFAULTS[k])) out[k] = v;
  });
  return out;
}

/**
 * Why `params` cannot be built as `type`, as a list of messages -- empty when
 * it can. For data arriving from outside (the spec page's Load JSON): the
 * builders shrug off a bad field with a warning, but a list that is not a
 * list, or a module that is not an object, is not something to draw.
 *   - width / depth / height / worktopHeight: positive numbers when given
 *   - modules: an array of objects, each with a string `kind` and a positive
 *     numeric `width`; `hinge` one of left/right/top (left/right on a fridge);
 *     `height`, `at`, `splashback` numbers when given
 *   - sink: null or an object with numeric fields
 */
export function validateParams(type, params) {
  const errs = [];
  if (!TYPES[type]) return ['unknown type ' + JSON.stringify(type)];
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['params must be an object'];
  const posNum = v => typeof v === 'number' && isFinite(v) && v > 0;
  const num = v => typeof v === 'number' && isFinite(v);
  ['width', 'depth', 'height', 'worktopHeight'].forEach(k => {
    if (params[k] !== undefined && !posNum(params[k])) errs.push(k + ' must be a positive number');
  });
  if (type === 'fridge-freezer') {
    if (params.hinge !== undefined && ['left', 'right'].indexOf(params.hinge) === -1) errs.push('hinge must be left or right');
    return errs;
  }
  if (params.modules !== undefined) {
    if (!Array.isArray(params.modules)) errs.push('modules must be an array');
    else params.modules.forEach((m, i) => {
      const at = 'modules[' + i + ']';
      if (!m || typeof m !== 'object' || Array.isArray(m)) { errs.push(at + ' must be an object'); return; }
      if (typeof m.kind !== 'string') errs.push(at + '.kind must be a string');
      if (!posNum(m.width)) errs.push(at + '.width must be a positive number');
      if (m.hinge !== undefined && HINGES.indexOf(m.hinge) === -1) errs.push(at + '.hinge must be left, right, top or bottom');
      if (m.alignTo !== undefined) {
        const a = m.alignTo;
        if (!a || typeof a !== 'object' || typeof a.run !== 'string' || !(Number.isInteger(a.module) && a.module >= 0)) {
          errs.push(at + '.alignTo must be { run: <piece key>, module: <index> }');
        }
      }
      ['height', 'at', 'splashback'].forEach(k => {
        if (m[k] !== undefined && !num(m[k])) errs.push(at + '.' + k + ' must be a number');
      });
    });
  }
  if (type === 'kitchen-base-run' && params.sink !== undefined && params.sink !== null) {
    if (typeof params.sink !== 'object' || Array.isArray(params.sink)) errs.push('sink must be null or an object');
    else ['at', 'width', 'depth'].forEach(k => {
      if (params.sink[k] !== undefined && !num(params.sink[k])) errs.push('sink.' + k + ' must be a number');
    });
  }
  return errs;
}

/**
 * Read what the spec page's Copy JSON gives -- an array of {type, params} in
 * slot order -- back into params, or THROW with a message naming the entry.
 * Nothing is returned unless every entry validates (validateParams) AND a
 * trial build of every piece succeeds, so a caller can swap its state only
 * on success and keep what it had on failure. A wall run's `corner` /
 * `cornerDepth` (from an older export) are dropped: wall runs do not corner.
 *
 * @param {string} text
 * @param {string[]} slots  the type expected at each position
 * @param {Object} THREE    for the trial build
 * @returns {Object[]} one params object per entry given (merged over DEFAULTS)
 */
export function parseKitchenJson(text, slots, THREE) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('expected an array, as Copy JSON gives');
  return arr.map((entry, i) => {
    const type = slots[i];
    if (!type) throw new Error('entry ' + (i + 1) + ' has no slot (there are ' + slots.length + ' pieces)');
    if (!entry || entry.type !== type) throw new Error('entry ' + (i + 1) + ' should be a ' + type);
    const params = JSON.parse(JSON.stringify(entry.params === undefined ? {} : entry.params));
    if (type === 'kitchen-wall-run' && params && typeof params === 'object') { delete params.corner; delete params.cornerDepth; }
    const errs = validateParams(type, params);
    if (errs.length) throw new Error('entry ' + (i + 1) + ': ' + errs.slice(0, 3).join('; '));
    const full = Object.assign(JSON.parse(JSON.stringify(TYPES[type].DEFAULTS)), params);
    try {
      TYPES[type].build(THREE, full, { detail: 'low' });
    } catch (e) {
      throw new Error('entry ' + (i + 1) + ' does not build: ' + (e && e.message ? e.message : e));
    }
    return full;
  });
}

/**
 * Where a base run's modules are DRAWN, in cm from the run's left end:
 * [[x0, x1], ...] in module order, after the builder's fitting (a short run
 * padded, a long one squeezed, an owner's corner module widened). Silent:
 * the build itself is where those warnings belong.
 */
export function baseModuleSpans(params) {
  const p = resolve(BASE_DEFAULTS, params);
  const W = p.width;
  const corner = ['left', 'right'].indexOf(p.corner) === -1 ? 'none' : p.corner;
  const cornerDepth = Math.max(10, Math.min(W, typeof p.cornerDepth === 'number' ? p.cornerDepth : 60));
  quiet++;
  try {
    const mods = layoutModules(p.modules, W, { kinds: BASE_KINDS, type: 'kitchen-base-run', corner: corner });
    growCorner(mods, corner, cornerDepth, 'kitchen-base-run');
    // Only the entries the author wrote (a padding filler has no index).
    const out = [];
    let k = 0;
    (Array.isArray(p.modules) ? p.modules : []).forEach(m => {
      if (!m || typeof m !== 'object' || !(typeof m.width === 'number' && m.width > 0)) { out.push(null); return; }
      while (k < mods.length && mods[k].kind === 'filler' && m.kind !== 'filler') k++;
      const d = mods[k++];
      out.push(d ? [d.x0 + W / 2, d.x1 + W / 2] : null);
    });
    return out;
  } finally {
    quiet--;
  }
}

/**
 * ALIGNMENT. A wall-run module may say `alignTo: { run: 'b', module: 1 }` --
 * centre me over module 1 of the base run keyed 'b' in the same set of
 * pieces. A wall run is measured from the same (left) end as the base run
 * under it, so this sets the module's `at` to centre it on that base module
 * AS DRAWN: however the base run is fitted (squeezed, padded), the hood
 * stays over the oven.
 *
 * Takes and returns a map of piece key -> params (pieces without wall
 * modules pass through); a wall module's `at` is replaced whenever it has a
 * resolvable `alignTo`, and `alignTo` itself is kept so it survives Copy
 * JSON. An alignTo naming a missing run or module is left alone, with a
 * warning. Never throws.
 */
export function resolveAlignment(pieces) {
  const out = Object.assign({}, pieces);
  Object.keys(pieces).forEach(key => {
    const p = pieces[key];
    if (!p || typeof p !== 'object' || !Array.isArray(p.modules)) return;
    if (!p.modules.some(m => m && m.alignTo)) return;
    const mods = p.modules.map(m => {
      if (!m || !m.alignTo) return m;
      const base = pieces[m.alignTo.run];
      const spans = base && Array.isArray(base.modules) ? baseModuleSpans(base) : null;
      const span = spans ? spans[m.alignTo.module] : null;
      if (!span) {
        warn('alignTo ' + JSON.stringify(m.alignTo) + ' names no drawn base module -- `at` left as it is');
        return m;
      }
      const at = Math.round(((span[0] + span[1]) / 2 - m.width / 2) * 100) / 100;
      return Object.assign({}, m, { at: Math.max(0, at) });
    });
    out[key] = Object.assign({}, p, { modules: mods });
  });
  return out;
}
