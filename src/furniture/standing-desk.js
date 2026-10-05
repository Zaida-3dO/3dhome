/**
 * standing-desk.js - a sit-stand desk: rectangular top + two telescoping
 * T-foot legs, a crossbar under the top between the legs, and a small
 * control panel on the front edge (dropped at low detail).
 *
 * THE BUILDER CONTRACT (docs/house-profile.md, "Furniture"): pure ESM, THREE
 * injected (no `import 'three'`); exports TYPE, DEFAULTS (frozen, cm,
 * including width/depth/height) and build(THREE, params, { detail }) ->
 * THREE.Group in METRES with y=0 at the bottom, x centred on width, back
 * face at z=0 and front toward +z. Every material comes from makeFinish()
 * so the renderer can merge a room's furniture into a few draws; glass,
 * mirror and emissive parts are marked keep.
 *
 * DEFAULTS.height is the OVERALL ENVELOPE at the default pose (topHeight +
 * topThickness = 96 + 2.5 = 98.5) -- what the contract test's bbox check
 * measures -- not the frame/underside height alone. `topHeight` is the
 * separate, sit-stand-adjustable param (clamped to
 * [minHeight, maxHeight]) that actually drives the geometry.
 *
 * LED STRIP (optional, `ledStrip: true`): one continuous emissive run tucked
 * under the desktop's edge -- down the LEFT side, across the FRONT and back
 * up the RIGHT side by default (`ledSides`). It rides with the top, so it
 * rises and falls with `topHeight`. It is emissive and nothing else: it adds
 * NO real light (perf budget), and like every emissive part it is kept out
 * of the opaque merge (the renderer's unlit glow bucket). Each strip mesh is
 * tagged `userData.ledStrip = true`.
 *
 * This is a PREVIEW of the look (StandingDeskSpec). A desk strip in a house
 * that follows a Home Assistant light is drawn as a room light fixture on its
 * own channel instead -- see docs/house-profile.md, "A desk strip".
 */
import { makeFinish, isKeptFinish } from './finishes.js';
import { range, color, select, toggle, unsupported } from './controls.js';

export const TYPE = 'standing-desk';

/** Frozen defaults, in cm. Illustrative -- not a survey of a real desk.
 * width/depth/height are the OVERALL ENVELOPE at this default pose
 * (topHeight 96 + topThickness 2.5 = height 98.5), per the builder contract. */
export const DEFAULTS = Object.freeze({
  width: 120,
  depth: 80,
  height: 98.5,
  topHeight: 96,
  minHeight: 72,
  maxHeight: 120,
  topThickness: 2.5,
  topColor: '#f4f2ee',
  frameColor: '#f2f1ec',
  controlSide: 'right',
  ledStrip: false,
  ledColor: '#ff9a45',
  ledSides: Object.freeze(['left', 'front', 'right']),
});

/** The edges an LED strip may run along. 'back' is allowed but not default:
 * a desk usually stands against a wall there. */
export const LED_SIDES = Object.freeze(['left', 'front', 'right', 'back']);

/** LED strip cross-section, metres: its height (y) and how far it reaches in
 * from the edge (the outer face sits flush with the desktop's edge, so the
 * strip never widens the item's footprint). */
export const LED_STRIP_H = 0.012;
export const LED_STRIP_T = 0.012;

/** Normalise `ledSides` to a de-duplicated list in LED_SIDES order. Accepts an
 * array or a comma-separated string; unknown names are dropped with a
 * warning; an empty/invalid value falls back to DEFAULTS.ledSides. */
export function normaliseLedSides(sides) {
  let list = sides;
  if (typeof list === 'string') list = list.split(',').map(x => x.trim()).filter(Boolean);
  if (!Array.isArray(list)) return DEFAULTS.ledSides.slice();
  const bad = list.filter(x => LED_SIDES.indexOf(x) === -1);
  if (bad.length) console.warn('standing-desk: unknown ledSides ' + JSON.stringify(bad) + ' ignored');
  const out = LED_SIDES.filter(x => list.indexOf(x) !== -1);
  return out.length ? out : DEFAULTS.ledSides.slice();
}

const CM = 0.01;

/** Clamp a desk's top height into [minHeight, maxHeight], defaulting an
 * absent height to the range's midpoint. Exported so the tweaks panel and
 * the test can both apply exactly this rule rather than reimplementing it. */
export function clampHeight(height, minHeight, maxHeight) {
  const lo = Math.min(minHeight, maxHeight);
  const hi = Math.max(minHeight, maxHeight);
  const h = height != null ? height : (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, h));
}

