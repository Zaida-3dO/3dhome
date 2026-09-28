/**
 * src/furniture/radiator.js — one design for every house radiator: a white
 * compact panel radiator as the house actually has them (a flat slab with
 * VERTICAL pressed ribs across the front, a slotted top grille, closed end
 * caps, wall brackets bridging the wall gap), a smart thermostatic valve on
 * the END of the radiator at one corner, a lockshield on the other end at the
 * bottom corner, pipes dropping from both, and an optional cover:
 * a clip-on wooden shelf with a raised front lip, or a framed slatted box.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it — see
 * src/furniture/box.js for the minimal example):
 *   - Pure ESM, THREE injected as the first argument — no bare `import
 *     'three'` — so this loads from a plain Node test AND from a spec page
 *     with no import map.
 *   - `TYPE`, a frozen `DEFAULTS` (cm, numeric width/depth/height among
 *     them), and `build(THREE, params, opts)`. `buildRadiator` is a named
 *     alias of `build`.
 *   - `opts.detail` is 'full' | 'low' — 'low' draws the body as ONE plain slab
 *     and drops the ribs, grille, end caps, brackets, valves, pipes and shelf
 *     clips.
 *   - Every mesh carries `userData.finish`, one of matte | gloss | metal |
 *     glass | mirror | emissive (the shared palette). No part here is glass,
 *     mirror or emissive, and no THREE light is ever added.
 *
 * LOCAL FRAME (placer contract — the PLACER applies elevation, not this
 * module):
 *   x  centred on width, along the wall
 *   y  0 at the item's OWN BOTTOM — the placer adds the ITEM's `elevation`
 *   z  0 at the BACK face (wall side), +z = away from the wall, into the room
 *
 * ── WIDTH/HEIGHT/DEPTH ARE THE WHOLE OUTER ENVELOPE ─────────────────────
 * scripts/validate-house.py's footprint/overlap/ceiling checks and
 * src/furniture/place.js read these three params directly, with no idea a
 * "body vs cover vs valves" split exists, so everything this module draws —
 * body, valves, pipes, shelf, box — lands inside width x height x depth, and
 * at 'full' detail with a snug body the bbox EQUALS it. This is a hard rule,
 * with ONE documented exception: the pipes.
 *
 * PIPES AND `pipeDrop`. The real pipes run from the valves down to the room
 * floor. For a wall-hung radiator the floor is the item's `elevation` below
 * this module's y=0, which the builder cannot see, so `pipeDrop` (cm,
 * default 0) says how far below y=0 the pipes continue. It must equal the
 * item's own `elevation` (17 for a wall-hung radiator 17 cm up; 0 for the
 * floor-standing box, whose envelope already starts at the floor), so the
 * PLACER sets it from the item's elevation whenever the item does not author
 * it (src/furniture.js itemParams(), item 8596012d): a house file leaves it
 * out. The pipes
 * are the only part allowed below y=0, and only by exactly `pipeDrop`: 1.5 cm
 * tubes that hug the wall beside the radiator's ends, never wider than the
 * envelope and never in front of it. Everything else stays inside W x H x D
 * with its bottom at y=0, so the validator's footprint/ceiling checks (which
 * read width/height/depth and the item elevation) are unaffected.
 *
 * Because the valves sit on the radiator's ENDS, the envelope reserves room
 * beside the body for them: TRV_REACH_CM on the smart-valve end and
 * LOCKSHIELD_REACH_CM on the other (18 cm together). So the DEFAULT envelope
 * is 98 wide for the standard 80-wide radiator. The body sits inside the
 * span that is left, centred in it — which means flipping the valve to the
 * other end moves the body a few cm inside the same fixed footprint. That is
 * deliberate: the footprint stays honest.
 *
 * The RADIATOR BODY's own size is `bodyWidth`/`bodyHeight`/`bodyDepth`, each
 * optional and defaulting to a SNUG fit (the largest body the envelope leaves
 * room for once the valves and cover are accounted for). A body value larger
 * than that is clamped DOWN. `thickness` is the body's slab depth; the wall
 * gap is DERIVED, never authored: wallGap = bodyDepth - thickness.
 *
 * `bodyElevation` (cm, default 0) lifts the body inside the envelope. It is
 * NOT a placement elevation: a wall-hung radiator is placed by the furniture
 * ITEM's own top-level `elevation` (there is deliberately no params.elevation
 * — it was dead and removed per item 2bc314c9). `bodyElevation` exists for a
 * floor-standing box cover, whose envelope starts at the floor while the
 * radiator inside it hangs 17 cm up. The pipes always run down to the
 * envelope's bottom (y=0) and then `pipeDrop` further (see above).
 *
 * COVER — `params.cover`: 'none' | 'shelf' | 'box'.
 *   'shelf'  a clip-on wooden shelf (coverColor, pine by default) resting on
 *            the radiator top, 1.8 thick, running from just off the wall to
 *            the envelope's front (so it overhangs the radiator's face), with
 *            a RAISED lip standing up along its front edge and a dark metal
 *            clip hooked over each end of the radiator. It runs
 *            `shelfExtendLeft`/`shelfExtendRight` cm past the body's ends.
 *   'box'    a framed slatted cover standing on the floor: a top board that
 *            overhangs the carcass at the front and sides, side panels, a
 *            front frame whose stiles run to the floor as legs, a vent slot
 *            under the top board, a panel of vertical slats, and an open
 *            kick-out under the bottom rail, `boxKick` cm tall (optional:
 *            min(12, 0.14 x height) when absent; 0 runs the bottom rail and
 *            the panel down to the floor, with no kick-out -- the hallway
 *            box). A DARK backing sits right behind
 *            the frame opening, so the gaps between the slats and the vent
 *            slot read dark (as the real one does) and the radiator never
 *            shows through them. White by default.
 *
 * Z-FIGHTING: no two meshes here share an overlapping face plane facing the
 * same way. Adjacent parts meet edge-to-edge or with a small real gap; the
 * test suite checks every pair of box/plane meshes for it.
 *
 * TAPPABLE FOR THE CLIMATE POPOVER. Furniture renders MERGED per room
 * (src/furniture.js / furniture/merge.js), so a hit on a radiator lands on a
 * shared bucket mesh with no per-item identity; the tap is resolved by WHERE
 * it landed instead (home.furnitureItemAt, the robot vacuum's route). Any
 * `radiator` item then opens the climate card of the room it stands in
 * (rooms.json `sensors.climate[room]`), with no binding of its own; a room
 * with none makes it a plain furniture tap. See src/item-cards.js
 * furnitureTapTarget and docs/plans/tap-popovers.md.
 */

