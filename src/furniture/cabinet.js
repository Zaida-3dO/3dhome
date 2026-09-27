/**
 * cabinet.js - one configurable cabinet carcass covering wardrobes, display
 * cabinets, a TV stand, a chest of drawers, bedside tables, a mobile pedestal
 * and open-shelving units. Ported from specs/CabinetSpec.html (same builder
 * contract as every other furniture module - see src/furniture/box.js for the
 * canonical minimal example this follows).
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0 and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js). Nothing in this
 *     module invents its own MeshStandardMaterial params - that is what lets
 *     the live renderer merge a room's furniture into a handful of vertex-
 *     coloured draws, bucketed by finish. A glass/mirror/emissive mesh is
 *     marked userData.keep = true (via isKeptFinish()) so the merge leaves it
 *     as its own draw instead of folding it into a bucket.
 * See docs/house-profile.md, "Furniture", and the furniture-plan review on
 * item 78f2b614 for why the palette is this narrow.
 *
 * NO TWO FACES MAY Z-FIGHT. Two surfaces at the same depth flicker against
 * each other as the camera moves (the TV console's jagged edges, the mirror
 * panes' jagged vertical edges). So: the carcass sides and back stop at the
 * top and bottom panels instead of running into them; a mirror or glass
 * pane is recessed PANE_RECESS behind its frame and tucked under it; frame
 * stiles stop FRAME_INSET short of the cell's edges. Faces that only touch
 * along an edge, or back to back, are fine. scripts/test-coplanar-faces.mjs
 * builds every preset and fails any pair that face the same way within 1 mm
 * of one plane and overlap.
 *
 * FINISH: `finish` is 'matte' | 'satin' | 'gloss' for the carcass, doors,
 * drawers, plinth and shelves. Unset (null), it follows the older boolean
 * `gloss` (true -> 'gloss', false -> 'matte'), so existing profiles draw as
 * before.
 *
 * FRONTS GRID (row-based front)
 *   params.fronts is an array of rows, top to bottom:
 *     { height, cells: [ {kind, width, ...kind-specific fields} ] }
 *   Each row's cells must span the full cabinet width (see normaliseFronts).
 *   Cell kinds:
 *     'door'    - hinged door, one leaf per cell. handle unless handle:false.
 *     'drawer'  - a drawer front. handle unless handle:false (push-to-open).
 *     'glass'   - fixed glass panel front, keep = true. May carry an
 *                 `interior` (see DISPLAY INTERIOR below).
 *     'mirror'  - fixed mirror panel front, keep = true. The pane runs the
 *                 full height of its cell between two frame stiles.
 *     'sliding' - `doors` (default 2) sliding leaves sharing this ONE cell's
 *                 full width, each split into equal horizontal `panels`
 *                 ('white', matte carcass colour, or 'mirror', keep = true).
 *                 Adjacent leaves alternate between two tracks (a small z
 *                 offset) and overlap at each shared seam - the whole run is
 *                 ONE sliding cell; do not author N adjacent sliding cells to
 *                 get N doors, that builds N INDEPENDENT 2-door runs instead
 *                 (e.g. two 75cm sliding cells side by side renders 4 doors,
 *                 not 2 - see the 2-door sliding wardrobe preset for the
 *                 correct one-cell-doors:2 shape).
 *     'open'    - no front: an open cubby/shelf opening.
 *     'stack'   - this ONE column has its OWN vertical stack of sub-cells,
 *                 independent of the row height: `cells: [{kind, height}]`,
 *                 stacked bottom-up within the parent row's y-span (e.g. a
 *                 TV-console centre section that is open above a drawer,
 *                 while its neighbours are a single full-height door -
 *                 fronts rows are otherwise a uniform-height band across the
 *                 whole width, so a stack cell is the escape hatch for a
 *                 column whose own front doesn't split at the same heights as
 *                 its neighbours). Sub-cell heights must sum to the parent
 *                 row's height (same fill/error rule as a row's own cells,
 *                 checked against the row height rather than the width).
 *                 Sub-cells cannot themselves be 'stack' (no nesting).
 *   A row with no `cells` (or an empty array) renders nothing (e.g. a plinth
 *   reveal). A row may also set `ledGapBelow: true` to place a warm emissive
 *   LED strip in the gap between it and the row below: it wraps the front
 *   face and both side faces of the carcass at that height, but NOT the
 *   back, and is always keep = true. (The older bedside-table shape; the
 *   presets now use `channel` rows.)
 *
 * LIGHT CHANNEL ROWS (the LED bedside tables)
 *   A row `{ height, channel: { color } }` has no front: it is a real
 *   recessed channel CHANNEL_SETBACK deep that wraps the front and both
 *   sides (not the back). The carcass sides are split round it, a filler
 *   block forms its recessed faces, and an emissive strip in `color` sits in
 *   it. The drawer or door directly BELOW a channel gets a low-intensity glow
 *   band along its top edge, part of its own front. Each channel has its own
 *   colour, so two strips on one table can differ (and be bound to two lights
 *   at placement).
 *   `channel.light: '<channel>'` makes the level FOLLOW a room light
 *   channel: its strip and the glow band below it become dynamic parts
 *   (userData.dynamic, lightChannel, lightRole -- see light-parts.js) that
 *   the scene poses from that channel's state -- the strip shows in the
 *   light's colour when on and is hidden when off (just the recess); the
 *   band washes the drawer front in the light's colour, by brightness. The
 *   channel's real light is a room light fixture on the same channel
 *   (docs/house-profile.md, "Bedside table LED strips").
 *   `channel.led: false` builds the recess ONLY: no emissive strip and no
 *   glow band (a level with no LED, or one drawn entirely elsewhere).
 *
 * OVERLAY FRONTS
 *   `overlayFronts: true` makes the fronts cover the carcass edges, as real
 *   overlay doors do: every carcass and base part ends behind the fronts (at
 *   the front plane less the leaf thickness) and each front reaches the
 *   carcass outline on its outer edges, so no top or side lip stands proud of
 *   the doors. Default false: the carcass runs to `depth` and the fronts sit
 *   inside it, as every preset before this one was drawn.
 *
 * COLUMNS GRID (column-based front - open shelving units)
 *   params.columns is an array of columns, left to right:
 *     { width, rows }
 *   `rows` is a shelf-row COUNT (an integer >= 1): the column's clear height
 *   (cabinet height minus top/bottom/plinth panels) is split into that many
 *   EQUAL open shelf bays, separated by horizontal shelf panels of the same
 *   thickness as the carcass. Every bay is open-fronted (no door/drawer front
 *   in this mode - it shows the carcass back). A vertical divider panel is
 *   drawn between adjacent columns. `params.columns` and `params.fronts` are
 *   mutually exclusive; if both are given, `columns` wins.
 *
 * GLASS SIDE PANEL (tall display cabinet)
 *   params.glassSidePanel = { side: 'left'|'right', bands: [...] } replaces
 *   ONE carcass side's plain slab with three vertically-stacked bands (top,
 *   middle, bottom), top to bottom. A band is `{height}` for a plain solid
 *   panel in the carcass finish, or `{height, glassDepth, woodDepth}` for a
 *   middle band split FRONT TO BACK into a glass window (keep = true) and a
 *   wood-tone panel behind it - e.g. a display cabinet whose glass door has a
 *   matching glass side window, with the storage/wood side of the carcass
 *   behind it. `height` is optional per band (an implicit band's height
 *   splits the side's remaining clear height evenly, same rule as a fronts
 *   row/column) so a caller typically only states the structural middle
 *   band's height. The side's clear height is the cabinet height less the
 *   plinth and BOTH the top and bottom panels. The OTHER side is unaffected
 *   (a plain slab). Two units built as mirror images of each other (glass
 *   doors facing across a TV) just use `side: 'left'` on one and
 *   `side: 'right'` on the other, with the fronts grid's cell order swapped.
 *
 * DISPLAY INTERIOR (a glass cell's `interior`, the tall display cabinet)
 *   { lining, shelves, ledStrip, contents }, every field optional:
 *     lining    '#rrggbb': the section's back, inner walls and ceiling are
 *               lined in this colour (a dark wood); its floor stays the
 *               carcass colour. A wall on a side with no carcass panel is a
 *               divider.
 *     shelves   [cm, ...]: clear glass shelves at these heights above the
 *               section's floor.
 *     ledStrip  { color }: a vertical emissive strip the full section height
 *               at the BACK corner on the divider side (else the left).
 *     contents  'none' | 'books-games' | 'console': low-poly proxies on the
 *               floor and shelves, full detail only (<= 150 triangles).
 *
 * PRESETS live in CabinetSpec.html, not here - this module only builds
 * whatever `params` it is given. Preset *names* are generic and descriptive
 * (no owner names): this is a public repo.
 */
import { makeFinish, isKeptFinish } from './finishes.js';
import { WASH_OPACITY } from './light-parts.js';

export const TYPE = 'cabinet';

const CM = 0.01;

