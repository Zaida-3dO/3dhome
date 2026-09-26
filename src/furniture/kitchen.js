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
 *              dishwasher | washer | filler | corner
 *     cabinet / sink / corner   hinge: 'left' | 'right' (single door; the
 *                               handle goes on the other edge). Over 60 cm
 *                               wide a cabinet or sink gets two doors.
 *     oven                      hob: true puts a hob in the worktop above it
 *     hob, oven+hob             splashback: <cm tall> (0 = none) -- a metal
 *                               wall protector standing on the worktop
 *                               behind the hob, up toward the hood
 *     sink                      bowl: 'inset' | 'undermount', tap: true|false
 *     any                       plinthLed: true -- a warm LED strip on the
 *                               plinth under this module (see plinthLed())
 *
 *   wall run:  { kind, width, height? }  kind = cabinet | open | hood |
 *              filler | corner. `height` defaults to the run's height and may
 *              differ per module (86 next to 66, say). Module TOPS align at
 *              the run's top; the placer sets `elevation` for the run's
 *              bottom, which is the bottom of its tallest module.
 *     hood                      style: 'chimney' | 'canopy',
 *                               visor: 'smoked' | 'glass' | 'metal'
 *                               (chimney only). 'smoked' is dark gloss and
 *                               merges; 'glass' is a real transparent part
 *                               and costs the kitchen a draw of its own.
 *
 * WIDTH IS AUTHORITATIVE. `params.width` is the run's footprint (the
 * validator reads it too, so a run cannot quietly be wider than it says).
 * When the modules add up to less, a filler closes the gap at the end away
 * from the corner; when they add up to more, every module is scaled down to
 * fit. Either way a warning names the mismatch.
 *
 * CORNERS. `corner: 'left' | 'right'` says this run OWNS the corner at that
 * end: it ends in a blind corner unit (a `corner` module, whose blind panel
 * faces that end) and its worktop runs right to the wall. The other run of an
 * L is authored to stop at the owner's front face, so their worktops meet
 * without overlapping or gapping even when the two runs differ in depth (a
 * 60 leg and a 65 leg, say). The owner is told the other run's depth in
 * `cornerDepth`: that is how much of its blind corner is hidden, and where
 * its plinth return (and LED) turns. A run that does not own a corner is
 * `'none'`. Each run's worktop is exactly its own `depth` deep.
 *
 * ABOVE THE WORKTOP. A base run's `height` is the TOP OF ITS WORKTOP -- the
 * number the fade rule and footprints care about. Two accessories stand on
 * the worktop and so rise above it: a sink's tap and a hob's splashback. They
 * are the only parts allowed above `height`, each is tagged
 * `userData.aboveWorktop = true`, and scripts/test-furniture-kitchen.mjs
 * pins that nothing else is. Neither is in DEFAULTS, so a run built at its
 * defaults meets the bounding-box contract exactly.
 *
 * DRAWS. A kitchen is drawn in four palette finishes -- `matte` (worktop,
 * hob burners), `gloss` (fronts, carcass, plinth, oven door, hob glass, a
 * smoked hood visor), `metal` (handles, oven fascia, sink, tap, hood,
 * splashback) and one kept `emissive` colour for the plinth LED -- so the
 * whole merged L costs four draws, whatever `frontFinish` is. The one opt-in
 * that costs more is a `glass` hood visor, and it says so where it lives.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

const CM = 0.01;

// ---- shared helpers ------------------------------------------------------------

function deepFreeze(o) {
  Object.values(o).forEach(v => { if (v && typeof v === 'object') deepFreeze(v); });
  return Object.freeze(o);
}