export const TYPE = 'radiator';

export const VALVE_CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];
export const COVERS = ['none', 'shelf', 'box'];

// ---- valves (cm) -----------------------------------------------------------
// A smart thermostatic valve as fitted in the house: a white cylinder
// 5.9 across and 9.5 long, on a short chrome valve body out of the radiator's
// end tapping, its axis horizontal and pointing outward along the wall.
const TRV_STUB_CM = 2.5;
const TRV_STUB_R_CM = 1.1;
const TRV_HEAD_D_CM = 5.9;
const TRV_HEAD_LEN_CM = 9.5;
const TRV_DISPLAY_OFFSET_CM = 0.1; // the small dark display sits 1 mm off the head's outer end face
export const TRV_REACH_CM = TRV_STUB_CM + TRV_HEAD_LEN_CM + TRV_DISPLAY_OFFSET_CM; // 12.1
// The lockshield: a small white cap on a short valve body.
const LS_STUB_CM = 1.9;
const LS_STUB_R_CM = 0.9;
const LS_CAP_D_CM = 3;
const LS_CAP_LEN_CM = 4;
export const LOCKSHIELD_REACH_CM = LS_STUB_CM + LS_CAP_LEN_CM; // 5.9
const VALVE_INSET_CM = 4;   // valve axis, in from the body's top or bottom edge
const PIPE_R_CM = 0.75;     // 1.5 cm pipe
const PIPE_OFFSET_CM = 1;   // pipe centre, outward from the body's end (clears the end, inside the valve stub)

// ---- body (cm) -------------------------------------------------------------
const RIB_PITCH_CM = 5;
const MAX_RIBS = 24;
const RIB_R_CM = 1.9;          // half-width of one rib
const RIB_PROUD_CM = 0.6;      // how far a rib stands proud of the slab face
const END_CAP_CM = 0.8;
const TOP_PLATE_CM = 0.3;
const GRILLE_LIFT_CM = 0.15;   // the dark slot lines sit 1.5 mm above the top plate
const GRILLE_LINE_CM = 0.5;    // slot line width

// ---- shelf (cm) ------------------------------------------------------------
const SHELF_GAP_CM = 0.3;      // the board rests just above the grille lines (never coplanar)
const SHELF_BOARD_CM = 1.8;
const SHELF_LIP_H_CM = 1.5;
const SHELF_LIP_T_CM = 1.5;
const SHELF_BACK_GAP_CM = 0.5; // the board stops just short of the wall
const SHELF_MIN_OVERHANG_CM = 1;
const SHELF_CLIP_COVER_CM = 0.5; // the shelf always runs at least this far past each end, over its clip
export const SHELF_STACK_CM = SHELF_GAP_CM + SHELF_BOARD_CM + SHELF_LIP_H_CM; // 3.6 above the body top