// A trivial 2-door mirrored wardrobe. Real dimensions as defaults are fine
// (this is furniture geometry, not house data) - see the builder contract.
// Frozen per the furniture data layer's drift test: every furniture module's
// DEFAULTS must carry width/depth/height and be immutable.
export const DEFAULTS = Object.freeze({
  width: 100,
  height: 236,
  depth: 60,
  // Row height is the space ABOVE the plinth (236 total - 8 plinth = 228) -
  // normaliseFronts stacks fronts starting at plinth height, so the fronts
  // grid's total height plus the plinth height equals the cabinet height.
  fronts: [
    { height: 228, cells: [
      { kind: 'mirror', width: 50 },
      { kind: 'mirror', width: 50 }
    ] }
  ],
  // null: this cabinet uses `fronts`, not the columns grid (open shelving).
  columns: null,
  // Carcass panel thickness in columns mode only; fronts mode uses a fixed
  // thickness (see CARC_T in build()) so this has no effect there.
  panelThickness: 2,
  plinth: { type: 'plinth', height: 8 },
  gloss: false,
  // null: follow `gloss`. 'matte' | 'satin' | 'gloss' override it.
  finish: null,
  // false: fronts sit inside a carcass that runs to `depth` (see OVERLAY
  // FRONTS in the header).
  overlayFronts: false,
  color: '#f2f0ec',
  topColor: '#f2f0ec',
  // Multiplies the colour of the matte/satin/gloss body (see BODY_GAIN): > 1
  // lifts a white that the scene's tone mapping renders grey.
  gain: 1,
  shelfLights: false,
  handles: true,
  // null: both carcass sides are plain (see the tall display cabinet preset
  // for a non-null example).
  glassSidePanel: null
});

// ---- finish + mesh helpers ----------------------------------------------

const BODY_FINISHES = ['matte', 'satin', 'gloss'];

/** The carcass/front finish: `finish` when it is one of BODY_FINISHES, else `gloss` decides. */
export function resolveFinish(p) {
  if (p && BODY_FINISHES.indexOf(p.finish) !== -1) return p.finish;
  return p && p.gloss ? 'gloss' : 'matte';
}

// The body gain of the cabinet being built (params.gain, set by build() for
// the duration of one synchronous build). bodyFinish() multiplies the colour
// of the BODY -- the carcass, the fronts, the top, the plinth and the light
// channels' recess, i.e. every part in the cabinet's own `color`/`topColor`
// and body finish -- so a white can read WHITE under the scene's tone mapping
// (#ffffff alone renders light grey there). Linear, may exceed 1, like
// model.js's gain; merge.js carries such colours in its float vertex colours.
// Every other part (glass, mirror, metal, emissive, door frames, a display
// section's lining, wood and contents) goes through finish() and is left alone.
let BODY_GAIN = 1;

/** A material from the shared palette, with keep-flag bookkeeping left to the caller. */
function finish(THREE, cls, color) {
  return makeFinish(THREE, cls, color);
}

/** A BODY material (see BODY_GAIN): finish() with the cabinet's gain applied. */
function bodyFinish(THREE, cls, color) {
  const m = makeFinish(THREE, cls, color);
  if (BODY_GAIN !== 1) m.color.multiplyScalar(BODY_GAIN);
  return m;
}

function tag(mesh, name) {
  if (isKeptFinish(mesh.material.userData.finish)) mesh.userData.keep = true;
  mesh.castShadow = mesh.material.userData.finish !== 'glass' && mesh.material.userData.finish !== 'mirror';
  mesh.receiveShadow = true;
  if (name) mesh.name = name;
  return mesh;
}

function box(THREE, w, h, d) {
  return new THREE.BoxGeometry(Math.max(w, 0.0005), Math.max(h, 0.0005), Math.max(d, 0.0005));
}