function warn(msg) { console.warn('[furniture:kitchen] ' + msg); }

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
    burner: makeFinish(THREE, 'matte', '#4a4b4e'),
    glass: makeFinish(THREE, 'glass', '#d6e6ea'),
    smoked: makeFinish(THREE, 'gloss', '#3a3f44'),
    led: makeFinish(THREE, 'emissive', p.ledColor || '#ffb45a'),
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
    const y = where === 'v-bot' ? f.y0 + 5 : f.y1 - 5;
    add(g, box(THREE, mats.handle, x - 0.9, x + 0.9, y - 0.9, y + 0.9, zFace, zFace + 2.2, 'handle'));
    return;
  }
  if (where === 'h-top') {
    const len = Math.min(24, w * 0.5);
    const y = f.y1 - Math.min(4, h / 4);
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
function doors(THREE, g, mats, style, detail, m, y0, y1, z0, z1, where) {
  const full = detail !== 'low';
  if (m.x1 - m.x0 > 60.5) {
    const xm = (m.x0 + m.x1) / 2;
    frontPanel(THREE, g, mats.front, m.x0, xm, y0, y1, z0, z1, 'door');
    frontPanel(THREE, g, mats.front, xm, m.x1, y0, y1, z0, z1, 'door');
    if (full) {
      addHandle(THREE, g, mats, style, { x0: m.x0, x1: xm, y0: y0, y1: y1 }, where, 'right', z1);
      addHandle(THREE, g, mats, style, { x0: xm, x1: m.x1, y0: y0, y1: y1 }, where, 'left', z1);
    }
    return;
  }
  frontPanel(THREE, g, mats.front, m.x0, m.x1, y0, y1, z0, z1, 'door');
  if (full) addHandle(THREE, g, mats, style, { x0: m.x0, x1: m.x1, y0: y0, y1: y1 }, where, m.hinge === 'right' ? 'left' : 'right', z1);
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

const BASE_KINDS = ['cabinet', 'drawers', 'oven', 'hob', 'sink', 'dishwasher', 'washer', 'filler', 'corner'];

// Kept equal to houses/schema.json $defs/furnitureParams_kitchen-base-run by
// scripts/test-furniture-defaults.mjs.
const BASE_DEFAULTS = deepFreeze({
  width: 180,
  depth: 60,
  height: 88.5,
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
 * The plinth return and the plinth LED strip.
 *
 * A run that OWNS a corner closes its plinth recess with a short return at
 * the line where the other run's plinth face will be -- `cornerDepth`, the
 * other run's depth, less its 8 cm plinth set-back -- so the kickboards meet
 * at the inside corner.
 *
 * The LED strip is a warm emissive line along the top of the plinth face
 * under every module flagged `plinthLed: true`; adjacent flagged modules
 * share one strip. When the owner's corner module is flagged the strip stops
 * at that return and turns along it to the run's front edge -- exactly where
 * the other run's strip, run to its own corner end, picks up. So an L lit
 * round the corner is two runs each flagging the modules either side of it,
 * and the line is continuous without either run drawing outside its box.
 */
function plinthLed(THREE, g, mats, mods, corner, cornerDepth, W, D, P) {
  const zP = D - 8;                                  // plinth face
  const reach = cornerDepth - 8;                     // wall -> other run's plinth face
  let xr = null;                                     // the return's face, if any
  if (corner === 'left') xr = -W / 2 + reach;
  if (corner === 'right') xr = W / 2 - reach;
  if (xr !== null && P > 0) {
    const t = 1.8;
    add(g, corner === 'left'
      ? box(THREE, mats.front, xr - t, xr, 0, P, zP, D, 'plinth-return')
      : box(THREE, mats.front, xr, xr + t, 0, P, zP, D, 'plinth-return'));
  }
  if (P <= 0) return;
  const led = mats.led;
  const y0 = Math.max(0, P - 1.4), y1 = P - 0.4, dz = 0.4;
  // Contiguous spans of flagged modules.
  const spans = [];
  mods.forEach(m => {
    if (m.plinthLed !== true) return;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last.x1 - m.x0) < 0.01) { last.x1 = m.x1; last.mods.push(m); }
    else spans.push({ x0: m.x0, x1: m.x1, mods: [m] });
  });
  spans.forEach(s => {
    let x0 = s.x0, x1 = s.x1, turn = false;
    if (corner === 'left' && Math.abs(x0 + W / 2) < 0.01 && s.mods[0].kind === 'corner') { x0 = xr; turn = true; }
    if (corner === 'right' && Math.abs(x1 - W / 2) < 0.01 && s.mods[s.mods.length - 1].kind === 'corner') { x1 = xr; turn = true; }
    if (x1 - x0 > 0.5) add(g, box(THREE, led, x0, x1, y0, y1, zP, zP + dz, 'plinth-led'));
    if (turn) {
      add(g, corner === 'left'
        ? box(THREE, led, xr, xr + dz, y0, y1, zP, D, 'plinth-led')
        : box(THREE, led, xr - dz, xr, y0, y1, zP, D, 'plinth-led'));
    }
  });
}

function buildBaseRun(THREE, params, opts) {
  const p = resolve(BASE_DEFAULTS, params);
  const detail = opts && opts.detail === 'low' ? 'low' : 'full';
  const full = detail === 'full';
  const W = p.width, D = p.depth, H = p.height;
  const T = Math.max(1, Math.min(10, p.worktopThickness));
  const P = Math.max(0, Math.min(30, p.plinthHeight));
  const corner = checkCorner(p.corner, 'kitchen-base-run');
  const cornerDepth = Math.max(10, Math.min(W, typeof p.cornerDepth === 'number' ? p.cornerDepth : 60));
  const style = handleStyleOf(p);
  const mats = materials(THREE, p);
  const mods = layoutModules(p.modules, W, { kinds: BASE_KINDS, type: 'kitchen-base-run', corner: corner });

  const g = new THREE.Group();
  g.name = 'furniture:kitchen-base-run';

  // Depth stack, back to front: carcass | 2 cm fronts | 3 cm worktop nosing,
  // which is where the handles stand (they never pass the worktop's edge).
  const zF1 = D - 3, zF0 = D - 5;
  const yW = H - T;                                     // worktop underside
  const fTop = style === 'rail' ? yW - 4 : yW;          // fronts' top edge
  const fBot = P;

  add(g, box(THREE, mats.front, -W / 2, W / 2, P, yW, 0, zF0, 'carcass'));
  add(g, box(THREE, mats.front, -W / 2, W / 2, 0, P, 0, D - 8, 'plinth'));
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
      const sb = typeof m.splashback === 'number' ? m.splashback : 0;
      if (sb > 0) {
        const s = add(g, box(THREE, mats.steel, m.x0, m.x1, H, H + sb, 0, 0.4, 'splashback'));
        if (s) s.userData.aboveWorktop = true;
      }
    }

    if (m.kind === 'sink') {
      // One bowl, inset (a metal rim flush with the worktop) or undermount
      // (the worktop's cut edge shows). Tap behind it, on the worktop.
      const inset = m.bowl !== 'undermount';
      const bw = Math.max(10, Math.min(w - 16, 76)), cx = (m.x0 + m.x1) / 2;
      const bz0 = 9, bz1 = Math.max(bz0 + 10, Math.min(D - 10, 51));
      const rim = inset ? 1.5 : 0;
      cutouts.push({ x0: cx - bw / 2 - rim, x1: cx + bw / 2 + rim, z0: bz0 - rim, z1: bz1 + rim });
      const bx0 = cx - bw / 2, bx1 = cx + bw / 2;
      const top = inset ? H - 0.1 : yW, bottom = H - 20, t = 0.6;
      add(g, box(THREE, mats.steel, bx0, bx1, bottom, bottom + t, bz0, bz1, 'sink'));
      add(g, box(THREE, mats.steel, bx0, bx0 + t, bottom, top, bz0, bz1, 'sink'));
      add(g, box(THREE, mats.steel, bx1 - t, bx1, bottom, top, bz0, bz1, 'sink'));
      add(g, box(THREE, mats.steel, bx0, bx1, bottom, top, bz0, bz0 + t, 'sink'));
      add(g, box(THREE, mats.steel, bx0, bx1, bottom, top, bz1 - t, bz1, 'sink'));
      if (inset) {
        add(g, box(THREE, mats.steel, bx0 - rim, bx1 + rim, H - 1, H, bz0 - rim, bz0, 'sink-rim'));
        add(g, box(THREE, mats.steel, bx0 - rim, bx1 + rim, H - 1, H, bz1, bz1 + rim, 'sink-rim'));
        add(g, box(THREE, mats.steel, bx0 - rim, bx0, H - 1, H, bz0, bz1, 'sink-rim'));
        add(g, box(THREE, mats.steel, bx1, bx1 + rim, H - 1, H, bz0, bz1, 'sink-rim'));
      }
      if (full && m.tap !== false) {
        const tz = Math.max(2, (bz0 - rim) / 2), reach = Math.min(18, (bz0 + bz1) / 2 - tz);
        const parts = [
          cyl(THREE, mats.steel, cx, tz, H, H + 30, 1.4, 12, 'tap'),
          box(THREE, mats.steel, cx - 1, cx + 1, H + 28, H + 30, tz, tz + reach, 'tap'),
          box(THREE, mats.steel, cx - 1, cx + 1, H + 24, H + 28, tz + reach - 2, tz + reach, 'tap'),
        ];
        parts.forEach(q => { q.userData.aboveWorktop = true; g.add(q); });
      }
    }
  });

  plinthLed(THREE, g, mats, mods, corner, cornerDepth, W, D, P);
  worktop(THREE, g, mats.worktop, W, D, yW, H, cutouts);
  return g;
}