// ---- box (cm) --------------------------------------------------------------
const BOX_TOP_CM = 2;
const BOX_OVERHANG_CM = 1.5;   // the top board overhangs the carcass at the front and both sides
const BOX_SIDE_CM = 1.2;
const BOX_FRAME_CM = 1.8;      // front frame (stiles, rails) thickness
const BOX_SLAT_RECESS_CM = 0.4;
const BOX_BACKING_GAP_CM = 0.1;
const BOX_BACKING_CM = 0.4;
const BOX_X_CLEAR_CM = 0.5;    // body+valves to the side panels
const BOX_TOP_CLEAR_CM = 1;    // body top to the top board
const BOX_AIR_GAP_CM = 3;      // body front to the backing
const MAX_SLATS = 16;          // wider boxes get wider slat pitch, not more triangles
// Backing's back face, measured back from the envelope's front face.
const BOX_BACKING_BACK_FROM_FRONT_CM = BOX_OVERHANG_CM + BOX_FRAME_CM + BOX_BACKING_GAP_CM + BOX_BACKING_CM; // 3.8

export const DEFAULTS = Object.freeze({
  width: 98,          // cm, the OUTER ENVELOPE (an 80-wide body plus 18 cm of valve room)
  height: 60,         // cm, the OUTER ENVELOPE's height
  depth: 12,          // cm, the OUTER ENVELOPE's wall-to-front distance
  thickness: 10,      // cm, the body's own slab depth (wallGap = bodyDepth - thickness)
  // elevation is intentionally ABSENT — use the furniture ITEM's own
  // top-level `elevation` (see the module doc comment).
  valveCorner: 'bottom-right',
  color: '#f4f4f1',
  cover: 'none',
  coverColor: '#d9b27a', // pine, for 'shelf'; 'box' is white unless this is moved off the default
  bodyElevation: 0,      // cm, the body's bottom inside the envelope
  shelfExtendLeft: 0,    // cm, shelf overrun past the body's left end ('shelf' only)
  shelfExtendRight: 0,   // cm, shelf overrun past the body's right end ('shelf' only)
  pipeDrop: 0,           // cm the pipes run BELOW y=0 -- the placer sets it to the item's elevation
  // bodyWidth/bodyHeight/bodyDepth are intentionally ABSENT: they default to
  // a snug fit, derived by layout() below. So is boxKick: it defaults to a
  // proportion of the height.
});

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Where everything goes, in cm, in this module's own local frame. Pure, and
 * shared by build() and the spec page's front-elevation diagram so the two
 * can never disagree. Returns:
 *   { cover, corner, W, H, D,
 *     body: { x0, x1, y0, y1, width, height, depth, thickness, gap },
 *     valveSide: 'left'|'right', trvY, lockshieldY,
 *     shelf: { x0, x1 } | null, box: {...} | null }
 */
