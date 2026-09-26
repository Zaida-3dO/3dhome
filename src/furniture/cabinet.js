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
 * FRONTS GRID (row-based front)
 *   params.fronts is an array of rows, top to bottom:
 *     { height, cells: [ {kind, width, ...kind-specific fields} ] }
 *   Each row's cells must span the full cabinet width (see normaliseFronts).
 *   Cell kinds:
 *     'door'    - hinged door, one leaf per cell. handle unless handle:false.
 *     'drawer'  - a drawer front. handle unless handle:false (push-to-open).
 *     'glass'   - fixed glass panel front, keep = true.
 *     'mirror'  - fixed mirror panel front, keep = true.
 *     'sliding' - a sliding door split into equal horizontal `panels`, each
 *                 'white' (matte, carcass colour) or 'mirror' (keep = true).
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
 *   LED strip in the gap between it and the row below (the bedside-table-
 *   with-LED-drawers presets): it wraps the front face and both side faces of
 *   the carcass at that height, but NOT the back, and is always keep = true.
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
 *   band's height. The OTHER side is unaffected (a plain slab). Two units
 *   built as mirror images of each other (glass doors facing across a TV)
 *   just use `side: 'left'` on one and `side: 'right'` on the other, with the
 *   fronts grid's cell order swapped to match.
 *
 * PRESETS live in CabinetSpec.html, not here - this module only builds
 * whatever `params` it is given. Preset *names* are generic and descriptive
 * (no owner names): this is a public repo.
 *
 * DEPENDS ON PR #30 (feat/furniture-data-layer): ./finishes.js ships there.
 * This module's own tests (scripts/test-cabinet.mjs) and CI's dedicated
 * cabinet-builder step cannot pass until that PR merges and this branch
 * rebases onto it - not a bug in this file, a merge-order dependency.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

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
  plinth: { type: 'plinth', height: 8 },
  gloss: false,
  color: '#f2f0ec',
  topColor: '#f2f0ec',
  shelfLights: false,
  handles: true
});

// ---- finish + mesh helpers ----------------------------------------------