/**
 * Build a standing desk. Returns a THREE.Group in METRES: y=0 at the floor
 * (the item's bottom), x centred on width, back face (z=0) at the wall
 * side, front face toward +z (toward the user). Each leg is a front-to-back
 * foot bar (flat, spanning the full depth from z=0 to z=depth) with a
 * single telescoping column rising from its centre.
 *
 * @param {object} THREE  the three.js module (or a THREE-shaped test double)
 * @param {object} params  see DEFAULTS for shape/units (all cm); any
 *                         omitted key falls back to DEFAULTS[key]. Pass
 *                         `topHeight` (NOT `height`) to move the desk between
 *                         sit and stand -- `height`/`width`/`depth` describe
 *                         the built envelope, per the builder contract, and
 *                         are not read as inputs.
 * @param {object} [opts]
 * @param {'full'|'low'} [opts.detail]  'low' drops the control panel and
 *                         reduces round-part segment counts (default 'full')
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const p = Object.assign({}, DEFAULTS, params || {});
  const detail = (opts && opts.detail) || 'full';
  const isLow = detail === 'low';

  const width = p.width;
  const depth = p.depth;
  const minHeight = p.minHeight;
  const maxHeight = p.maxHeight;
  const clampedHeight = clampHeight(p.topHeight, minHeight, maxHeight);
  const topThickness = p.topThickness;

  const W = width * CM;
  const D = depth * CM;
  const H = clampedHeight * CM;         // underside-of-top height (frame height)
  const TOP_T = topThickness * CM;

  const topMat = makeFinish(THREE, 'matte', p.topColor);
  const frameMat = makeFinish(THREE, 'matte', p.frameColor);
  const panelMat = makeFinish(THREE, 'matte', '#2a2a2a');
  const displayMat = makeFinish(THREE, 'emissive', '#224466');

  const group = new THREE.Group();
  group.name = 'furniture:standing-desk';

  // ---- desk top: a single rectangular slab, back at z=0, front at z=D ----
  // (x centred, y=0 at the floor; underside of the top sits at y=H)
  const top = new THREE.Mesh(new THREE.BoxGeometry(W, TOP_T, D), topMat);
  top.position.set(0, H + TOP_T / 2, D / 2);
  top.name = 'deskTop';
  top.castShadow = true; top.receiveShadow = true;
  group.add(top);

  // ---- legs: one T-foot column per side, set in from the top's edges ----
  const FOOT_W = Math.min(0.08, W * 0.08);     // foot bar cross-section (x)
  const FOOT_H = 0.04;                         // foot bar height off the floor
  const COL_W = 0.07;                          // column cross-section (x, along width)
  const COL_D = 0.05;                          // column cross-section (z, front-back)
  const INSET = Math.min(0.10, W * 0.08);      // legs sit in slightly from the top's side edges
  const legX = W / 2 - INSET - COL_W / 2;

  function buildLeg(sign) {
    const legGroup = new THREE.Group();
    legGroup.name = sign < 0 ? 'legLeft' : 'legRight';

    // flat foot bar, running the FULL depth from the back (z=0) to the front (z=D)
    const foot = new THREE.Mesh(new THREE.BoxGeometry(FOOT_W, FOOT_H, D), frameMat);
    foot.position.set(sign * legX, FOOT_H / 2, D / 2);
    foot.name = 'legFoot';
    foot.castShadow = true; foot.receiveShadow = true;
    legGroup.add(foot);

    // telescoping column: two stages. The lower (outer) stage is a FIXED
    // sleeve, sized to the desk's lowest reach (minHeight) and never moving.
    // The upper (inner) stage slides up out of it as the desk rises, always
    // reaching from partway down the lower sleeve (a fixed overlap) up to
    // the underside of the top -- so its extension visibly grows with H.
    const columnTop = H;                        // rises to meet the underside of the top
    const columnBot = FOOT_H;
    const lowerH = Math.max(0.02, minHeight * CM - columnBot); // fixed: sized to the lowest reach
    const overlap = lowerH * 0.35;               // upper stage always overlaps the lower by this much
    const upperBottomY = columnBot + lowerH - overlap;
    const upperH = Math.max(0.02, columnTop - upperBottomY);

    const lowerStage = new THREE.Mesh(new THREE.BoxGeometry(COL_W, lowerH, COL_D), frameMat);
    lowerStage.position.set(sign * legX, columnBot + lowerH / 2, D / 2);
    lowerStage.name = 'legColumnLower';
    lowerStage.castShadow = true; lowerStage.receiveShadow = true;
    legGroup.add(lowerStage);

    const upperStage = new THREE.Mesh(
      new THREE.BoxGeometry(COL_W * 0.72, upperH, COL_D * 0.72), frameMat);
    upperStage.position.set(sign * legX, upperBottomY + upperH / 2, D / 2);
    upperStage.name = 'legColumnUpper';
    upperStage.castShadow = true; upperStage.receiveShadow = true;
    legGroup.add(upperStage);

    group.add(legGroup);
    return legGroup;
  }
  buildLeg(-1);
  buildLeg(1);

  // ---- crossbar under the top, between the legs (front-to-back centre) ----
  const crossbarSpan = Math.max(0.05, 2 * legX - COL_W);
  const crossbar = new THREE.Mesh(new THREE.BoxGeometry(crossbarSpan, 0.05, 0.06), frameMat);
  crossbar.position.set(0, H - 0.06, D / 2);
  crossbar.name = 'crossbar';
  crossbar.castShadow = true; crossbar.receiveShadow = true;
  group.add(crossbar);

  // ---- control panel: small box on the front edge, under the top, offset
  // to one side. `controlSide` is as seen by a person standing at the front
  // of the desk (z=D) facing it (looking toward -z, toward the wall) -- in
  // that view, world +x is their right hand and world -x is their left
  // (same convention as legLeft/legRight above and wall-sign's leftBar/
  // rightBar). The panel's outer edge sits 4 cm in from the desk's side
  // edge on that side; an unrecognised value falls back to 'right' with a
  // console warning. Dropped at low detail (a small part with no bearing on
  // the silhouette). Its display strip is emissive and kept out of any
  // merge pass, and it follows the panel to whichever side it lands on.
  if (!isLow) {
    let side = p.controlSide;
    if (side !== 'left' && side !== 'right') {
      if (side !== undefined) {
        console.warn(`standing-desk: unknown controlSide "${side}", falling back to "right"`);
      }
      side = 'right';
    }
    const sign = side === 'left' ? -1 : 1;

    const panelW = Math.min(0.12, W * 0.1);
    const EDGE_GAP = 0.04; // 4 cm from the panel's outer edge to the desk's side edge
    const panelX = sign * (W / 2 - EDGE_GAP - panelW / 2);

    const panel = new THREE.Mesh(new THREE.BoxGeometry(panelW, 0.035, 0.03), panelMat);
    panel.position.set(panelX, H - 0.03, D - 0.05);
    panel.name = 'controlPanel';
    panel.castShadow = true; panel.receiveShadow = true;
    group.add(panel);

    const display = new THREE.Mesh(new THREE.BoxGeometry(panelW * 0.5, 0.012, 0.002), displayMat);
    display.position.set(panelX, H - 0.03, D - 0.05 + 0.03 / 2 + 0.001);
    display.name = 'controlPanelDisplay';
    if (isKeptFinish(display.material.userData.finish)) display.userData.keep = true;
    group.add(display);
  }

  // ---- optional LED strip under the desktop edge -------------------------
  // Kept at low detail too: it is the feature a light binding drives, and it
  // is three boxes. Its outer face is flush with the top's edge and its top
  // face touches the top's underside, so from any view below the desk's
  // surface it reads as a glowing line just under the edge.
  if (p.ledStrip) {
    const sides = normaliseLedSides(p.ledSides);
    const ledMat = makeFinish(THREE, 'emissive', p.ledColor);
    const y = H - LED_STRIP_H / 2;
    const T = LED_STRIP_T;
    const hasFront = sides.indexOf('front') !== -1;
    const hasBack = sides.indexOf('back') !== -1;
    // Side runs stop short of a front/back run so the corners do not overlap.
    const z0 = hasBack ? T : 0;
    const z1 = hasFront ? D - T : D;
    const addRun = (name, w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, LED_STRIP_H, d), ledMat);
      m.position.set(x, y, z);
      m.name = name;
      m.userData.keep = true;
      m.userData.ledStrip = true;
      m.castShadow = false; m.receiveShadow = false;
      group.add(m);
    };
    if (sides.indexOf('left') !== -1) addRun('ledStripLeft', T, z1 - z0, -W / 2 + T / 2, (z0 + z1) / 2);
    if (hasFront) addRun('ledStripFront', W, T, 0, D - T / 2);
    if (sides.indexOf('right') !== -1) addRun('ledStripRight', T, z1 - z0, W / 2 - T / 2, (z0 + z1) / 2);
    if (hasBack) addRun('ledStripBack', W, T, 0, T / 2);
    group.userData.ledSides = sides;
  }

  group.userData.clampedHeight = clampedHeight;
  return group;
}

/** Alias kept for callers migrating from the earlier standalone module. */
export function buildStandingDesk(THREE, params, opts) {
  return build(THREE, params, opts);
}

// ---- edit-mode controls ---------------------------------------------------------
// Ranges, steps, options and labels are copied from the spec page (see controls.js).
export const CONTROLS = [
  range('width', 'Width', 80, 200, 1, 'cm'),
  range('depth', 'Depth', 50, 120, 1, 'cm'),
  range('topThickness', 'Top thickness', 1.5, 5, 0.1, 'cm'),
  // The page bounds topHeight by the live minHeight/maxHeight; as static data that
  // is the union of their two ranges (55..140).
  range('topHeight', 'Top height', 55, 140, 1, 'cm'),
  range('minHeight', 'Min height (sit)', 55, 95, 1, 'cm'),
  range('maxHeight', 'Max height (stand)', 100, 140, 1, 'cm'),
  color('topColor', 'Top colour'),
  color('frameColor', 'Frame colour'),
  select('controlSide', 'Control panel side', ['left', 'right']),
  toggle('ledStrip', 'LED strip'),
  color('ledColor', 'LED colour'),
  unsupported('height', 'Height', 'derived'),
  unsupported('ledSides', 'LED sides', 'array'),
];