/** A tagged box mesh spanning [x0,x1] x [y0,y1] x [z0,z1] (metres). */
function slab(THREE, group, mat, x0, x1, y0, y1, z0, z1, name) {
  const m = new THREE.Mesh(box(THREE, x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  tag(m, name);
  group.add(m);
  return m;
}

// How far a handle projects beyond its door/drawer front face, in METRES.
// `depth` INCLUDES the handles: every front panel's own outer face sits at
// `depth - HANDLE_PROJECTION`, so a handle projecting HANDLE_PROJECTION
// further out lands exactly at `depth` - never past the declared bbox.
const HANDLE_PROJECTION = 0.025;

/** A door or drawer leaf's thickness for a cabinet `depth` metres deep. */
function frontThickness(depth) { return Math.min(0.018, depth * 0.06); }

// Z-fighting clearances (see the header). 2 mm and 3 mm are far above what
// the depth buffer resolves at room distances, and far below what a person
// sees as a gap.
const PANE_RECESS = 0.003;   // a mirror/glass pane behind its frame's face
const PANE_TUCK = 0.004;     // how far a pane runs under each stile
const FRAME_INSET = 0.002;   // a stile in from its cell's edges
const FRAME_BACKSET = 0.002; // a stile's face behind the front plane
const MIRROR_PANE_T = 0.006;
const GLASS_PANE_T = 0.006;

// Light channels (the LED bedside tables).
const CHANNEL_SETBACK = 0.015; // how far the channel's faces sit behind the fronts / sides
const STRIP_PROUD = 0.002;     // the LED strip's face in front of the channel face
const GLOW_SHARE = 0.35;       // the glow band: this much LED colour over the front's colour
const GLOW_DIM = 1;            // ... at this brightness (the base white carries the rest)
// A level that follows a light (channel.light) washes the drawer front below
// it: one unlit quad over the top WASH_SHARE of that front (at most
// WASH_MAX_H), WASH_OFF in front of it, its alpha falling smoothly through
// WASH_ALPHA's rows (top first) -- a soft glow that is strongest at the
// channel, with no hard band edge and nothing coplanar with the front.
const WASH_SHARE = 0.45;
const WASH_MAX_H = 0.08;
const WASH_OFF = 0.0006;
const WASH_ALPHA = Object.freeze([1, 0.72, 0.42, 0.16, 0]);
const STRIP_BACK_T = 0.006;    // the carcass back's thickness (full detail): side strips start 2 cm in front of it

/** Is the fronts row a light channel? */
function isChannel(row) { return !!(row && row.channel); }

/**
 * Mark a mesh as a part that follows room light channel `channel` (see
 * light-parts.js): dynamic (never merged, posed live by the scene), with
 * its OWN material so posing it never recolours another part.
 */
function tagLightPart(mesh, channel, role) {
  mesh.material = mesh.material.clone();
  mesh.userData.dynamic = true;
  mesh.userData.lightChannel = String(channel);
  mesh.userData.lightRole = role;
}

/** Does a light channel row draw its own (static) LED strip? `led: false` = recess only. */
function channelLed(row) { return isChannel(row) && row.channel.led !== false; }

/**
 * The plane every hinged/fixed front's face lies in: `depth` for a
 * handleless cabinet, else HANDLE_PROJECTION back from it so a handle ends
 * exactly at `depth` (see buildFrontCell).
 */
function frontPlane(p, depth) {
  return p.handles === false ? depth : depth - HANDLE_PROJECTION;
}

// ---- fronts grid normalisation -----------------------------------------

/**
 * Normalises a fronts grid against a cabinet width (cm):
 *   - a row whose cells sum to the full width is left alone
 *   - a row with cells that DON'T fill the width, but every cell already has
 *     an explicit width, is an authoring error and throws
 *   - a row with cells missing `width` gets the remaining width split evenly
 *     across those cells (so `{cells:[{kind:'door'},{kind:'door'}]}` just
 *     works, matching the module's own DEFAULTS-less presets)
 * Rows are also given their absolute Y span (yBottom, yTop) in cm. `fronts`
 * is authored TOP TO BOTTOM (index 0 = the row you'd point at first when
 * describing a cabinet front, e.g. "top: glass, bottom: solid door"), but
 * this function walks it in reverse so row 0 lands at the TOP of the carcass
 * and the last row sits just above the plinth - array order matches how a
 * person describes the front; the Y math is built bottom-up to match three.js.
 */
export function normaliseFronts(fronts, width, plinthHeight) {
  const rows = (fronts || []).map(row => {
    const cells = row.cells || [];
    const explicit = cells.filter(c => typeof c.width === 'number');
    const explicitSum = explicit.reduce((s, c) => s + c.width, 0);
    const remaining = width - explicitSum;
    const implicitCount = cells.length - explicit.length;
    if (cells.length === 0) {
      return Object.assign({}, row, { cells: [] });
    }
    if (implicitCount === 0) {
      if (Math.abs(explicitSum - width) > 0.5) {
        throw new Error(
          `cabinet fronts row does not fill the width: cells sum to ${explicitSum}cm, ` +
          `cabinet is ${width}cm wide`
        );
      }
      return row;
    }
    if (remaining <= 0) {
      throw new Error(
        `cabinet fronts row: explicit cell widths (${explicitSum}cm) already exceed ` +
        `the cabinet width (${width}cm), leaving nothing for ${implicitCount} cell(s)`
      );
    }
    const share = remaining / implicitCount;
    const normCells = cells.map(c => (typeof c.width === 'number' ? c : Object.assign({}, c, { width: share })));
    return Object.assign({}, row, { cells: normCells });
  });

  // Stack bottom-up: last described row sits at the floor (above the
  // plinth), first described row is the top of the carcass.
  let y = plinthHeight;
  const stacked = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const h = row.height;
    stacked.unshift(Object.assign({}, row, { yBottom: y, yTop: y + h }));
    y += h;
  }
  return stacked;
}

/**
 * Normalises a columns grid against a cabinet width (cm), the same way
 * normaliseFronts does for rows: explicit widths must sum to the full width,
 * columns missing `width` split the remainder evenly. Returns columns left
 * to right with their absolute X span (xLeft, xRight) added, in cm from the
 * cabinet's left edge (x = 0..width, NOT centred - build() re-centres).
 */
export function normaliseColumns(columns, width) {
  const cols = columns || [];
  const explicit = cols.filter(c => typeof c.width === 'number');
  const explicitSum = explicit.reduce((s, c) => s + c.width, 0);
  const remaining = width - explicitSum;
  const implicitCount = cols.length - explicit.length;
  let normed;
  if (implicitCount === 0) {
    if (Math.abs(explicitSum - width) > 0.5) {
      throw new Error(
        `cabinet columns do not fill the width: columns sum to ${explicitSum}cm, ` +
        `cabinet is ${width}cm wide`
      );
    }
    normed = cols;
  } else {
    if (remaining <= 0) {
      throw new Error(
        `cabinet columns: explicit column widths (${explicitSum}cm) already exceed ` +
        `the cabinet width (${width}cm), leaving nothing for ${implicitCount} column(s)`
      );
    }
    const share = remaining / implicitCount;
    normed = cols.map(c => (typeof c.width === 'number' ? c : Object.assign({}, c, { width: share })));
  }
  let x = 0;
  return normed.map(c => {
    const withSpan = Object.assign({}, c, { xLeft: x, xRight: x + c.width });
    x += c.width;
    return withSpan;
  });
}

// ---- builders for each front-cell kind ---------------------------------

/**
 * A door or drawer leaf's rectangle inside its cell. Inner edges keep a
 * reveal (1% of the cell width each side, `revealY` of its height top and
 * bottom); with overlay fronts, an edge on the carcass OUTLINE (edges.l/r/t/b)
 * runs right to the cell's edge, so the front covers the carcass there.
 */
function leafRect(x0, x1, yBot, yTop, revealY, edges) {
  const w = x1 - x0, h = yTop - yBot;
  const e = edges || {};
  return {
    lx0: e.l ? x0 : x0 + w * 0.01,
    lx1: e.r ? x1 : x1 - w * 0.01,
    ly0: e.b ? yBot : yBot + h * revealY,
    ly1: e.t ? yTop : yTop - h * revealY
  };
}

/** A leaf, optionally with a glow band along its top edge (below a light channel). */
function addLeaf(THREE, group, r, faceZ, T, mat, name, glowColor, baseColor, glowLight) {
  if (glowColor && glowLight) {
    // A level that FOLLOWS a light washes the front below it: the leaf stays
    // whole, and ONE unlit quad lies WASH_OFF in front of its top, fading
    // smoothly (vertex alpha over WASH_ALPHA's rows) from the channel down
    // over min(WASH_MAX_H, WASH_SHARE of the leaf), at the fixed WASH_OPACITY
    // (which the wall-fade loop owns). light-parts.js colours it from the
    // channel's state and scales its gradient by brightness (the vertex alpha,
    // so it fades to nothing at 0), and hides it when the level is off.
    const base = /^#[0-9a-fA-F]{6}$/.test(baseColor) ? baseColor : '#ffffff';
    const washH = Math.min(WASH_MAX_H, (r.ly1 - r.ly0) * WASH_SHARE);
    const w = r.lx1 - r.lx0;
    const geo = new THREE.PlaneGeometry(w, washH, 1, WASH_ALPHA.length - 1);
    const n = geo.attributes.position.count;           // 2 per row, top row first
    const rgba = new Float32Array(n * 4);
    for (let v = 0; v < n; v++) {
      rgba.set([1, 1, 1, WASH_ALPHA[Math.floor(v / 2)]], v * 4);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
    const washMat = new THREE.MeshBasicMaterial({
      color: glowColor, vertexColors: true, transparent: true, opacity: WASH_OPACITY,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    washMat.userData.finish = 'emissive';
    const wash = new THREE.Mesh(geo, washMat);
    wash.position.set((r.lx0 + r.lx1) / 2, r.ly1 - washH / 2, faceZ + WASH_OFF);
    wash.name = 'channelGlow';
    wash.userData.keep = true;
    wash.castShadow = false;
    wash.receiveShadow = false;
    wash.renderOrder = 1;
    group.add(wash);
    tagLightPart(wash, glowLight, 'glow');
    wash.userData.baseColor = base;
    wash.userData.wash = true;
    // The gradient as built, per vertex: light-parts.js scales it by brightness.
    wash.userData.washAlpha = Array.from({ length: n }, (_, v) => WASH_ALPHA[Math.floor(v / 2)]);
    return slab(THREE, group, mat, r.lx0, r.lx1, r.ly0, r.ly1, faceZ - T, faceZ, name);
  }
  if (glowColor) {
    // The glow band is part of the leaf -- the top slice of the same front,
    // in the same plane -- not a plate stuck on in front of it.
    const bandH = Math.min(0.03, (r.ly1 - r.ly0) * 0.2);
    const band = slab(THREE, group, finish(THREE, 'emissive', glowTint(glowColor, baseColor)),
      r.lx0, r.lx1, r.ly1 - bandH, r.ly1, faceZ - T, faceZ, 'channelGlow');
    band.castShadow = false;
    return slab(THREE, group, mat, r.lx0, r.lx1, r.ly0, r.ly1 - bandH, faceZ - T, faceZ, name);
  }
  return slab(THREE, group, mat, r.lx0, r.lx1, r.ly0, r.ly1, faceZ - T, faceZ, name);
}

/** '#rrggbb' of the glow band: GLOW_SHARE of the LED colour over the front's, dimmed. */
function glowTint(led, base) {
  const toRgb = h => {
    const n = parseInt(String(h).replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = toRgb(led), b = toRgb(/^#[0-9a-fA-F]{6}$/.test(base) ? base : '#ffffff');
  const c = a.map((v, i) => Math.round((v * GLOW_SHARE + b[i] * (1 - GLOW_SHARE)) * GLOW_DIM));
  return '#' + c.map(v => ('0' + v.toString(16)).slice(-2)).join('');
}

function buildDoorCell(THREE, group, cell, x0, x1, yBot, yTop, depth, fin, color, handles, faceZ, ctx) {
  const T = frontThickness(depth);
  const mat = bodyFinish(THREE, fin, color);
  const r = leafRect(x0, x1, yBot, yTop, 0.01, ctx && ctx.edges);
  addLeaf(THREE, group, r, faceZ, T, mat, 'cabinetDoor', ctx && ctx.glow, color, ctx && ctx.glowLight);
  if (handles !== false && cell.handle !== false) {
    addHandle(THREE, group, x1 - Math.min(0.04, (x1 - x0) * 0.08), (yBot + yTop) / 2, faceZ);
  }
}

function buildDrawerCell(THREE, group, cell, x0, x1, yBot, yTop, depth, fin, color, handles, faceZ, ctx) {
  // A drawer in the top row spans the top panel's height too; its handle
  // must stay below that panel (it used to reach up into it, its face in
  // the panel's front plane -- the mobile pedestal's top drawer).
  const h = yTop - yBot;
  const cx = (x0 + x1) / 2;
  const T = frontThickness(depth);
  const mat = bodyFinish(THREE, fin, color);
  const r = leafRect(x0, x1, yBot, yTop, 0.03, ctx && ctx.edges);
  addLeaf(THREE, group, r, faceZ, T, mat, 'drawerFront', ctx && ctx.glow, color, ctx && ctx.glowLight);
  const showHandle = handles !== false && cell.handle !== false;
  if (showHandle) {
    const maxY = ctx && ctx.handleMaxY != null ? ctx.handleMaxY : Infinity;
    addHandle(THREE, group, cx, Math.min(yTop - h * 0.12, maxY - 0.007 - 0.004), faceZ, true);
  }
}

/**
 * A fixed glass or mirror front: two frame stiles and a pane between them.
 * The pane runs the cell's FULL height (the owner's review: no gap above or
 * below the mirror), tucks PANE_TUCK under each stile and sits PANE_RECESS
 * behind the stiles' faces, so it never shares a plane with them. The stiles
 * stop FRAME_INSET short of the cell's edges and sit FRAME_BACKSET behind the
 * front plane, so they never share one with the carcass either (a stile used
 * to lie in the carcass side's outer face and the top panel's top face).
 */
function buildGlassOrMirrorCell(THREE, group, kind, x0, x1, yBot, yTop, depth, faceZ, ctx) {
  const T = frontThickness(depth);
  const FT = Math.min(0.02, (x1 - x0) / 5);
  const sFace = faceZ - FRAME_BACKSET;
  const sy0 = yBot + FRAME_INSET, sy1 = yTop - FRAME_INSET;
  const frameMat = finish(THREE, 'matte', '#ffffff');
  [[x0 + FRAME_INSET, x0 + FRAME_INSET + FT], [x1 - FRAME_INSET - FT, x1 - FRAME_INSET]].forEach(([a, b]) => {
    slab(THREE, group, frameMat, a, b, sy0, sy1, sFace - T, sFace, 'cabinetDoorFrame');
  });
  // Thin enough that its back stays 2 mm clear of the stiles' backs too (a
  // shallow cabinet has thin leaves).
  const paneT = Math.min(kind === 'glass' ? GLASS_PANE_T : MIRROR_PANE_T, T - PANE_RECESS - 0.002);
  const pFace = sFace - PANE_RECESS;
  // 2 mm shorter than the stiles at each end, so the pane's own top and
  // bottom faces never lie in a stile's.
  const pane = slab(THREE, group, finish(THREE, kind, null),
    x0 + FRAME_INSET + FT - PANE_TUCK, x1 - FRAME_INSET - FT + PANE_TUCK,
    sy0 + FRAME_INSET, sy1 - FRAME_INSET, pFace - paneT, pFace,
    kind === 'glass' ? 'cabinetGlassDoor' : 'cabinetMirrorDoor');
  pane.userData.isMirror = kind === 'mirror'; // spec-three.jsx env-cube convention
}

/**
 * `doors` (default 2) sliding leaves sharing this ONE cell's full width.
 * Adjacent leaves alternate between two tracks (a small z offset, one
 * slightly in front of the other) and OVERLAP at each shared seam by
 * `overlap` (cm) - matching how a real two-track sliding wardrobe's leaves
 * clear each other - and together span the full cell width. No handles - a
 * sliding door is pulled by its edge, per every reference photo.
 *
 * IMPORTANT: this is what makes "N doors" mean N doors total, not N doors
 * PER adjacent sliding cell - two adjacent 'sliding' cells side by side
 * would build 2 independent runs (4 doors), which is why a multi-door
 * sliding front must be authored as ONE cell with `doors: N`.
 *
 * A mirror panel sits PANE_RECESS behind its door's frame and rails (it
 * used to lie in their plane, and the carcass side's, and flicker at every
 * edge it ran under them).
 */
function buildSlidingCell(THREE, group, cell, x0, x1, yBot, yTop, depth) {
  const w = x1 - x0, h = yTop - yBot;
  const panels = (cell.panels && cell.panels.length) ? cell.panels : ['white', 'mirror', 'mirror', 'white'];
  const n = panels.length;
  const panelH = h / n;
  const railT = 0.012;
  const T = Math.min(0.02, depth * 0.05);
  // Two tracks: even-indexed doors ride the front track (flush at `depth`),
  // odd-indexed doors ride the back track (`trackGap` behind it), so any two
  // ADJACENT doors sit on different tracks and visibly clear each other
  // front-to-back at their shared, overlapping seam.
  const trackGap = Math.min(0.03, depth * 0.08);
  const frontFaceZ = depth;
  const backFaceZ = depth - trackGap;
  const doorCount = Math.max(1, Math.round(cell.doors || 2));
  const overlap = Math.min(0.08, (w / doorCount) * 0.12); // doors overlap this much at each seam
  const frameMat = finish(THREE, 'matte', '#ffffff');

  // doorCount doors spanning the FULL cell width: door i's nominal span is
  // [x0 + i*w/doorCount, x0 + (i+1)*w/doorCount], widened by half the
  // overlap on each shared edge (none on the cabinet's own outer edges) so
  // consecutive doors overlap rather than merely touch.
  const doors = [];
  for (let i = 0; i < doorCount; i++) {
    const nomX0 = x0 + (i / doorCount) * w;
    const nomX1 = x0 + ((i + 1) / doorCount) * w;
    const dx0 = i === 0 ? nomX0 : nomX0 - overlap / 2;
    const dx1 = i === doorCount - 1 ? nomX1 : nomX1 + overlap / 2;
    doors.push({ dx0, dx1, faceZ: i % 2 === 0 ? frontFaceZ : backFaceZ });
  }

  doors.forEach(door => {
    const dw = door.dx1 - door.dx0;
    const dcx = (door.dx0 + door.dx1) / 2;
    for (let i = 0; i < n; i++) {
      // panels[] is authored top-to-bottom; row i=0 is the top panel.
      const pTop = yTop - i * panelH;
      const pBot = pTop - panelH;
      const pcy = (pTop + pBot) / 2;
      const kind = panels[i] === 'mirror' ? 'mirror' : 'matte';
      const inset = kind === 'mirror' ? 0.01 : 0.006;
      const paneT = kind === 'mirror' ? 0.008 : T;
      const paneFace = kind === 'mirror' ? door.faceZ - PANE_RECESS : door.faceZ;
      const mat = finish(THREE, kind, '#ffffff');
      const pane = new THREE.Mesh(box(THREE, dw - inset * 2, Math.max(0.01, panelH - railT), paneT), mat);
      pane.position.set(dcx, pcy, paneFace - paneT / 2);
      tag(pane, kind === 'mirror' ? 'slidingMirrorPanel' : 'slidingWhitePanel');
      pane.userData.isMirror = kind === 'mirror';
      group.add(pane);

      if (i > 0) {
        const rail = new THREE.Mesh(box(THREE, dw, railT, T), frameMat);
        rail.position.set(dcx, pTop, door.faceZ - T / 2);
        tag(rail, 'slidingRail');
        group.add(rail);
      }
    }
    // Thin outer frame edges (left/right stiles), per the reference photo.
    const FT = 0.015;
    [door.dx0 + FT / 2, door.dx1 - FT / 2].forEach(fx => {
      const stile = new THREE.Mesh(box(THREE, FT, h, T), frameMat);
      stile.position.set(fx, (yBot + yTop) / 2, door.faceZ - T / 2);
      tag(stile, 'slidingFrame');
      group.add(stile);
    });
  });
}

/**
 * Dispatches one non-stack front cell (door/drawer/glass/mirror/sliding/
 * open) to its builder. Shared by the row loop and buildStackCell's
 * sub-cells, so a stack's sub-cells support every ordinary cell kind.
 *
 * Every hinged/fixed front (door, drawer, glass, mirror) shares ONE common
 * face plane, `faceZ`, computed here from the WHOLE cabinet's `handles`
 * setting - not per cell-kind - so a glass section never pokes past (or
 * sits behind) the solid door bands of the same front. If the cabinet has
 * handles anywhere (`p.handles !== false`), that plane is `depth -
 * HANDLE_PROJECTION` so a handle can still project the rest of the way to
 * `depth`; a fully handleless cabinet (`p.handles === false`) puts every
 * front flush at `depth` instead, since nothing needs the clearance.
 * (`sliding` is exempt: its two-track system is an intentional multi-plane
 * design of its own, not part of this shared plane.)
 *
 * `ctx` carries { edges, glow, fin, interior } for this cell: which of its
 * edges are on the carcass outline (overlay fronts), the glow colour when a
 * light channel sits directly above it, and the interior build context.
 */
function buildFrontCell(THREE, group, cell, x0, x1, yBot, yTop, depth, fin, color, p, low, ctx) {
  const faceZ = frontPlane(p, depth);
  switch (cell.kind) {
    case 'door':
      buildDoorCell(THREE, group, cell, x0, x1, yBot, yTop, depth, fin, color, p.handles, faceZ, ctx);
      break;
    case 'drawer':
      buildDrawerCell(THREE, group, cell, x0, x1, yBot, yTop, depth, fin, color, p.handles, faceZ, ctx);
      break;
    case 'glass':
      buildGlassOrMirrorCell(THREE, group, 'glass', x0, x1, yBot, yTop, depth, faceZ, ctx);
      if (p.shelfLights && !low) addShelfLight(THREE, group, x0, x1, yTop, depth);
      if (cell.interior && ctx && ctx.interior) buildInterior(THREE, group, cell.interior, x0, x1, yBot, yTop, ctx.interior, low);
      break;
    case 'mirror':
      buildGlassOrMirrorCell(THREE, group, 'mirror', x0, x1, yBot, yTop, depth, faceZ, ctx);
      break;
    case 'sliding':
      buildSlidingCell(THREE, group, cell, x0, x1, yBot, yTop, depth);
      break;
    case 'open':
    default:
      break; // no front: open cubby
  }
}

/**
 * A 'stack' cell: this one column has its OWN vertical stack of sub-cells,
 * independent of the parent row's uniform height (e.g. an open bay above a
 * drawer, while the neighbouring columns are each a single full-height
 * door). Sub-cell heights (cm) must sum to the parent row's height, using
 * the same fill/error rule as normaliseFronts - checked here directly since
 * a stack's sub-cells share the parent row's WIDTH already (fixed by the
 * caller) and only need their own y-split.
 */
function buildStackCell(THREE, group, cell, x0, x1, rowYBottomCm, rowYTopCm, depth, fin, color, p, low, ctx) {
  const subCells = cell.cells || [];
  const rowHeightCm = rowYTopCm - rowYBottomCm;
  const explicitSum = subCells.reduce((s, c) => s + (c.height || 0), 0);
  if (Math.abs(explicitSum - rowHeightCm) > 0.5) {
    throw new Error(
      `cabinet stack cell sub-cells sum to ${explicitSum}cm but the row is ${rowHeightCm}cm tall`
    );
  }
  // Sub-cells are authored TOP TO BOTTOM (same convention as fronts rows).
  let yTopCm = rowYTopCm;
  subCells.forEach((sub, i) => {
    if (sub.kind === 'stack') {
      throw new Error('cabinet stack cell: sub-cells cannot themselves be "stack" (no nesting)');
    }
    const yBotCm = yTopCm - sub.height;
    const e = (ctx && ctx.edges) || {};
    const subCtx = Object.assign({}, ctx, {
      edges: { l: e.l, r: e.r, t: e.t && i === 0, b: e.b && i === subCells.length - 1 },
      glow: i === 0 ? ctx && ctx.glow : null,
      glowLight: i === 0 ? ctx && ctx.glowLight : null
    });
    buildFrontCell(THREE, group, sub, x0, x1, yBotCm * CM, yTopCm * CM, depth, fin, color, p, low, subCtx);
    yTopCm = yBotCm;
  });
}

/**
 * A handle bar projecting from `faceZ` (its door/drawer's own outer face) out
 * to exactly `faceZ + HANDLE_PROJECTION` - which the caller has already
 * arranged to equal the cabinet's declared `depth`, so the handle never pokes
 * past the builder-contract bbox.
 */
function addHandle(THREE, group, x, y, faceZ, isDrawer) {
  const mat = finish(THREE, 'metal', '#d8dadc');
  const tipZ = faceZ + HANDLE_PROJECTION;
  if (isDrawer) {
    const bar = new THREE.Mesh(box(THREE, 0.10, 0.014, 0.014), mat);
    bar.position.set(x, y, tipZ - 0.007);
    tag(bar, 'drawerHandle');
    group.add(bar);
  } else {
    const bar = new THREE.Mesh(box(THREE, 0.014, 0.14, 0.014), mat);
    bar.position.set(x, y, tipZ - 0.007);
    tag(bar, 'doorHandle');
    group.add(bar);
  }
}

// ---- plinth / legs / wheels ---------------------------------------------

/**
 * The base, under a carcass whose front is at `carcassFront`. A plinth with
 * an explicit `inset` (cm) -- or any plinth under overlay fronts -- is set
 * back `inset` from the FRONT PLANE `faceZ` and from each side (a shadow
 * recess); otherwise it is drawn exactly as before (3 cm in from the sides,
 * centred in the depth).
 */
function buildBase(THREE, group, base, width, depth, fin, color, carcassFront, faceZ, overlay) {
  const h = base.height * CM;
  if (h <= 0) return;
  if (base.type === 'legs') {
    const legMat = finish(THREE, 'metal', '#3a3a3a');
    const inset = 0.04;
    const r = 0.012;
    const xs = [-width / 2 + inset, width / 2 - inset];
    const zs = [inset, carcassFront - inset];
    xs.forEach(x => zs.forEach(z => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 12), legMat);
      leg.position.set(x, h / 2, z);
      tag(leg, 'leg');
      group.add(leg);
    }));
    return;
  }
  if (base.type === 'wheels') {
    const wheelMat = finish(THREE, 'metal', '#2a2a2a');
    const r = Math.min(h / 2, 0.03);
    const inset = 0.05;
    const xs = [-width / 2 + inset, width / 2 - inset];
    const zs = [inset, carcassFront - inset];
    xs.forEach(x => zs.forEach(z => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.02, 16), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, r, z);
      tag(wheel, 'wheel');
      group.add(wheel);
    }));
    return;
  }
  // plinth (default): a simple recessed toe-kick box.
  const plinthMat = bodyFinish(THREE, fin, color);
  if (overlay || typeof base.inset === 'number') {
    const inset = (typeof base.inset === 'number' ? base.inset : 3) * CM;
    slab(THREE, group, plinthMat, -width / 2 + inset, width / 2 - inset, 0, h, 0, faceZ - inset, 'plinth');
    return;
  }
  const inset = 0.03;
  const plinth = new THREE.Mesh(box(THREE, width - inset * 2, h, depth - inset), plinthMat);
  plinth.position.set(0, h / 2, (depth - inset) / 2 + inset / 2);
  tag(plinth, 'plinth');
  group.add(plinth);
}

// ---- glass side panel (tall display cabinet) ------------------------------

/**
 * One carcass side panel built as three vertically-stacked bands instead of
 * one plain slab: `bands` is [{height}, {height, glassDepth, woodDepth},
 * {height}] top to bottom (cm). The middle band is split FRONT TO BACK: a
 * glass pane `glassDepth` deep at the front (keep = true) and a wood-tone
 * panel `woodDepth` deep behind it, glassDepth + woodDepth <= the carcass
 * depth `D`. Top and bottom bands are plain solid panels in the carcass
 * finish.
 *
 * A band's `height` is optional - like a fronts row/column, any band missing
 * one gets an even share of whatever height is left after the explicit
 * bands, so the caller can give just the (structural) middle band's height
 * and let the plain top/bottom bands fill the rest of the side's own clear
 * height (sideH), which already has the carcass top/bottom panels and the
 * plinth subtracted out - it is NOT the same number as the cabinet's overall
 * `height` param.
 */
function buildGlassSidePanel(THREE, group, gsp, sx, W, D, plinthH, CARC_T, sideH, fin, color) {
  const explicit = gsp.bands.filter(b => typeof b.height === 'number');
  const explicitSum = explicit.reduce((s, b) => s + b.height * CM, 0);
  const implicitCount = gsp.bands.length - explicit.length;
  const remaining = sideH - explicitSum;
  if (implicitCount === 0 && Math.abs(explicitSum - sideH) > 0.005) {
    throw new Error(
      `cabinet glassSidePanel bands sum to ${(explicitSum / CM).toFixed(1)}cm but the side's clear ` +
      `height is ${(sideH / CM).toFixed(1)}cm`
    );
  }
  if (implicitCount > 0 && remaining <= 0) {
    throw new Error(
      `cabinet glassSidePanel: explicit band heights already exceed the side's clear height ` +
      `(${(sideH / CM).toFixed(1)}cm), leaving nothing for ${implicitCount} band(s)`
    );
  }
  const share = implicitCount > 0 ? remaining / implicitCount : 0;
  const bands = gsp.bands.map(b => (typeof b.height === 'number' ? b : Object.assign({}, b, { height: share / CM })));

  const carcassMat = bodyFinish(THREE, fin, color);
  const x = sx * (W / 2 - CARC_T / 2);
  let yTop = plinthH + CARC_T + sideH;
  const spans = [];
  bands.forEach(band => {
    const h = band.height * CM;
    const yBot = yTop - h;
    const cy = (yBot + yTop) / 2;
    if (band.glassDepth) {
      // Front glass window (keep = true) + a wood-tone panel behind it.
      const glassD = Math.min(band.glassDepth * CM, D);
      const woodD = Math.max(0, Math.min(band.woodDepth * CM, D - glassD));
      const glass = new THREE.Mesh(box(THREE, CARC_T, h, glassD), finish(THREE, 'glass', null));
      glass.position.set(x, cy, D - glassD / 2);
      tag(glass, 'displaySideGlass');
      group.add(glass);

      if (woodD > 0) {
        const wood = new THREE.Mesh(box(THREE, CARC_T, h, woodD), finish(THREE, 'matte', '#6b4a35'));
        wood.position.set(x, cy, D - glassD - woodD / 2);
        tag(wood, 'displaySideWood');
        group.add(wood);
      }
      spans.push({ yBot, yTop, glassFrom: D - glassD });
    } else {
      const panel = new THREE.Mesh(box(THREE, CARC_T, h, D), carcassMat);
      panel.position.set(x, cy, D / 2);
      tag(panel, 'carcassSide');
      group.add(panel);
    }
    yTop = yBot;
  });
  return spans;
}

// ---- columns grid (open shelving) ----------------------------------------

/**
 * One column of `rowCount` equal open shelf bays between yBottom and yTop
 * (cm), separated by horizontal shelf panels PANEL_T thick, plus a vertical
 * divider on its right edge (shared with the next column) unless `isLast`.
 * Every bay is open - no front - so the carcass back is what's visible.
 */
function buildColumn(THREE, group, col, yBottom, yTop, depth, panelT, fin, color, isLast) {
  const x0 = col.x0, x1 = col.x1;
  const mat = bodyFinish(THREE, fin, color);
  const rowCount = Math.max(1, Math.round(col.rows || 1));
  const clearH = (yTop - yBottom - panelT * (rowCount - 1)) / rowCount;

  // Horizontal shelves BETWEEN bays (rowCount - 1 of them; the carcass top
  // and bottom already close off the outer ends).
  for (let i = 1; i < rowCount; i++) {
    const shelfCy = yBottom + i * (clearH + panelT) - panelT / 2;
    const shelf = new THREE.Mesh(box(THREE, x1 - x0, panelT, depth), mat);
    shelf.position.set((x0 + x1) / 2, shelfCy, depth / 2);
    tag(shelf, 'shelf');
    group.add(shelf);
  }

  if (!isLast) {
    const divider = new THREE.Mesh(box(THREE, panelT, yTop - yBottom, depth), mat);
    divider.position.set(x1 + panelT / 2, (yBottom + yTop) / 2, depth / 2);
    tag(divider, 'columnDivider');
    group.add(divider);
  }
}

// ---- light channel (LED bedside tables) -----------------------------------

/**
 * A recessed light channel between y0 and y1: a filler block whose front and
 * side faces sit CHANNEL_SETBACK behind the front plane and the carcass
 * sides (the carcass sides are split round it by the caller), and an
 * emissive strip that wraps its front and both sides, STRIP_PROUD in front
 * of those faces. Never the back.
 */
function buildChannel(THREE, group, row, W, faceZ, backZ, y0, y1, fin, color, low) {
  const ledColor = (row.channel && row.channel.color) || '#dbe8ff';
  const xs = W / 2 - CHANNEL_SETBACK;
  const fillFront = faceZ - CHANNEL_SETBACK;
  slab(THREE, group, bodyFinish(THREE, fin, color), -xs, xs, y0, y1, backZ, fillFront, 'channelRecess');
  if (low || !channelLed(row)) return;
  const sh = Math.min(0.006, (y1 - y0) * 0.4);
  const cy = (y0 + y1) / 2;
  const ledMat = finish(THREE, 'emissive', ledColor);
  const front = slab(THREE, group, ledMat, -xs - STRIP_PROUD, xs + STRIP_PROUD, cy - sh / 2, cy + sh / 2,
    fillFront - 0.003, fillFront + STRIP_PROUD, 'channelStripFront');
  front.castShadow = false;
  const follow = row.channel && row.channel.light;
  if (follow) tagLightPart(front, follow, 'strip');
  [-1, 1].forEach(sx => {
    // Each side strip ends INSIDE the front strip, so no end face lies in
    // the front strip's plane; it runs back to 2 cm off the wall.
    const a = sx < 0 ? -xs - STRIP_PROUD : xs - 0.001;
    const b = sx < 0 ? -xs + 0.001 : xs + STRIP_PROUD;
    const side = slab(THREE, group, ledMat, a, b, cy - sh / 2, cy + sh / 2, backZ + 0.02, fillFront - 0.0015, 'channelStripSide');
    side.castShadow = false;
    if (follow) tagLightPart(side, follow, 'strip');
  });
}

/**
 * Where each light channel's LED strip is, in the cabinet's own frame and in
 * CENTIMETRES: x centred on the width, y up from the cabinet's bottom, z from
 * the back (0) to the front (+z). One entry per channel row, top row first:
 *
 *   { row, color, centre: [x, y, z], size: [x, y, z], lightAt: [x, y, z] }
 *
 * The box is the one the table's own strip fills (the front run and both
 * side runs, 2 mm proud of the recess, never the back). `lightAt` is where
 * that level's real light goes: a room light `strip` fixture on the level's
 * channel, aimed out of the table, at the channel's height in the plane of
 * the drawer fronts' back faces (docs/house-profile.md, "Bedside table LED
 * strips").
 */
export function channelStripBoxes(params) {
  const p = Object.assign({}, DEFAULTS, params);
  if (p.columns) return [];
  const plinth = p.plinth || { type: 'plinth', height: 0 };
  const rows = normaliseFronts(p.fronts, p.width, plinth.height || 0);
  const W = p.width * CM, D = p.depth * CM;
  const faceZ = frontPlane(p, D);
  const xs = W / 2 - CHANNEL_SETBACK;
  const fillFront = faceZ - CHANNEL_SETBACK;
  const z0 = STRIP_BACK_T + 0.02, z1 = fillFront + STRIP_PROUD;
  const r = v => Math.round(v * 1000) / 10; // m -> cm, to 1 mm
  return rows.filter(isChannel).map(row => {
    const y0 = row.yBottom * CM, y1 = row.yTop * CM;
    const sh = Math.min(0.006, (y1 - y0) * 0.4);
    return {
      row: rows.indexOf(row),
      color: row.channel.color || '#dbe8ff',
      centre: [0, r((y0 + y1) / 2), r((z0 + z1) / 2)],
      size: [r(2 * (xs + STRIP_PROUD)), r(sh), r(z1 - z0)],
      // Where the level's real light belongs: at the channel's height, in
      // the plane of the drawer fronts' BACK faces. Aimed out of the table
      // (a spot with a 90 degree half-angle, see home3d-scene.js addStrip
      // `aim`), it lights the channel it sits in, the floor in front and
      // the bed beside the table -- and nothing of the OTHER level's channel,
      // whose faces all lie behind or on that plane, so an off level stays
      // dark with no shadow map. The drawer front below is washed by the
      // level's glow band, which follows the same channel (light-parts.js).
      lightAt: [0, r((y0 + y1) / 2), r(faceZ - frontThickness(D))],
    };
  });
}

// ---- display interior (a glass cell's `interior`) -------------------------

const LINING_T = 0.004;
const INTERIOR_FLOOR_T = 0.018;
const GLASS_SHELF_T = 0.008;

/**
 * The inside of a glass-fronted section spanning [x0, x1] x [yBot, yTop]:
 * lining, a floor, glass shelves, a vertical LED strip and contents (see
 * DISPLAY INTERIOR in the header). `ic` is the cabinet's interior context:
 * { W, CARC_T, backZ, carcassFront, sideWindows: [{sx, glassFrom, yBot, yTop}], fin, color }.
 * Returns nothing; every part is tagged 'interior*' / 'contents*'.
 */
function buildInterior(THREE, group, spec, x0, x1, yBot, yTop, ic, low) {
  const W = ic.W, T = ic.CARC_T;
  const atLeft = x0 <= -W / 2 + 1e-6, atRight = x1 >= W / 2 - 1e-6;
  // The section's clear box. A side with no carcass panel gets a divider
  // (the lining's thickness plus a structural 1 cm).
  const DIV_T = 0.01;
  const innerL = atLeft ? -W / 2 + T : x0 + DIV_T / 2;
  const innerR = atRight ? W / 2 - T : x1 - DIV_T / 2;
  const zBack = ic.backZ;
  // With overlay fronts, the carcass ends just behind the leaves (carcassFront
  // already accounts for that) so a 2 mm clearance off it is enough. Without
  // overlay, the carcass runs to full depth but the glass pane itself sits
  // well behind that -- clear the pane's own back face instead (see the
  // interiorCtx comment at its construction site).
  const zFront = (ic.overlayFronts ? ic.carcassFront : Math.min(ic.carcassFront, ic.glassBackZ)) - 0.002;
  const floorTop = yBot + INTERIOR_FLOOR_T;
  const ceil = yTop;
  const lining = spec.lining || null;
  const liningMat = lining ? finish(THREE, 'matte', lining) : finish(THREE, ic.fin, ic.color);
  // Floor: the carcass colour (the top of the block below).
  slab(THREE, group, finish(THREE, ic.fin, ic.color), innerL, innerR, yBot, floorTop, zBack, zFront, 'interiorFloor');
  // Dividers where the section has no carcass side.
  if (!atLeft) slab(THREE, group, liningMat, x0 - DIV_T / 2, innerL, yBot, ceil, zBack, zFront, 'interiorDivider');
  if (!atRight) slab(THREE, group, liningMat, innerR, x1 + DIV_T / 2, yBot, ceil, zBack, zFront, 'interiorDivider');
  const inL = innerL + (atLeft && lining ? LINING_T : 0);
  const inR = innerR - (atRight && lining ? LINING_T : 0);
  const inBack = zBack + (lining ? LINING_T : 0);
  const inCeil = ceil - (lining ? LINING_T : 0);
  if (lining) {
    slab(THREE, group, liningMat, innerL, innerR, floorTop, ceil, zBack, inBack, 'interiorLining');
    slab(THREE, group, liningMat, innerL, innerR, inCeil, ceil, inBack, zFront, 'interiorLining');
    // Carcass-side walls: lined, but not over a glass side window (it must
    // stay a window into the section).
    [[atLeft, -1], [atRight, 1]].forEach(([on, sx]) => {
      if (!on) return;
      const win = (ic.sideWindows || []).find(s => s.sx === sx && s.yTop > floorTop && s.yBot < inCeil);
      const zEnd = win ? Math.min(win.glassFrom, zFront) : zFront;
      if (zEnd <= inBack + 0.005) return;
      const a = sx < 0 ? innerL : inR, b = sx < 0 ? inL : innerR;
      slab(THREE, group, liningMat, a, b, floorTop, inCeil, inBack, zEnd, 'interiorLining');
    });
  }
  // Glass shelves, inner width, 3 cm short of the front.
  const shelfYs = (Array.isArray(spec.shelves) ? spec.shelves : [])
    .map(cm => floorTop + cm * CM).filter(y => y > floorTop + 0.02 && y + GLASS_SHELF_T < inCeil - 0.02);
  const shelfFront = zFront - 0.03;
  // The LED strip, full height, at the back corner on the divider side; the
  // shelves stop at it (running through it, their end and back faces would
  // lie in the strip's own).
  const strip = spec.ledStrip && !low;
  const onLeft = !atLeft || atRight; // the divider side; the left when both are carcass sides
  const sw = 0.008;
  const shL = strip && onLeft ? inL + sw : inL, shR = strip && !onLeft ? inR - sw : inR;
  shelfYs.forEach(y => slab(THREE, group, finish(THREE, 'glass', null), shL, shR, y, y + GLASS_SHELF_T, inBack, shelfFront, 'interiorShelf'));
  if (strip) {
    const sx0 = onLeft ? inL : inR - sw, sx1 = onLeft ? inL + sw : inR;
    const strip = slab(THREE, group, finish(THREE, 'emissive', spec.ledStrip.color || '#ff4fa0'),
      sx0, sx1, floorTop, inCeil, inBack, inBack + sw, 'interiorLedStrip');
    strip.castShadow = false;
  }
  // Contents, full detail only.
  if (!low && spec.contents && spec.contents !== 'none') {
    const levels = [floorTop].concat(shelfYs.map(y => y + GLASS_SHELF_T));
    const tops = shelfYs.concat([inCeil]);
    const bays = levels.map((y, i) => ({ y, h: tops[i] - y - 0.01 }));
    buildContents(THREE, group, spec.contents, {
      x0: inL + (spec.ledStrip ? 0.012 : 0), x1: inR, z0: inBack, z1: shelfFront - 0.005, bays
    });
  }
}

/**
 * Low-poly display contents (<= 150 triangles) in the box x0..x1, z0..z1,
 * on `bays` (bottom first: {y, h}). Each proxy is scaled down to fit its bay
 * and the box, so nothing pokes through the glass or a shelf.
 */
function buildContents(THREE, group, kind, b) {
  const W = b.x1 - b.x0, D = b.z1 - b.z0;
  const put = (bay, x, w, h, d, color, name, fin) => {
    const bb = b.bays[Math.min(bay, b.bays.length - 1)];
    const hh = Math.min(h, bb.h), ww = Math.min(w, W), dd = Math.min(d, D);
    const xx = Math.min(Math.max(b.x0 + x, b.x0), b.x1 - ww);
    return slab(THREE, group, finish(THREE, fin || 'matte', color), xx, xx + ww, bb.y, bb.y + hh, b.z0 + 0.005, b.z0 + 0.005 + dd, name);
  };
  if (kind === 'books-games') {
    // Bottom: a row of upright books and magazines.
    const books = [[0.035, 0.28, '#7a2e2e'], [0.03, 0.26, '#2e4a6a'], [0.045, 0.30, '#d8c9a8'], [0.028, 0.25, '#3a5a3a'],
      [0.04, 0.29, '#c0392b'], [0.032, 0.27, '#f0f0f0'], [0.038, 0.24, '#2a2a2a']];
    let x = 0.01;
    books.forEach(([t, h, c]) => { put(0, x, t, h, 0.2, c, 'contentsBook'); x += t + 0.002; });
    // Middle: board-game boxes stacked flat.
    const bay1 = b.bays[Math.min(1, b.bays.length - 1)];
    let y = 0;
    [[0.36, 0.06, 0.24, '#c0392b'], [0.34, 0.07, 0.23, '#f2f2f2'], [0.32, 0.06, 0.22, '#2e5aa8']].forEach(([w, h, d, c]) => {
      const m = put(1, 0.02, w, h, d, c, 'contentsGame');
      m.position.y += y;
      y += Math.min(h, bay1.h) + 0.001;
    });
    // Top: a framed picture leaning back, and a small box.
    const pic = put(2, 0.03, 0.30, 0.25, 0.02, '#3a2a1a', 'contentsPicture');
    pic.position.z += 0.02;
    pic.position.y += 0.002; // tilted, its back bottom edge would dip into the shelf
    pic.rotation.x = -0.12;
    put(2, 0.36, 0.1, 0.08, 0.12, '#e8e0cc', 'contentsBox');
    return;
  }
  if (kind === 'console') {
    // Bottom: a stack of game cases, a small white box, a black box.
    put(0, 0.02, 0.135, 0.05, 0.19, '#1f4fa0', 'contentsGameCases', 'gloss');
    put(0, 0.18, 0.1, 0.1, 0.1, '#f2f2f2', 'contentsBox');
    put(0, 0.3, 0.08, 0.2, 0.08, '#151515', 'contentsBox');
    // Middle: an upright console, and a dock with two controllers.
    put(1, 0.03, 0.1, 0.39, 0.26, '#f4f4f4', 'contentsConsole', 'gloss');
    put(1, 0.2, 0.14, 0.05, 0.08, '#202020', 'contentsDock');
    const c1 = put(1, 0.205, 0.05, 0.1, 0.04, '#f4f4f4', 'contentsController');
    const c2 = put(1, 0.275, 0.05, 0.1, 0.04, '#f4f4f4', 'contentsController');
    [c1, c2].forEach(c => { c.position.y += 0.05 + 0.001; c.position.z += 0.02; });
    // Top: a VR headset on a round stand, and a slim white stand.
    const bay2 = b.bays[Math.min(2, b.bays.length - 1)];
    const standH = Math.min(0.12, bay2.h * 0.5);
    const geo = new THREE.CylinderGeometry(0.035, 0.045, standH, 6);
    const stand = new THREE.Mesh(geo, finish(THREE, 'matte', '#f2f2f2'));
    stand.position.set(b.x0 + 0.12, bay2.y + standH / 2, b.z0 + 0.005 + Math.min(0.12, D) / 2);
    tag(stand, 'contentsStand');
    group.add(stand);
    const hs = put(2, 0.025, 0.19, 0.1, 0.12, '#f7f7f7', 'contentsHeadset', 'gloss');
    hs.position.y += standH + 0.001;
    put(2, 0.3, 0.04, 0.2, 0.04, '#f2f2f2', 'contentsStand');
  }
}

// ---- main build -----------------------------------------------------------

/**
 * @param {object} THREE   injected three.js module
 * @param {object} params  see DEFAULTS; merged over DEFAULTS by the caller's
 *                         convention (this module also defends with its own
 *                         defaults so a partial params object still builds)
 * @param {{detail?: 'full'|'low'}} opts
 */
export function build(THREE, params, opts) {
  const p = Object.assign({}, DEFAULTS, params);
  const gain = typeof p.gain === 'number' && Number.isFinite(p.gain) && p.gain > 0 ? p.gain : 1;
  BODY_GAIN = gain;
  try {
    return buildCabinet(THREE, p, opts);
  } finally {
    BODY_GAIN = 1;
  }
}

function buildCabinet(THREE, p, opts) {
  const detail = (opts && opts.detail) || 'full';
  const low = detail === 'low';

  const W = p.width * CM, H = p.height * CM, D = p.depth * CM;
  const fin = resolveFinish(p);
  const color = p.color;
  const topColor = p.topColor || p.color;
  const overlay = !!p.overlayFronts && !p.columns;
  const faceZ = frontPlane(p, D);
  // Where the carcass (and everything else behind the fronts) ends: `depth`,
  // or behind the leaves when the fronts overlay it.
  const CD = overlay ? faceZ - frontThickness(D) : D;

  const group = new THREE.Group();
  group.name = 'cabinet';

  const plinth = p.plinth || { type: 'plinth', height: 0 };
  const plinthH = (plinth.height || 0) * CM;

  // ---- fronts rows first: a light channel splits the carcass sides ------
  const rows = p.columns ? [] : normaliseFronts(p.fronts, p.width, plinth.height || 0);
  const channels = rows.filter(isChannel).map(r => ({ row: r, y0: r.yBottom * CM, y1: r.yTop * CM }));

  // ---- carcass: back, two ends, top, bottom -----------------------------
  const carcassMat = bodyFinish(THREE, fin, color);
  const CARC_T = p.columns ? (p.panelThickness || 2) * CM : 0.018;

  const bottom = new THREE.Mesh(box(THREE, W, CARC_T, CD), carcassMat);
  bottom.position.set(0, plinthH + CARC_T / 2, CD / 2);
  tag(bottom, 'carcassBottom');
  group.add(bottom);

  const top = new THREE.Mesh(box(THREE, W, CARC_T, CD), bodyFinish(THREE, fin, topColor));
  top.position.set(0, H - CARC_T / 2, CD / 2);
  tag(top, 'carcassTop');
  group.add(top);

  // The sides and the back run BETWEEN the bottom and top panels. (They
  // used to run up into the top, sharing its end and top faces -- in two
  // colours on the TV console, whose top is dark: its jagged edges.)
  const sideY0 = plinthH + CARC_T, sideY1 = H - CARC_T;
  const sideH = sideY1 - sideY0;
  // glassSidePanel: an optional override for ONE side's panel (the tall
  // display cabinet), where the middle band is split front-to-back into a
  // glass window (keep = true) at the front and a wood panel behind it,
  // rather than one plain solid slab. `side` is 'left' | 'right'; `bands` is
  // [{height}, {height, glassDepth, woodDepth}, {height}] top to bottom, cm,
  // summing to the side's clear height. The OTHER side is unaffected.
  const gsp = p.glassSidePanel;
  const sideWindows = [];
  [-1, 1].forEach(sx => {
    const isGlassSide = gsp && ((sx < 0 && gsp.side === 'left') || (sx > 0 && gsp.side === 'right'));
    if (isGlassSide) {
      buildGlassSidePanel(THREE, group, gsp, sx, W, CD, plinthH, CARC_T, sideH, fin, color)
        .forEach(s => sideWindows.push(Object.assign({ sx }, s)));
      return;
    }
    // Split round any light channels (their filler forms the recessed side).
    let y = sideY0;
    const cuts = channels.slice().sort((a, b) => a.y0 - b.y0);
    cuts.concat([{ y0: sideY1, y1: sideY1 }]).forEach(c => {
      const y1 = Math.min(c.y0, sideY1);
      if (y1 - y > 1e-4) slab(THREE, group, carcassMat, sx * W / 2 - (sx > 0 ? CARC_T : 0), sx * W / 2 + (sx < 0 ? CARC_T : 0), y, y1, 0, CD, 'carcassSide');
      y = Math.max(y, c.y1);
    });
  });

  // Interior back panel. Skipped for an open-shelving unit at low detail
  // (nothing hides it anyway - every bay is open) and always skipped at low
  // detail for the fronted modes too, matching the previous behaviour.
  const BACK_T = STRIP_BACK_T;
  if (!low) {
    const back = new THREE.Mesh(box(THREE, W - CARC_T * 2, sideH, BACK_T), carcassMat);
    back.position.set(0, sideY0 + sideH / 2, BACK_T / 2);
    tag(back, 'carcassBack');
    group.add(back);
  }
  const backZ = low ? 0 : BACK_T;

  buildBase(THREE, group, plinth, W, D, fin, color, CD, faceZ, overlay);

  if (p.columns) {
    // ---- columns grid: open shelving --------------------------------------
    // Available width for the columns' OWN (clear) widths excludes the two
    // outer carcass sides AND every internal divider (numColumns - 1 of
    // them), e.g. the store preset: 95 - 2 (left side) - 2 (right side) -
    // 2 (one divider) = 89 = 56 + 33.
    const panelCm = p.panelThickness || 2;
    const numDividers = Math.max(0, (p.columns.length || 0) - 1);
    const clearW = p.width - 2 * panelCm - numDividers * panelCm;
    const cols = normaliseColumns(p.columns, clearW);
    const panelT = panelCm * CM;
    const yBottom = plinthH + CARC_T;
    const yTop = H - CARC_T;
    const offsetX = -W / 2 + panelT; // clear columns start just inside the left carcass side
    const colsGroup = new THREE.Group();
    colsGroup.name = 'cabinetColumns';
    group.add(colsGroup);
    // Each column's placed span must also skip the divider(s) already built
    // to its left, so columns don't overlap the dividers between them.
    let dividerOffsetCm = 0;
    cols.forEach((col, i) => {
      buildColumn(
        THREE, colsGroup,
        { x0: offsetX + (col.xLeft + dividerOffsetCm) * CM, x1: offsetX + (col.xRight + dividerOffsetCm) * CM, rows: col.rows },
        yBottom, yTop, D, panelT, fin, color, i === cols.length - 1
      );
      dividerOffsetCm += panelCm;
    });
  } else {
    // ---- fronts grid --------------------------------------------------------
    const frontsTotalH = rows.reduce((s, r) => s + (r.yTop - r.yBottom), 0);
    const available = p.height - (plinth.height || 0);
    if (Math.abs(frontsTotalH - available) > 0.5) {
      throw new Error(
        `cabinet fronts rows sum to ${frontsTotalH}cm but only ${available}cm is available ` +
        `above the plinth (height ${p.height}cm - plinth ${plinth.height || 0}cm)`
      );
    }
    const frontsGroup = new THREE.Group();
    frontsGroup.name = 'cabinetFronts';
    group.add(frontsGroup);
    // Without overlay fronts, the carcass runs all the way to `depth` (CD ==
    // D), well in front of a glass cell's own pane -- buildInterior must stop
    // short of the PANE's back face instead, or its floor/lining/shelves run
    // through the glass (see buildGlassOrMirrorCell for the same maths).
    const glassPaneT = Math.min(GLASS_PANE_T, frontThickness(D) - PANE_RECESS - 0.002);
    const glassBackZ = faceZ - FRAME_BACKSET - PANE_RECESS - glassPaneT;
    const interiorCtx = { W, CARC_T, backZ, carcassFront: CD, glassBackZ, overlayFronts: overlay, sideWindows, fin, color };
    const handleMaxY = H - CARC_T;

    rows.forEach((row, ri) => {
      const yBot = row.yBottom * CM, yTop = row.yTop * CM;
      if (isChannel(row)) {
        buildChannel(THREE, frontsGroup, row, W, faceZ, backZ, yBot, yTop, fin, color, low);
        return;
      }
      const above = rows[ri - 1];
      const glow = channelLed(above) ? (above.channel.color || '#dbe8ff') : null;
      let x = -W / 2;
      for (const cell of row.cells) {
        const cw = cell.width * CM;
        const x0 = x, x1 = x + cw;
        const edges = overlay
          ? { l: x0 <= -W / 2 + 1e-6, r: x1 >= W / 2 - 1e-6, t: ri === 0, b: ri === rows.length - 1 }
          : null;
        const ctx = { edges, glow, glowLight: glow ? above.channel.light || null : null, interior: interiorCtx, handleMaxY };
        if (cell.kind === 'stack') {
          buildStackCell(THREE, frontsGroup, cell, x0, x1, row.yBottom, row.yTop, D, fin, color, p, low, ctx);
        } else {
          buildFrontCell(THREE, frontsGroup, cell, x0, x1, yBot, yTop, D, fin, color, p, low, ctx);
        }
        x = x1;
      }
    });

    // ---- optional emissive LED strip in the gap below a row --------------
    // Generic opt-in: any row can carry `ledGapBelow: true` to wrap a thin
    // warm strip around the front + both sides of the carcass at that row's
    // bottom edge (one strip per gap between drawers). Never wraps the back.
    for (const row of rows) {
      if (!row.ledGapBelow || low) continue;
      addLedWrap(THREE, group, W, CD, row.yBottom * CM);
    }
  }

  group.traverse(o => { if (o.isMesh) { o.userData.isCabinet = true; } });
  return group;
}

function addShelfLight(THREE, group, x0, x1, y, depth) {
  const w = x1 - x0;
  const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.006, 0.01), finish(THREE, 'emissive', '#fff2cf'));
  strip.position.set((x0 + x1) / 2, y - 0.01, depth * 0.85);
  tag(strip, 'shelfLight');
  strip.castShadow = false;
  group.add(strip);
}