// ---- kitchen-wall-run ----------------------------------------------------------

const WALL_KINDS = ['cabinet', 'open', 'hood', 'filler', 'corner'];

// Kept equal to houses/schema.json $defs/furnitureParams_kitchen-wall-run.
const WALL_DEFAULTS = deepFreeze({
  width: 180,
  depth: 35,
  height: 72,
  modules: [
    { kind: 'cabinet', width: 60, hinge: 'left' },
    { kind: 'hood', width: 60, style: 'chimney', visor: 'smoked' },
    { kind: 'cabinet', width: 60, hinge: 'right' },
  ],
  corner: 'none',
  cornerDepth: 35,
  frontColor: '#f2f0ea',
  frontFinish: 'gloss',
  handleStyle: 'bar',
  handleColor: '#c9cccf',
});

function buildWallRun(THREE, params, opts) {
  const p = resolve(WALL_DEFAULTS, params);
  const detail = opts && opts.detail === 'low' ? 'low' : 'full';
  const full = detail === 'full';
  const W = p.width, D = p.depth, H = p.height;
  const corner = checkCorner(p.corner, 'kitchen-wall-run');
  const cornerDepth = Math.max(10, Math.min(W, typeof p.cornerDepth === 'number' ? p.cornerDepth : 35));
  let style = handleStyleOf(p);
  if (style === 'rail') style = 'none';   // wall units have no J-rail: handleless
  const mats = materials(THREE, p);
  const mods = layoutModules(p.modules, W, { kinds: WALL_KINDS, type: 'kitchen-wall-run', corner: corner });

  const g = new THREE.Group();
  g.name = 'furniture:kitchen-wall-run';
  // Handles stand 2.5 cm proud of the fronts; without handles the fronts
  // come forward to the run's front plane.
  const zF1 = D - (style === 'bar' || style === 'knob' ? 2.5 : 0), zF0 = zF1 - 2;

  mods.forEach(m => {
    let mh = typeof m.height === 'number' && m.height > 0 ? m.height : H;
    if (mh > H) {
      warn('kitchen-wall-run: a ' + m.kind + ' module is ' + mh + ' cm tall but the run is ' + H + ' cm -- clamped');
      mh = H;
    }
    const y0 = H - mh, w = m.x1 - m.x0;

    if (m.kind === 'hood') {
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

    add(g, box(THREE, mats.front, m.x0, m.x1, y0, H, 0, zF0, 'carcass'));
    if (m.kind === 'filler') frontPanel(THREE, g, mats.front, m.x0, m.x1, y0, H, zF0, zF1, 'filler');
    else if (m.kind === 'corner') blindCorner(THREE, g, mats, style, detail, m, blindSide(m, corner), cornerDepth, y0, H, zF0, zF1, 'v-bot');
    else doors(THREE, g, mats, style, detail, m, y0, H, zF0, zF1, 'v-bot');
  });

  // Bar handles stop 0.3 cm short of the front plane (inside the contract's
  // 0.5 cm); open units' sides and a chimney visor reach it.
  return g;
}

// ---- fridge-freezer --------------------------------------------------------------

// Kept equal to houses/schema.json $defs/furnitureParams_fridge-freezer.
const FRIDGE_DEFAULTS = deepFreeze({
  width: 60,
  depth: 65,
  height: 185,
  frontColor: '#f2f0ea',
  frontFinish: 'gloss',
  handleStyle: 'bar',
  handleColor: '#c9cccf',
  freezer: 'bottom',
  freezerRatio: 0.38,
  hinge: 'right',
});

function buildFridge(THREE, params, opts) {
  const p = resolve(FRIDGE_DEFAULTS, params);
  const full = !(opts && opts.detail === 'low');
  const W = p.width, D = p.depth, H = p.height;
  const style = handleStyleOf(p);
  const mats = materials(THREE, p);
  const g = new THREE.Group();
  g.name = 'furniture:fridge-freezer';

  const zF1 = D - (style === 'bar' || style === 'knob' ? 2.5 : 0), zF0 = zF1 - 2;
  add(g, box(THREE, mats.front, -W / 2, W / 2, 0, H, 0, zF0, 'cabinet'));
  const ratio = Math.max(0.15, Math.min(0.7, typeof p.freezerRatio === 'number' ? p.freezerRatio : 0.38));
  const plinth = 2;
  const split = p.freezer === 'top' ? H - (H - plinth) * ratio : plinth + (H - plinth) * ratio;
  const lower = { x0: -W / 2, x1: W / 2, y0: plinth, y1: split };
  const upper = { x0: -W / 2, x1: W / 2, y0: split, y1: H };
  frontPanel(THREE, g, mats.front, lower.x0, lower.x1, lower.y0, lower.y1, zF0, zF1, 'door');
  frontPanel(THREE, g, mats.front, upper.x0, upper.x1, upper.y0, upper.y1, zF0, zF1, 'door');
  if (full && style !== 'none' && style !== 'rail') {
    const edge = p.hinge === 'left' ? 'right' : 'left';
    const inset = 4;
    const x = edge === 'left' ? -W / 2 + inset : W / 2 - inset;
    [[lower, 'lower'], [upper, 'upper']].forEach(([d, which]) => {
      // Long bars reaching toward the split, where a hand goes for either door.
      const h = d.y1 - d.y0, len = Math.min(style === 'knob' ? 2 : 45, h * 0.6);
      const nearSplit = (which === 'lower') === (p.freezer !== 'top') ? d.y1 - 6 : d.y0 + 6 + len;
      add(g, box(THREE, mats.handle, x - 0.8, x + 0.8, nearSplit - len, nearSplit, zF1, D, 'handle'));
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
 * test checks it: the owning base run along the back wall (corner at its
 * LEFT end, against the left wall), a second base run along the left wall
 * stopping at the owner's front face, a wall run over the owner, and a
 * fridge-freezer at the owner's far end.
 *
 * Returns poses in the frame the spec page uses: centimetres, the inside
 * corner of the two walls at the origin, the back wall along +x (items on it
 * face +z) and the left wall along +z (items on it face +x). `rotY` is a
 * three.js rotation about y, in radians. Placement in a real house is the
 * placer's job; this exists so the page and the test share one L.
 *
 * @param {{a: Object, b: Object, wall: Object, fridge: Object, wallElevation?: number}} items
 *   each is a params object (merged over its type's DEFAULTS)
 */
export function exampleLPoses(items) {
  const a = resolve(BASE_DEFAULTS, items.a), b = resolve(BASE_DEFAULTS, items.b);
  const w = resolve(WALL_DEFAULTS, items.wall), f = resolve(FRIDGE_DEFAULTS, items.fridge);
  const elev = typeof items.wallElevation === 'number' ? items.wallElevation : 137.5;
  return {
    a: { type: 'kitchen-base-run', x: a.width / 2, y: 0, z: 0, rotY: 0 },
    b: { type: 'kitchen-base-run', x: 0, y: 0, z: a.depth + b.width / 2, rotY: Math.PI / 2 },
    wall: { type: 'kitchen-wall-run', x: w.width / 2, y: elev, z: 0, rotY: 0 },
    fridge: { type: 'fridge-freezer', x: a.width + 1 + f.width / 2, y: 0, z: 0, rotY: 0 },
  };
}

/**
 * The generic L the spec page opens on and the kitchen test builds. Invented
 * sizes in standard 60 / 34 widths -- not any real kitchen.
 */
export const EXAMPLE_L = deepFreeze({
  a: {
    width: 245,
    corner: 'left',
    cornerDepth: 65,
    modules: [
      { kind: 'corner', width: 65, plinthLed: true },
      { kind: 'drawers', width: 60, plinthLed: true },
      { kind: 'oven', width: 60, hob: true, splashback: 60 },
      { kind: 'cabinet', width: 60, hinge: 'right' },
    ],
  },
  b: {
    width: 188,
    depth: 65,
    modules: [
      { kind: 'cabinet', width: 34, hinge: 'left' },
      { kind: 'cabinet', width: 34, hinge: 'right' },
      { kind: 'dishwasher', width: 60 },
      { kind: 'sink', width: 60, bowl: 'inset', plinthLed: true },
    ],
  },
  wall: {
    width: 230,
    modules: [
      { kind: 'cabinet', width: 65, hinge: 'left' },
      { kind: 'cabinet', width: 60, hinge: 'right' },
      { kind: 'hood', width: 60, height: 60, style: 'chimney', visor: 'smoked' },
      { kind: 'cabinet', width: 45, height: 52, hinge: 'right' },
    ],
  },
  fridge: {},
  // 88.5 worktop + the standard 49 gap to the wall units' underside.
  wallElevation: 137.5,
});

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