/** A material from the shared palette, with keep-flag bookkeeping left to the caller. */
function finish(THREE, cls, color) {
  return makeFinish(THREE, cls, color);
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

function buildDoorCell(THREE, group, cell, x0, x1, yBot, yTop, depth, gloss, color, handles) {
  const w = x1 - x0, h = yTop - yBot;
  const cx = (x0 + x1) / 2, cy = (yBot + yTop) / 2;
  const T = Math.min(0.018, depth * 0.06);
  const mat = finish(THREE, gloss ? 'gloss' : 'matte', color);
  const leaf = new THREE.Mesh(box(THREE, w * 0.98, h * 0.98, T), mat);
  leaf.position.set(cx, cy, T / 2);
  tag(leaf, 'cabinetDoor');
  group.add(leaf);
  if (handles !== false && cell.handle !== false) {
    addHandle(THREE, group, x1 - Math.min(0.04, w * 0.08), cy, T);
  }
}

function buildDrawerCell(THREE, group, cell, x0, x1, yBot, yTop, depth, gloss, color, handles) {
  const w = x1 - x0, h = yTop - yBot;
  const cx = (x0 + x1) / 2, cy = (yBot + yTop) / 2;
  const T = Math.min(0.018, depth * 0.06);
  const mat = finish(THREE, gloss ? 'gloss' : 'matte', color);
  const front = new THREE.Mesh(box(THREE, w * 0.98, h * 0.94, T), mat);
  front.position.set(cx, cy, T / 2);
  tag(front, 'drawerFront');
  group.add(front);
  const showHandle = handles !== false && cell.handle !== false;
  if (showHandle) {
    addHandle(THREE, group, cx, yTop - h * 0.12, T, true);
  }
}

function buildGlassOrMirrorCell(THREE, group, kind, x0, x1, yBot, yTop, depth) {
  const w = x1 - x0, h = yTop - yBot;
  const cx = (x0 + x1) / 2, cy = (yBot + yTop) / 2;
  const T = kind === 'glass' ? 0.006 : 0.01;
  const mat = finish(THREE, kind, null);
  const pane = new THREE.Mesh(box(THREE, w * 0.94, h * 0.94, T), mat);
  pane.position.set(cx, cy, T / 2);
  tag(pane, kind === 'glass' ? 'cabinetGlassDoor' : 'cabinetMirrorDoor');
  pane.userData.isMirror = kind === 'mirror'; // spec-three.jsx env-cube convention
  group.add(pane);
  // Thin frame so a glass/mirror door still reads as a door, not a hole.
  const frameMat = finish(THREE, 'matte', '#ffffff');
  [x0, x1].forEach(fx0 => {
    const FT = 0.02;
    const fx = fx0 === x0 ? fx0 + FT / 2 : fx0 - FT / 2;
    const stile = new THREE.Mesh(box(THREE, FT, h, T), frameMat);
    stile.position.set(fx, cy, T / 2);
    tag(stile, 'cabinetDoorFrame');
    group.add(stile);
  });
}

function buildSlidingCell(THREE, group, cell, x0, x1, yBot, yTop, depth) {
  const w = x1 - x0, h = yTop - yBot;
  const cx = (x0 + x1) / 2;
  const panels = (cell.panels && cell.panels.length) ? cell.panels : ['white', 'mirror', 'mirror', 'white'];
  const n = panels.length;
  const panelH = h / n;
  const railT = 0.012;
  const T = Math.min(0.02, depth * 0.05); // slides proud of the carcass front
  const frameMat = finish(THREE, 'matte', '#ffffff');

  for (let i = 0; i < n; i++) {
    // panels[] is authored top-to-bottom; row i=0 is the top panel.
    const pTop = yTop - i * panelH;
    const pBot = pTop - panelH;
    const pcy = (pTop + pBot) / 2;
    const kind = panels[i] === 'mirror' ? 'mirror' : 'matte';
    const inset = kind === 'mirror' ? 0.01 : 0.006;
    const paneT = kind === 'mirror' ? 0.008 : T;
    const mat = finish(THREE, kind, '#ffffff');
    const pane = new THREE.Mesh(box(THREE, w - inset * 2, Math.max(0.01, panelH - railT), paneT), mat);
    pane.position.set(cx, pcy, paneT / 2);
    tag(pane, kind === 'mirror' ? 'slidingMirrorPanel' : 'slidingWhitePanel');
    pane.userData.isMirror = kind === 'mirror';
    group.add(pane);

    if (i > 0) {
      const rail = new THREE.Mesh(box(THREE, w, railT, T), frameMat);
      rail.position.set(cx, pTop, T / 2);
      tag(rail, 'slidingRail');
      group.add(rail);
    }
  }
  // Thin outer frame edges (left/right stiles), per the reference photo.
  const FT = 0.015;
  [x0 + FT / 2, x1 - FT / 2].forEach(fx => {
    const stile = new THREE.Mesh(box(THREE, FT, h, T), frameMat);
    stile.position.set(fx, (yBot + yTop) / 2, T / 2);
    tag(stile, 'slidingFrame');
    group.add(stile);
  });
}

/**
 * Dispatches one non-stack front cell (door/drawer/glass/mirror/sliding/
 * open) to its builder. Shared by the row loop and buildStackCell's
 * sub-cells, so a stack's sub-cells support every ordinary cell kind.
 */
function buildFrontCell(THREE, group, cell, x0, x1, yBot, yTop, depth, gloss, color, p, low) {
  switch (cell.kind) {
    case 'door':
      buildDoorCell(THREE, group, cell, x0, x1, yBot, yTop, depth, gloss, color, p.handles);
      break;
    case 'drawer':
      buildDrawerCell(THREE, group, cell, x0, x1, yBot, yTop, depth, gloss, color, p.handles);
      break;
    case 'glass':
      buildGlassOrMirrorCell(THREE, group, 'glass', x0, x1, yBot, yTop, depth);
      if (p.shelfLights && !low) addShelfLight(THREE, group, x0, x1, yTop, depth);
      break;
    case 'mirror':
      buildGlassOrMirrorCell(THREE, group, 'mirror', x0, x1, yBot, yTop, depth);
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
function buildStackCell(THREE, group, cell, x0, x1, rowYBottomCm, rowYTopCm, depth, gloss, color, p, low) {
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
  for (const sub of subCells) {
    if (sub.kind === 'stack') {
      throw new Error('cabinet stack cell: sub-cells cannot themselves be "stack" (no nesting)');
    }
    const yBotCm = yTopCm - sub.height;
    buildFrontCell(THREE, group, sub, x0, x1, yBotCm * CM, yTopCm * CM, depth, gloss, color, p, low);
    yTopCm = yBotCm;
  }
}

function addHandle(THREE, group, x, y, frontZ, isDrawer) {
  const mat = finish(THREE, 'metal', '#d8dadc');
  if (isDrawer) {
    const bar = new THREE.Mesh(box(THREE, 0.10, 0.014, 0.014), mat);
    bar.position.set(x, y, frontZ + 0.02);
    tag(bar, 'drawerHandle');
    group.add(bar);
  } else {
    const bar = new THREE.Mesh(box(THREE, 0.014, 0.14, 0.014), mat);
    bar.position.set(x, y, frontZ + 0.02);
    tag(bar, 'doorHandle');
    group.add(bar);
  }
}

// ---- plinth / legs / wheels ---------------------------------------------

function buildBase(THREE, group, base, width, depth, gloss, color) {
  const h = base.height * CM;
  if (h <= 0) return;
  if (base.type === 'legs') {
    const legMat = finish(THREE, 'metal', '#3a3a3a');
    const inset = 0.04;
    const r = 0.012;
    const xs = [-width / 2 + inset, width / 2 - inset];
    const zs = [inset, depth - inset];
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
    const zs = [inset, depth - inset];
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
  const plinthMat = finish(THREE, gloss ? 'gloss' : 'matte', color);
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
 * panel `woodDepth` deep behind it, glassDepth + woodDepth <= the cabinet
 * depth. Top and bottom bands are plain solid panels in the carcass finish.
 *
 * A band's `height` is optional - like a fronts row/column, any band missing
 * one gets an even share of whatever height is left after the explicit
 * bands, so the caller can give just the (structural) middle band's height
 * and let the plain top/bottom bands fill the rest of the side's own clear
 * height (sideH), which already has the carcass top/bottom panels and the
 * plinth subtracted out - it is NOT the same number as the cabinet's overall
 * `height` param.
 */
function buildGlassSidePanel(THREE, group, gsp, sx, W, D, plinthH, CARC_T, sideH, gloss, color) {
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

  const carcassMat = finish(THREE, gloss ? 'gloss' : 'matte', color);
  const x = sx * (W / 2 - CARC_T / 2);
  let yTop = plinthH + CARC_T + sideH;
  bands.forEach((band, i) => {
    const h = band.height * CM;
    const yBot = yTop - h;
    const cy = (yBot + yTop) / 2;
    if (band.glassDepth) {
      // Front glass window (keep = true) + a wood-tone panel behind it.
      const glassD = band.glassDepth * CM;
      const woodD = Math.min(band.woodDepth * CM, D - glassD);
      const glass = new THREE.Mesh(box(THREE, CARC_T, h, glassD), finish(THREE, 'glass', null));
      glass.position.set(x, cy, D - glassD / 2);
      tag(glass, 'displaySideGlass');
      group.add(glass);

      const wood = new THREE.Mesh(box(THREE, CARC_T, h, woodD), finish(THREE, 'matte', '#6b4a35'));
      wood.position.set(x, cy, D - glassD - woodD / 2);
      tag(wood, 'displaySideWood');
      group.add(wood);
    } else {
      const panel = new THREE.Mesh(box(THREE, CARC_T, h, D), carcassMat);
      panel.position.set(x, cy, D / 2);
      tag(panel, 'carcassSide');
      group.add(panel);
    }
    yTop = yBot;
  });
}

// ---- columns grid (open shelving) ----------------------------------------

/**
 * One column of `rowCount` equal open shelf bays between yBottom and yTop
 * (cm), separated by horizontal shelf panels PANEL_T thick, plus a vertical
 * divider on its right edge (shared with the next column) unless `isLast`.
 * Every bay is open - no front - so the carcass back is what's visible.
 */
function buildColumn(THREE, group, col, yBottom, yTop, depth, panelT, gloss, color, isLast) {
  const x0 = col.x0, x1 = col.x1;
  const mat = finish(THREE, gloss ? 'gloss' : 'matte', color);
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
  const detail = (opts && opts.detail) || 'full';
  const low = detail === 'low';

  const W = p.width * CM, H = p.height * CM, D = p.depth * CM;
  const gloss = !!p.gloss;
  const color = p.color;
  const topColor = p.topColor || p.color;

  const group = new THREE.Group();
  group.name = 'cabinet';

  const plinth = p.plinth || { type: 'plinth', height: 0 };
  const plinthH = (plinth.height || 0) * CM;

  // ---- carcass: back, two ends, top, bottom -----------------------------
  const carcassMat = finish(THREE, gloss ? 'gloss' : 'matte', color);
  const CARC_T = p.columns ? (p.panelThickness || 2) * CM : 0.018;

  const bottom = new THREE.Mesh(box(THREE, W, CARC_T, D), carcassMat);
  bottom.position.set(0, plinthH + CARC_T / 2, D / 2);
  tag(bottom, 'carcassBottom');
  group.add(bottom);

  const top = new THREE.Mesh(box(THREE, W, CARC_T, D), finish(THREE, gloss ? 'gloss' : 'matte', topColor));
  top.position.set(0, H - CARC_T / 2, D / 2);
  tag(top, 'carcassTop');
  group.add(top);

  const sideH = H - plinthH - CARC_T;
  // glassSidePanel: an optional override for ONE side's panel (the tall
  // display cabinet), where the middle band is split front-to-back into a
  // glass window (keep = true) at the front and a wood panel behind it,
  // rather than one plain solid slab. `side` is 'left' | 'right'; `bands` is
  // [{height}, {height, glassDepth, woodDepth}, {height}] top to bottom, cm,
  // summing to the cabinet height. The OTHER side is unaffected (plain).
  const gsp = p.glassSidePanel;
  [-1, 1].forEach(sx => {
    const isGlassSide = gsp && ((sx < 0 && gsp.side === 'left') || (sx > 0 && gsp.side === 'right'));
    if (isGlassSide) {
      buildGlassSidePanel(THREE, group, gsp, sx, W, D, plinthH, CARC_T, sideH, gloss, color);
      return;
    }
    const side = new THREE.Mesh(box(THREE, CARC_T, sideH, D), carcassMat);
    side.position.set(sx * (W / 2 - CARC_T / 2), plinthH + CARC_T + sideH / 2, D / 2);
    tag(side, 'carcassSide');
    group.add(side);
  });

  // Interior back panel. Skipped for an open-shelving unit at low detail
  // (nothing hides it anyway - every bay is open) and always skipped at low
  // detail for the fronted modes too, matching the previous behaviour.
  if (!low) {
    const back = new THREE.Mesh(box(THREE, W - CARC_T * 2, sideH, 0.006), carcassMat);
    back.position.set(0, plinthH + CARC_T + sideH / 2, 0.003);
    tag(back, 'carcassBack');
    group.add(back);
  }

  buildBase(THREE, group, plinth, W, D, gloss, color);

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
        yBottom, yTop, D, panelT, gloss, color, i === cols.length - 1
      );
      dividerOffsetCm += panelCm;
    });
  } else {
    // ---- fronts grid --------------------------------------------------------
    const rows = normaliseFronts(p.fronts, p.width, plinth.height || 0);
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

    for (const row of rows) {
      const yBot = row.yBottom * CM, yTop = row.yTop * CM;
      let x = -W / 2;
      for (const cell of row.cells) {
        const cw = cell.width * CM;
        const x0 = x, x1 = x + cw;
        if (cell.kind === 'stack') {
          buildStackCell(THREE, frontsGroup, cell, x0, x1, row.yBottom, row.yTop, D, gloss, color, p, low);
        } else {
          buildFrontCell(THREE, frontsGroup, cell, x0, x1, yBot, yTop, D, gloss, color, p, low);
        }
        x = x1;
      }
    }

    // ---- optional emissive LED strip in the gap below a row --------------
    // Generic opt-in: any row can carry `ledGapBelow: true` to wrap a thin
    // warm strip around the front + both sides of the carcass at that row's
    // bottom edge (the bedside-table-with-LED-drawers presets use this, one
    // strip per gap between drawers). Never wraps the back.
    for (const row of rows) {
      if (!row.ledGapBelow || low) continue;
      addLedWrap(THREE, group, W, D, row.yBottom * CM);
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
 * tolerance on width/depth.
 */
function addLedWrap(THREE, group, width, depth, y) {
  const proud = 0.001; // half-thickness of the strip pokes out this far
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