export function layout(params) {
  const o = Object.assign({}, DEFAULTS, params || {});
  const cover = COVERS.includes(o.cover) ? o.cover : DEFAULTS.cover;
  const corner = VALVE_CORNERS.includes(o.valveCorner) ? o.valveCorner : DEFAULTS.valveCorner;
  const W = Math.max(1, num(o.width, DEFAULTS.width));
  const H = Math.max(1, num(o.height, DEFAULTS.height));
  const D = Math.max(1, num(o.depth, DEFAULTS.depth));
  const valveSide = corner.endsWith('left') ? 'left' : 'right';

  // ---- X: the body sits between the room each end needs, centred in the
  // span that is left.
  const reachL = valveSide === 'left' ? TRV_REACH_CM : LOCKSHIELD_REACH_CM;
  const reachR = valveSide === 'left' ? LOCKSHIELD_REACH_CM : TRV_REACH_CM;
  const extL = cover === 'shelf' ? Math.max(0, num(o.shelfExtendLeft, 0)) : 0;
  const extR = cover === 'shelf' ? Math.max(0, num(o.shelfExtendRight, 0)) : 0;
  let spanL = -W / 2, spanR = W / 2;
  if (cover === 'box') {
    const inner = W / 2 - BOX_OVERHANG_CM - BOX_SIDE_CM - BOX_X_CLEAR_CM;
    spanL = -inner; spanR = inner;
  }
  const roomL = Math.max(reachL, extL), roomR = Math.max(reachR, extR);
  const maxW = Math.max(0, (spanR - roomR) - (spanL + roomL));
  const bodyW = clamp(num(o.bodyWidth, maxW), 0, maxW);
  const cx = ((spanL + roomL) + (spanR - roomR)) / 2;

  // ---- Y: body bottom at bodyElevation, top below whatever sits on it.
  const topStack = cover === 'shelf' ? SHELF_STACK_CM : cover === 'box' ? BOX_TOP_CM + BOX_TOP_CLEAR_CM : 0;
  const y0 = clamp(num(o.bodyElevation, 0), 0, Math.max(0, H - topStack - 1));
  const maxH = Math.max(0, H - topStack - y0);
  const bodyH = clamp(num(o.bodyHeight, maxH), 0, maxH);

  // ---- Z: body front clear of the shelf's front edge / the box backing.
  let maxD = D;
  if (cover === 'shelf') maxD = D - SHELF_MIN_OVERHANG_CM;
  if (cover === 'box') maxD = D - BOX_BACKING_BACK_FROM_FRONT_CM - BOX_AIR_GAP_CM;
  maxD = Math.max(0.1, maxD);
  const bodyD = clamp(num(o.bodyDepth, maxD), 0.1, maxD);
  const thickness = clamp(num(o.thickness, DEFAULTS.thickness), 0.1, bodyD);
  const gap = bodyD - thickness;

  const inset = Math.min(VALVE_INSET_CM, bodyH / 2);
  const body = { x0: cx - bodyW / 2, x1: cx + bodyW / 2, y0, y1: y0 + bodyH,
    width: bodyW, height: bodyH, depth: bodyD, thickness, gap };
  const trvY = corner.startsWith('bottom') ? y0 + inset : y0 + bodyH - inset;
  // The lockshield is always at the BOTTOM of the other end, where the return
  // pipe comes up from the floor (as fitted in the house).
  const lockshieldY = y0 + inset;

  // The shelf always covers the clips, which sit just past each body end.
  const shelf = cover === 'shelf'
    ? { x0: body.x0 - Math.max(extL, SHELF_CLIP_COVER_CM), x1: body.x1 + Math.max(extR, SHELF_CLIP_COVER_CM) }
    : null;

  let box = null;
  if (cover === 'box') {
    const xo = W / 2 - BOX_OVERHANG_CM;               // carcass outer half-width
    const zf = D - BOX_OVERHANG_CM;                   // front frame's front face
    const stileW = Math.min(10, 0.14 * W);
    const slot = Math.min(2.5, 0.03 * H);
    const topRail = Math.min(10, 0.11 * H);
    const bottomRail = Math.min(9, 0.1 * H);
    // the kick-out under the bottom rail: boxKick, or the proportional
    // default; never so tall that the slat panel has no height left
    const kick = clamp(num(o.boxKick, Math.min(12, 0.14 * H)), 0, Math.max(0, H - BOX_TOP_CM - slot - topRail - bottomRail - 1));
    const innerX = xo - stileW;
    const panelY0 = kick + bottomRail, panelY1 = H - BOX_TOP_CM - slot - topRail;
    const panelW = 2 * innerX;
    const slats = Math.max(3, Math.min(MAX_SLATS, Math.round(panelW / 4.7)));
    box = { xo, zf, stileW, slot, topRail, bottomRail, kick, innerX, panelY0, panelY1, panelW, slats };
  }

  const pipeDrop = Math.max(0, num(o.pipeDrop, 0));
  return { cover, corner, W, H, D, body, valveSide, trvY, lockshieldY, shelf, box, pipeDrop };
}

/**
 * The RADIATOR BODY's own size in cm, `{ width, height, depth }`, after every
 * clamp — kept as a named export for the spec page and older callers.
 */
export function bodyEnvelope(o) {
  const b = layout(o).body;
  return { width: b.width, height: b.height, depth: b.depth };
}

/** wallGap, derived from the body's own depth and thickness. */
export function wallGapOf(bodyDepthCm, thicknessCm) {
  return bodyDepthCm - thicknessCm;
}

/** The corner diagonally opposite `corner`. Kept for callers; the
 * lockshield itself now sits at the BOTTOM of the other end (see layout()). */
export function oppositeCorner(corner) {
  const map = {
    'bottom-left': 'top-right',
    'bottom-right': 'top-left',
    'top-left': 'bottom-right',
    'top-right': 'bottom-left',
  };
  return map[corner] || 'top-left';
}

/**
 * One preset per real radiator in the house, by room (generic names only —
 * this repo is public). Every preset sets the SAME key set, so switching
 * presets never leaves a stale value behind and each preset is told apart by
 * its values. `elevation` sits beside `params`, not in it: it is the ITEM's
 * placement elevation (17 cm for the wall-hung ones, 0 for the floor-standing
 * box), which the spec page applies as its preview and a house file sets on
 * the item itself.
 */