/**
 * A warm LED strip wrapping the front face and both side faces of the
 * carcass at height `y` (a gap between two stacked drawers), but NOT the
 * back - three separate thin boxes, centred ON the carcass faces (half
 * embedded, half proud) so they read as a lit seam without pushing the
 * cabinet's overall bounding box past the builder contract's 0.5 cm
 * tolerance on width/depth. `depth` is where the carcass front is.
 */
function addLedWrap(THREE, group, width, depth, y) {
  const proud = 0.0015; // half-thickness of the strip: pokes out this far (> 1 mm: see the header)
  const front = new THREE.Mesh(new THREE.BoxGeometry(width * 0.98, 0.006, proud * 2), finish(THREE, 'emissive', '#ff9a45'));
  front.position.set(0, y, depth);
  tag(front, 'ledWrapFront');
  front.castShadow = false;
  group.add(front);

  [-1, 1].forEach(sx => {
    const side = new THREE.Mesh(new THREE.BoxGeometry(proud * 2, 0.006, depth * 0.98), finish(THREE, 'emissive', '#ff9a45'));
    side.position.set(sx * width / 2, y, depth / 2);
    tag(side, 'ledWrapSide');
    side.castShadow = false;
    group.add(side);
  });
}

// ---- mirror-cabinet presets ----------------------------------------------
// A mirror cabinet is a plain `cabinet` (mirror-fronted, no plinth, no
// handles) -- both its own spec page (CabinetSpec.html, the "Mirror cabinet"
// object) and BathroomFittingsSpec.html (which lines it up alongside the
// other bathroom fittings) need the exact same params, so both READ this one
// copy instead of each defining their own (item 365c4c72 (5): the two used
// to duplicate this function and its two presets verbatim, free to drift).
/** `doors` mirror-fronted cells, evenly split across `w`; no plinth, no handles. */
export function mirrorCabinetParams(w, h, d, doors) {
  const cells = [];
  for (let i = 0; i < doors; i++) cells.push({ kind: 'mirror', width: +(w / doors).toFixed(3) });
  return { width: w, height: h, depth: d, plinth: { type: 'plinth', height: 0 }, handles: false,
    color: '#f4f1ea', topColor: '#f4f1ea', fronts: [{ height: h, cells }] };
}

export const MIRROR_CABINET_PRESETS = {
  mirrorCabinet3Door: { label: 'Mirror cabinet, 3 doors', params: mirrorCabinetParams(120, 70, 18, 3) },
  mirrorCabinet2Door: { label: 'Mirror cabinet, 2 doors', params: mirrorCabinetParams(80, 70, 16, 2) },
};