const P = (width, height, depth, bodyWidth, cover, valveCorner, extra) => Object.freeze(Object.assign({
  width, height, depth, bodyWidth, bodyHeight: 60, bodyDepth: 12, thickness: 10,
  valveCorner, cover, bodyElevation: 0, shelfExtendLeft: 0, shelfExtendRight: 0, pipeDrop: 17,
  boxKick: Math.min(12, 0.14 * height),   // the default kick-out (read by a 'box' cover only)
}, extra || {}));
export const PRESETS = Object.freeze([
  { name: 'Office: 80 wide, no cover, valve bottom-right (corner unconfirmed)', elevation: 17,
    params: P(98, 60, 12, 80, 'none', 'bottom-right') },
  { name: 'Bedroom: 80 wide, shelf, valve top-left', elevation: 17,
    params: P(98, 63.6, 15.5, 80, 'shelf', 'top-left', { shelfExtendRight: 3 }) },
  { name: 'Living room: 100 wide (width unconfirmed), shelf, valve top-left', elevation: 17,
    params: P(118, 63.6, 15.5, 100, 'shelf', 'top-left', { shelfExtendLeft: 12, shelfExtendRight: 3 }) },
  { name: 'Hallway: 50 wide in a 75x92 slatted box, valve top-left', elevation: 0,
    params: P(75, 92, 19, 50, 'box', 'top-left', { bodyElevation: 17, pipeDrop: 0, boxKick: 0 }) },   // the box stands on the floor: no kick-out
  { name: 'Kitchen: 40 wide, no cover, valve bottom-left', elevation: 17,
    params: P(58, 60, 12, 40, 'none', 'bottom-left') },
]);

const CM = 0.01;

function finishMaterial(THREE, finish, colorHex) {
  const params = {
    matte: { roughness: 0.8, metalness: 0 },
    gloss: { roughness: 0.25, metalness: 0 },
    metal: { roughness: 0.35, metalness: 0.9 },
  }[finish] || { roughness: 0.8, metalness: 0 };
  const m = new THREE.MeshStandardMaterial(Object.assign({ color: colorHex }, params));
  m.userData.finish = finish;
  return m;
}

/**
 * Build one radiator, with its optional cover. Pure function: the same input
 * always produces an equivalent group. x centred on the envelope, y=0 at the
 * item's own bottom (the PLACER applies the item's `elevation`), z=0 at the
 * wall, z=depth at the outermost front face.
 *
 * @param {object} THREE     the three.js namespace (module or UMD/global build)
 * @param {object} [params]  see DEFAULTS; plus optional bodyWidth/bodyHeight/bodyDepth (cm)
 * @param {object} [opts]
 * @param {'full'|'low'} [opts.detail]  'low' = one plain slab, no small parts (default 'full')
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const o = Object.assign({}, DEFAULTS, params || {});
  const L = layout(o);
  const detail = (opts && opts.detail === 'low') ? 'low' : 'full';
  const full = detail === 'full';
  const { body: b, cover } = L;

  const group = new THREE.Group();
  group.name = 'radiator';

  const mats = new Map();
  const mat = (finish, hex) => {
    const key = finish + ':' + hex;
    if (!mats.has(key)) mats.set(key, finishMaterial(THREE, finish, hex));
    return mats.get(key);
  };
  const add = (geo, name, finish, hex, parent) => {
    const mesh = new THREE.Mesh(geo, mat(finish, hex));
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.finish = finish;
    (parent || group).add(mesh);
    return mesh;
  };
  /** An axis-aligned box from cm extents. */
  const boxCm = (name, x0, x1, y0, y1, z0, z1, finish, hex, parent) => {
    const m = add(new THREE.BoxGeometry((x1 - x0) * CM, (y1 - y0) * CM, (z1 - z0) * CM), name, finish, hex, parent);
    m.position.set(((x0 + x1) / 2) * CM, ((y0 + y1) / 2) * CM, ((z0 + z1) / 2) * CM);
    return m;
  };

  /** A half-round running along x, centred at (y, z) cm, its round side
   * facing up ('up') or into the room ('front'). */
  const roundX = (name, x0, x1, y, z, r, finish, hex, facing) => {
    const geo = new THREE.CylinderGeometry(r * CM, r * CM, (x1 - x0) * CM, 8, 1, false, 0, Math.PI);
    const m = add(geo, name, finish, hex);
    // the cylinder's axis is y with the half on +x: Rz(90) puts the axis on x
    // and the half facing +y; a further Rx(90) turns the half to face +z
    m.rotation.set(facing === 'front' ? Math.PI / 2 : 0, 0, Math.PI / 2);
    m.position.set(((x0 + x1) / 2) * CM, y * CM, z * CM);
    return m;
  };
  const bodyHex = new THREE.Color(o.color || DEFAULTS.color).getHex();
  const DARK = 0x3a3a3a;
  const CHROME = 0xb9bdc2;
  const zBack = b.gap, zFront = b.gap + b.thickness;

  // ---- the body ------------------------------------------------------------
  if (b.width > 0 && b.height > 0) {
    // Inside a box the body is hidden behind the backing, the top board and
    // the side panels, so it is always the plain slab there; only its pipes
    // (seen through the kick-out) and valves are drawn in detail.
    if (!full || cover === 'box') {
      boxCm('radiatorPanel', b.x0, b.x1, b.y0, b.y1, zBack, zFront, 'gloss', bodyHex);
    } else {
      const cap = Math.min(END_CAP_CM, b.width / 4);
      const plateTop = b.y1 - GRILLE_LIFT_CM;
      const plateBottom = Math.max(b.y0, plateTop - TOP_PLATE_CM);
      const slabFront = Math.max(zBack + 0.05, zFront - RIB_PROUD_CM);
      // slab between the end caps, set back by the ribs' depth
      boxCm('radiatorPanel', b.x0 + cap, b.x1 - cap, b.y0, plateBottom, zBack, slabFront, 'gloss', bodyHex);
      // closed end caps, full body depth, stopping at the top plate
      boxCm('radiatorEndCap_L', b.x0, b.x0 + cap, b.y0, plateBottom, zBack, zFront, 'gloss', bodyHex);
      boxCm('radiatorEndCap_R', b.x1 - cap, b.x1, b.y0, plateBottom, zBack, zFront, 'gloss', bodyHex);
      // top plate over the whole body
      boxCm('radiatorTopPlate', b.x0, b.x1, plateBottom, plateTop, zBack, zFront, 'gloss', bodyHex);

      // vertical pressed ribs across the front: capped half-cylinders on the
      // slab face, flattened so they stand RIB_PROUD_CM proud
      const slabW = b.width - 2 * cap;
      const ribs = Math.max(0, Math.min(MAX_RIBS, Math.round(slabW / RIB_PITCH_CM)));
      const pitch = ribs ? slabW / ribs : 0;
      const ribR = Math.min(RIB_R_CM, pitch * 0.4);
      const ribY0 = b.y0 + Math.min(1, b.height * 0.05), ribY1 = plateBottom - Math.min(1, b.height * 0.05);
      const proud = zFront - slabFront;
      if (ribR > 0 && ribY1 > ribY0 && proud > 0) {
        for (let i = 0; i < ribs; i++) {
          const x = b.x0 + cap + pitch * (i + 0.5);
          const geo = new THREE.CylinderGeometry(ribR * CM, ribR * CM, (ribY1 - ribY0) * CM, 4, 1, false, -Math.PI / 2, Math.PI);
          const rib = add(geo, `radiatorRib_${i}`, 'gloss', bodyHex);
          rib.scale.z = proud / ribR;
          rib.position.set(x * CM, ((ribY0 + ribY1) / 2) * CM, slabFront * CM);
        }
      }
      // dark slot lines on the top grille, one per rib, across the depth
      for (let i = 0; i < ribs; i++) {
        const x = b.x0 + cap + pitch * (i + 0.5);
        const w = Math.min(GRILLE_LINE_CM, pitch * 0.3);
        const len = Math.max(0.1, b.thickness - 1.2);
        const line = add(new THREE.PlaneGeometry(w * CM, len * CM), `radiatorGrilleSlot_${i}`, 'matte', DARK);
        line.rotation.x = -Math.PI / 2; // lie flat, facing up
        line.position.set(x * CM, b.y1 * CM, ((zBack + zFront) / 2) * CM);
      }

      // wall brackets bridging exactly 0..gap (never deeper: a bracket
      // deeper than the gap would pierce the body's back)
      const bracketD = b.gap > 0 ? b.gap : 0.01;
      const bracketInset = Math.min(b.width * 0.22, 18);
      for (const sx of [-1, 1]) {
        const cxB = (b.x0 + b.x1) / 2 + sx * (b.width / 2 - bracketInset);
        boxCm(`radiatorBracket_${sx < 0 ? 'L' : 'R'}`, cxB - 1.5, cxB + 1.5,
          b.y0 + b.height * 0.25, b.y0 + b.height * 0.75, 0, bracketD, 'metal', 0x3a3a3e);
      }

    }
    if (full) buildValves(THREE, group, L, add, mat, bodyHex, CHROME);
  }

  // ---- cover -------------------------------------------------------------
  const coverHex = new THREE.Color(o.coverColor || DEFAULTS.coverColor).getHex();
  if (cover === 'shelf' && L.shelf) {
    const sx0 = L.shelf.x0, sx1 = L.shelf.x1;
    const by0 = b.y1 + SHELF_GAP_CM, by1 = by0 + SHELF_BOARD_CM;
    const zb0 = Math.min(SHELF_BACK_GAP_CM, L.D / 4);
    boxCm('coverShelf', sx0, sx1, by0, by1, zb0, L.D, 'matte', coverHex);
    // the RAISED lip: stands up on the board's front edge
    const lipT = Math.min(SHELF_LIP_T_CM, (L.D - zb0) / 2);
    if (full) {
      // rounded top: a square base plus a half-round along its length, 1 mm
      // short at each end so its caps never share the base's end planes
      const r = Math.min(lipT / 2, SHELF_LIP_H_CM / 2);
      boxCm('coverShelfLip', sx0, sx1, by1, by1 + SHELF_LIP_H_CM - r, L.D - lipT, L.D, 'matte', coverHex);
      roundX('coverShelfLipRound', sx0 + 0.1, sx1 - 0.1, by1 + SHELF_LIP_H_CM - r, L.D - r, r, 'matte', coverHex, 'up');
    } else {
      boxCm('coverShelfLip', sx0, sx1, by1, by1 + SHELF_LIP_H_CM, L.D - lipT, L.D, 'matte', coverHex);
    }
    if (full) {
      // a dark clip hooked over each end of the radiator, 7 cm down its end.
      // It sits at the FRONT of the end, in front of the smart valve's head:
      // a top-corner valve shares the clip's height band, and a clip at the
      // rear of the end was hidden behind the valve, its stub and its pipe
      // (visual review of PR #76, item 216de62a) -- the real one reads as a
      // dark tab just under the shelf. A body too shallow to fit it there
      // keeps it at the rear, short of the valve body's axis.
      const headR = valveHeadRadius(L, L.trvY);
      const fz0 = valveAxisZ(L, headR) + headR + 0.3, fz1 = b.gap + b.thickness;
      const front = fz1 - fz0 >= 1.2;
      const cz0 = front ? fz0 : Math.max(0.2, b.gap - 0.5);
      const cz1 = front ? fz1 : Math.max(cz0 + 1.2, b.gap + b.thickness / 2 - TRV_STUB_R_CM - 0.3);
      const cy0 = Math.max(b.y0, b.y1 - 7);
      boxCm('coverShelfClip_L', b.x0 - 0.45, b.x0 - 0.05, cy0, by0, cz0, cz1, 'matte', 0x1f1f22);
      boxCm('coverShelfClip_R', b.x1 + 0.05, b.x1 + 0.45, cy0, by0, cz0, cz1, 'matte', 0x1f1f22);
    }
  }

  if (cover === 'box' && L.box) {
    const X = L.box, W = L.W, H = L.H, D = L.D;
    const white = (o.coverColor && o.coverColor !== DEFAULTS.coverColor) ? coverHex : 0xf6f6f3;
    const zf = X.zf, zb = X.zf - BOX_FRAME_CM;
    const topY = H - BOX_TOP_CM;
    // top board: the whole envelope width and depth, with a rounded front
    // edge at full detail (the half-round is 1 mm short at each end)
    if (full) {
      const r = BOX_TOP_CM / 2;
      boxCm('coverTop', -W / 2, W / 2, topY, H, 0, D - r, 'matte', white);
      roundX('coverTopNosing', -W / 2 + 0.1, W / 2 - 0.1, topY + r, D - r, r, 'matte', white, 'front');
    } else {
      boxCm('coverTop', -W / 2, W / 2, topY, H, 0, D, 'matte', white);
    }
    // side panels, behind the front frame
    boxCm('coverSide_L', -X.xo, -X.xo + BOX_SIDE_CM, 0, topY, 0, zb, 'matte', white);
    boxCm('coverSide_R', X.xo - BOX_SIDE_CM, X.xo, 0, topY, 0, zb, 'matte', white);
    // stiles, running to the floor as legs
    boxCm('coverStile_L', -X.xo, -X.innerX, 0, topY, zb, zf, 'matte', white);
    boxCm('coverStile_R', X.innerX, X.xo, 0, topY, zb, zf, 'matte', white);
    if (full) {
      // a routed vertical groove down the middle of each stile, drawn as a
      // shadow line 0.5 mm proud of the stile face (never coplanar with it)
      const gw = Math.min(0.6, (X.xo - X.innerX) * 0.1);
      for (const sx of [-1, 1]) {
        const gx = sx * (X.innerX + X.xo) / 2;
        const groove = add(new THREE.PlaneGeometry(gw * CM, (topY - 3) * CM), `coverStileGroove_${sx < 0 ? 'L' : 'R'}`, 'matte', 0xb4b4ae);
        groove.position.set(gx * CM, ((topY - 3) / 2 + 1.5) * CM, (zf + 0.05) * CM);
      }
    }
    // rails; the vent slot is the gap between the top rail and the top board
    boxCm('coverRail_top', -X.innerX, X.innerX, X.panelY1, topY - X.slot, zb, zf, 'matte', white);
    boxCm('coverRail_bottom', -X.innerX, X.innerX, X.kick, X.panelY0, zb, zf, 'matte', white);
    // vertical slats, recessed a little behind the frame face
    const pitch = X.panelW / X.slats;
    const slatW = pitch * 0.58;
    for (let i = 0; i < X.slats; i++) {
      const x = -X.innerX + pitch * (i + 0.5);
      if (full) {
        boxCm(`coverSlat_${i}`, x - slatW / 2, x + slatW / 2, X.panelY0, X.panelY1, zb, zf - BOX_SLAT_RECESS_CM, 'matte', white);
      } else {
        // low detail: each slat is just its front face
        const slat = add(new THREE.PlaneGeometry(slatW * CM, (X.panelY1 - X.panelY0) * CM), `coverSlat_${i}`, 'matte', white);
        slat.position.set(x * CM, ((X.panelY0 + X.panelY1) / 2) * CM, (zf - BOX_SLAT_RECESS_CM) * CM);
      }
    }
    // ONE dark backing behind the whole frame opening (slat panel + vent
    // slot), tucked 1 cm behind each stile and 1 mm behind the frame
    const bz1 = zb - BOX_BACKING_GAP_CM, bz0 = bz1 - BOX_BACKING_CM;
    boxCm('coverBacking', -X.innerX - 1, X.innerX + 1, X.kick + X.bottomRail / 2, topY - 0.1, bz0, bz1, 'matte', DARK);
  }

  return group;
}

// Depth ceiling for anything the valves draw: the envelope, or -- inside a
// box -- the same real air gap short of the backing the body keeps.
const valveZCeil = L => (L.cover === 'box' ? L.D - BOX_BACKING_BACK_FROM_FRONT_CM - BOX_AIR_GAP_CM : L.D);
/** A valve head's radius (cm) at height y: never below y=0 or through the depth ceiling. */
function valveHeadRadius(L, y, headR = TRV_HEAD_D_CM / 2) {
  return Math.max(0.2, Math.min(headR, y - 0.05, valveZCeil(L) / 2 - 0.05));
}
/** A valve's axis depth (cm) for head radius r: mid-body, kept clear of the wall and the ceiling. */
function valveAxisZ(L, r) {
  const b = L.body;
  return clamp(b.gap + b.thickness / 2, r + 0.05, Math.max(r + 0.05, valveZCeil(L) - r - 0.05));
}

/** The smart valve on one end, the lockshield on the other, and their pipes. */
function buildValves(THREE, group, L, add, mat, bodyHex, CHROME) {
  const b = L.body;

  function valve(name, side, y, stubLen, stubR, headLen, headR, isSmart) {
    const g = new THREE.Group();
    g.name = name;
    const dir = side === 'left' ? -1 : 1;
    const end = side === 'left' ? b.x0 : b.x1;
    const r = valveHeadRadius(L, y, headR);
    const z = valveAxisZ(L, r);
    const sR = Math.min(stubR, r);

    // valve body out of the end tapping, axis along x
    const stub = add(new THREE.CylinderGeometry(sR * CM, sR * CM, stubLen * CM, 8), 'valveBody', 'metal', CHROME, g);
    stub.rotation.z = Math.PI / 2;
    stub.position.set((end + dir * stubLen / 2) * CM, y * CM, z * CM);

    // the head: a white cylinder pointing outward along the wall
    const head = add(new THREE.CylinderGeometry(r * CM, r * CM, headLen * CM, isSmart ? 16 : 8), 'head', 'gloss', 0xf7f7f5, g);
    head.rotation.z = Math.PI / 2;
    head.position.set((end + dir * (stubLen + headLen / 2)) * CM, y * CM, z * CM);

    if (isSmart) {
      // small dark display on the head's outer end face
      const disp = add(new THREE.PlaneGeometry(r * 0.9 * CM, r * 0.55 * CM), 'display', 'matte', 0x2a2a2e, g);
      disp.rotation.y = dir * Math.PI / 2; // face outward along ±x
      disp.position.set((end + dir * (stubLen + headLen + TRV_DISPLAY_OFFSET_CM)) * CM, y * CM, z * CM);
    }

    // pipe dropping from the valve body to the floor: the envelope's bottom,
    // then pipeDrop further (the one part allowed below y=0)
    const bottom = -L.pipeDrop, len = y - bottom;
    if (len > 0.05) {
      const pipe = add(new THREE.CylinderGeometry(PIPE_R_CM * CM, PIPE_R_CM * CM, len * CM, 8, 1, true), 'pipe', 'gloss', bodyHex, g);
      pipe.position.set((end + dir * PIPE_OFFSET_CM) * CM, ((y + bottom) / 2) * CM, z * CM);
    }
    group.add(g);
    return g;
  }

  const lsSide = L.valveSide === 'left' ? 'right' : 'left';
  valve('radiatorValveSmart', L.valveSide, L.trvY, TRV_STUB_CM, TRV_STUB_R_CM, TRV_HEAD_LEN_CM, TRV_HEAD_D_CM / 2, true);
  valve('radiatorValveLockshield', lsSide, L.lockshieldY, LS_STUB_CM, LS_STUB_R_CM, LS_CAP_LEN_CM, LS_CAP_D_CM / 2, false);
}

// Named alias, per the shared contract.
export const buildRadiator = build;
