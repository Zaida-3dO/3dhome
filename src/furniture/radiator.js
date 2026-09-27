/**
 * src/furniture/radiator.js — one design for every house radiator: a modern
 * white panel radiator (horizontal convector fins, wall brackets bridging
 * the wall gap, pipe tails to the floor) with a smart TRV valve head on one
 * corner and a lockshield valve diagonally opposite it, plus an optional
 * cover (a plain shelf, or a full slatted enclosure that can be LARGER than
 * the radiator itself).
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it — see
 * src/furniture/box.js for the minimal example):
 *   - Pure ESM, THREE injected as the first argument — no bare `import
 *     'three'` — so this loads from a plain Node test AND from a spec page
 *     with no import map.
 *   - `TYPE`, a frozen `DEFAULTS` (cm, numeric width/depth/height among
 *     them), and `build(THREE, params, opts)`. `buildRadiator` is a named
 *     alias of `build`.
 *   - `opts.detail` is 'full' | 'low' — 'low' drops small parts (the valve
 *     assemblies) and reduces curve segments on the ones that remain.
 *   - Every mesh carries `userData.finish`, one of matte | gloss | metal |
 *     glass | mirror | emissive (the shared palette). Any glass, mirror or
 *     emissive part additionally carries `userData.keep = true` so a later
 *     merge/culling pass never drops it.
 *
 * LOCAL FRAME (placer contract — the PLACER applies elevation, not this
 * module):
 *   x  centred on width, along the wall
 *   y  0 at the item's OWN BOTTOM — the placer adds `elevation` when it
 *      positions the returned group in the scene
 *   z  0 at the BACK face (wall side), +z = away from the wall, into the
 *      room
 *
 * `width`/`height`/`depth` ALWAYS DESCRIBE THE OUTER ENVELOPE — including
 * any shelf or box cover — because scripts/validate-house.py's footprint/
 * overlap/ceiling checks and src/furniture/place.js both read these three
 * params directly, with no knowledge of "body vs cover": a smaller number
 * here than the thing actually built would validate a placement that then
 * collides with a wall or another item in the live scene. This is a hard
 * rule, not a style choice.
 *
 * The RADIATOR BODY's own size is `bodyWidth`/`bodyHeight`/`bodyDepth` —
 * each independently OPTIONAL, defaulting to a snug fit against the
 * envelope (== `width`/`height`/`depth`) when omitted, which is exactly
 * "no cover, body fills the envelope". `thickness` is the body's own slab
 * depth; the wall-to-body-back air gap is always DERIVED, never authored:
 *   wallGap = bodyDepth - thickness
 * A body value LARGER than its envelope counterpart is clamped DOWN to fit
 * (a body cannot be bigger than the box it sits inside).
 *
 * COVER — `params.cover`: 'none' | 'shelf' | 'box'.
 *   'shelf'  a wooden shelf sitting on top of the radiator, spanning the
 *            envelope's width and depth, about 2cm thick, with a short
 *            downward fascia lip (offset clear of the slat/panel tops — see
 *            the z-fighting fix below). NOT a full enclosure — the sides
 *            stay open, so the radiator body is visible from the front/
 *            sides below the shelf.
 *   'box'    a full slatted radiator cover: the same top shelf, plus front
 *            and side panels FULLY ENCLOSING the radiator (spanning the
 *            envelope's own width/height/depth), with vertical slats on the
 *            front face backed by a solid panel (FIX 444c3a1e) so nothing
 *            of the radiator body is visible through the gaps between
 *            slats. White by default (params.coverColor).
 *
 * FIX 444c3a1e, ROUND 2 (fins still visible on a snug box cover): with no
 * explicit bodyDepth, a 'box' cover used to default the interior clearance
 * to EXACTLY the body's own depth, so the slats sat in the very same plane
 * as the radiator's front face and the backing panel ended up buried INSIDE
 * the body — a raycast through the slat gaps hit fins/panel, never the
 * backing. Fixed by giving every box/shelf cover a REAL clearance margin
 * (COVER_CLEARANCE_CM = a genuine air gap PLUS the backing panel's own
 * fixed offset from the envelope's front face — see the constant's own
 * comment) between the body's own front face and the cover's backing —
 * enforced by clamping bodyDepth (and, in build(), thickness too, since
 * thickness can never exceed the depth it is meant to fit inside) DOWN when
 * the envelope depth doesn't leave room for both the body and the margin,
 * so the fins can never be in the same plane as (or ahead of) the backing
 * regardless of what the caller passes.
 *
 * ELEVATION — deliberately NOT a param here. It never was one in practice:
 * this module's own y=0 is the item's bottom, and the PLACER (src/house-
 * loader.js, src/furniture/place.js, scripts/validate-house.py) reads only
 * the furniture ITEM's own top-level `elevation` field (schema
 * $defs/furnitureItem.elevation, default 0) to position it — never
 * `params.elevation`. An earlier version of this module and its schema
 * block both carried a `params.elevation` default of 17 that nothing ever
 * read, which silently drew every radiator on the floor unless the
 * item-level field was also set (fixed per item 2bc314c9, option (a): drop
 * the dead param rather than have the loader read a second, redundant
 * elevation field). To place a radiator off the floor, set the ITEM's own
 * `elevation`, not a params key — the spec page's own Elevation slider is a
 * SPEC-PAGE-ONLY preview control (it plays the placer role for its 3D
 * preview) and does not correspond to an authorable param.
 *
 * NOT TAPPABLE (YET) FOR THE CLIMATE POPOVER. Tapping a light, curtain or
 * door opens its popover (src/tap-popovers.js), but a radiator cannot be
 * tapped: furniture renders MERGED per room (src/furniture.js /
 * furniture/merge.js), so a hit on a radiator lands on a shared bucket mesh
 * carrying no per-item identity. Making it tappable needs a hit-point ->
 * oriented-footprint lookup: convert the hit point to plan coordinates and
 * test it against the footprint and height of each climate-bound
 * `house.furniture[]` radiator -- climate-bound meaning it stands in a room
 * that rooms.json binds a thermostat to through `sensors.climate[room]`, so
 * the mapping stays derived, never hand-written. Until then the climate
 * popover opens only through the ?debug=1 seam. See docs/plans/tap-popovers.md
 * and Agent Standup item 647fc9bd.
 *
 * ── DIMENSIONS ARE ILLUSTRATIVE, EXCEPT DEFAULTS ────────────────────────
 * DEFAULTS below are the standard house radiator: 80w x 60h, thickness 10,
 * depth 12 (a 2cm wall gap), no cover. Other rooms vary (remodel.sh3d:
 * living room 95cm, hallway typically a smaller radiator inside a larger
 * slatted cover, bedroom 95cm) — pass those as `params`, never by editing
 * DEFAULTS.
 * ─────────────────────────────────────────────────────────────────────
 */

export const TYPE = 'radiator';

export const VALVE_CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];
export const COVERS = ['none', 'shelf', 'box'];
const SHELF_T_CM = 2;          // 2cm shelf thickness
const PANEL_THICK_CM = 1.2;    // box side/front panel material thickness (kept in sync with panelThick below, in metres)
const CLEARANCE_CM = 1;        // a small real air gap on every side the body must clear the cover's own interior surfaces by
const FASCIA_SETBACK_CM = 0.4; // the fascia lip's own setback behind the envelope's front face (kept in sync with fasciaSetback below, in metres)
// Real clear air gap between the body's own front face and the box cover's
// BACKING PANEL (not the slats' outer/visible face — the backing sits
// ~1.6cm further back than the envelope's own front, at
// panelThick(1.2cm) + backingThick/2(0.4cm) — see the backing's own
// placement below). This clamp must cover BOTH that fixed 1.6cm offset AND
// a genuine air gap in front of the body, or a raycast through the slats
// can reach the fins even though body.depth is technically "clamped".
const COVER_AIR_GAP_CM = 3;                          // the real air gap we want in front of the body
const COVER_BACKING_OFFSET_CM = 1.6;                 // panelThick + backingThick/2, kept in sync with the backing's own placement
const COVER_CLEARANCE_CM = COVER_AIR_GAP_CM + COVER_BACKING_OFFSET_CM;

export const DEFAULTS = Object.freeze({
  width: 80,        // cm, the OUTER ENVELOPE's width (== body width when there's no cover)
  height: 60,       // cm, the OUTER ENVELOPE's height
  depth: 12,        // cm, the OUTER ENVELOPE's wall-to-front distance
  thickness: 10,    // cm, the radiator BODY's own slab depth (wallGap is derived: bodyDepth - thickness)
  // elevation is intentionally ABSENT — it is dead as a params field (see
  // the module doc comment above). Use the furniture ITEM's own top-level
  // `elevation` instead.
  valveCorner: 'bottom-right',
  color: '#f2f2ef',
  cover: 'none',
  coverColor: '#c8a878', // light oak, used for 'shelf'; 'box' defaults to white below
  // bodyWidth/bodyHeight/bodyDepth are intentionally ABSENT from DEFAULTS —
  // there is no universal default independent of width/height/depth; see
  // bodyEnvelope() below, which derives a snug fit (== the outer envelope)
  // when they are left unset, i.e. exactly the no-cover case.
});

/**
 * The RADIATOR BODY's own size, in cm, resolved from `o` (DEFAULTS merged
 * with params): `{ width, height, depth }`. Each of bodyWidth/bodyHeight/
 * bodyDepth is independently optional, defaulting to a snug fit against the
 * OUTER ENVELOPE (width/height/depth) when omitted.
 *
 * The body is ALWAYS clamped to fit STRICTLY INSIDE the cover's own inner
 * volume, never merely inside the outer envelope — an explicit, oversized
 * body* param is clamped exactly the same way the snug default is, so there
 * is only one code path and no way to bypass it:
 *   height  <= the shelf's own underside (height - SHELF_T_CM), minus a
 *              small real clearance, whenever a cover (shelf or box) exists
 *              — otherwise the panel's top face is coplanar with (or
 *              through) the shelf.
 *   width   <= inside the box's own side panels (width - 2*PANEL_THICK_CM),
 *              minus clearance, when cover is 'box' — otherwise the panel's
 *              end faces are coplanar with (or through) the side panels.
 *   depth   <= clear of the box's own backing panel by a real air gap
 *              (COVER_CLEARANCE_CM, which already accounts for the
 *              backing's material offset — see its own comment), when
 *              cover is 'box'; clear of the SHELF's own fascia lip front
 *              face by a small clearance, when cover is 'shelf' (the lip
 *              is a purely decorative front face with no backing behind
 *              it, so it only needs a small margin, not the box's full
 *              COVER_CLEARANCE_CM).
 * With no cover, none of this applies and the body is simply clamped to the
 * envelope (unchanged from before) — this is the "no cover" contract case.
 */
export function bodyEnvelope(o) {
  let w = Math.min(o.width, o.bodyWidth != null ? o.bodyWidth : o.width);
  let h = Math.min(o.height, o.bodyHeight != null ? o.bodyHeight : o.height);
  let d = Math.min(o.depth, o.bodyDepth != null ? o.bodyDepth : o.depth);

  if (o.cover === 'shelf' || o.cover === 'box') {
    // Below the shelf, with a real clearance gap — applies to BOTH cover
    // kinds, since a shelf sits above the body either way.
    h = Math.min(h, Math.max(0, o.height - SHELF_T_CM - CLEARANCE_CM));
  }
  if (o.cover === 'box') {
    // Inside the side panels, with a real clearance gap.
    w = Math.min(w, Math.max(0, o.width - 2 * PANEL_THICK_CM - 2 * CLEARANCE_CM));
    // Clear of the backing panel by a real air gap (COVER_CLEARANCE_CM
    // already folds in the backing's own fixed material offset).
    d = Math.min(d, Math.max(0, o.depth - COVER_CLEARANCE_CM));
  } else if (o.cover === 'shelf') {
    // Clear of the fascia lip's own BACK face (not merely its front face)
    // by a small real margin — the lip has no backing to protect (it is a
    // decorative front face only), so this is a much smaller clamp than
    // the box's COVER_CLEARANCE_CM, but without it the body's own front
    // face can end up level with or AHEAD of the lip, burying the lip
    // behind the radiator instead of it hanging visibly in front. The lip
    // itself is 1.5cm thick and sits fasciaSetback (0.4cm) behind the
    // envelope's own front face, so its BACK face is at
    // `depth - 1.5 - fasciaSetback`; FASCIA_MARGIN_CM (0.5cm) is added on
    // top so the clamp lands the body STRICTLY before that back face, not
    // exactly coplanar with it (round-4 nit: 1.5 + fasciaSetback alone
    // ties exactly with the lip's back face, which a strict `<` test
    // correctly flags as failing).
    const FASCIA_MARGIN_CM = 0.5;
    const FASCIA_CLEARANCE_CM = 1.5 + FASCIA_SETBACK_CM + FASCIA_MARGIN_CM;
    d = Math.min(d, Math.max(0, o.depth - FASCIA_CLEARANCE_CM));
  }
  return { width: w, height: h, depth: d };
}

/** wallGap, derived from the BODY's own depth and thickness. Never pass
 * this in as an authored field — bodyDepth and thickness are the source of
 * truth. */
export function wallGapOf(bodyDepthCm, thicknessCm) {
  return bodyDepthCm - thicknessCm;
}

/**
 * Five generic, publishable presets (no owner-specific naming — this repo
 * is public). Each is a partial params object layered onto DEFAULTS; width
 * is a param in every case, per room.
 */
// Preset depths for 'shelf'/'box' covers are chosen so the DEFAULT wall gap
// (thickness 10) comes out to the house-standard 2cm, exactly like the
// no-cover preset — not whatever a snug-fit clamp happens to leave over.
// Round-4 nit (d9fb9d55, item 5): with the OLD depths (12 for shelf, 16 for
// box), the snug body clamp left only a 0.5cm/1.4cm gap, so a "standard"
// preset radiator read as sitting almost flush with the wall. Grown here:
//   shelf: depth 12 -> 14.4 (bodyDepth clamps to exactly 12, gap = 2)
//   box:   depth 16 -> 16.6 (bodyDepth clamps to exactly 12, gap = 2)
// Heights are grown by the same 2.4/0.6cm the depths grew by, purely so the
// presets keep their original visual proportions -- the height clamp itself
// is independent of this fix and was already correct.
export const PRESETS = Object.freeze([
  { name: '80 wide, no cover, valve bottom-right', params: Object.freeze({ width: 80, height: 60, depth: 12, cover: 'none', valveCorner: 'bottom-right' }) },
  { name: '120 wide, shelf top, valve bottom-left', params: Object.freeze({ width: 120, height: 62, depth: 14.4, cover: 'shelf', valveCorner: 'bottom-left' }) },
  { name: '95 wide, shelf top', params: Object.freeze({ width: 95, height: 62, depth: 14.4, cover: 'shelf' }) },
  { name: '80 wide, full slatted cover', params: Object.freeze({ width: 80, height: 62, depth: 16.6, cover: 'box' }) },
  { name: '75x92 slatted cover, 50 wide radiator', params: Object.freeze({
    width: 75, height: 92, depth: 19, cover: 'box',
    bodyWidth: 50, bodyHeight: 60, bodyDepth: 12, thickness: 10,
  }) },
]);

const CM = 0.01;

/** The corner diagonally opposite `corner` — where the lockshield goes. */
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
 * Local-frame X/Y (METRES) of a named corner's valve stem centre, given
 * full-size width/height in cm and this module's OWN y=0-at-bottom frame.
 * Used by both the 3D builder and the spec page's 2D corner-picker diagram
 * so they never drift apart. `bodyHeightCm` is the RADIATOR BODY's own
 * height (not the outer envelope height, which may be taller when a cover
 * sits above it) — the valve always reads corners of the body, not the
 * cover.
 */
export function cornerPoint(corner, bodyWidthCm, bodyHeightCm, insetCm = 8) {
  const hw = bodyWidthCm / 2;
  const x = corner.endsWith('left') ? -hw + insetCm : hw - insetCm;
  const y = corner.startsWith('bottom') ? insetCm : bodyHeightCm - insetCm;
  return { x: x * CM, y: y * CM };
}

function finishMaterial(THREE, finish, colorHex) {
  const params = {
    matte: { roughness: 0.8, metalness: 0 },
    gloss: { roughness: 0.25, metalness: 0 },
    metal: { roughness: 0.35, metalness: 0.9 },
    glass: { roughness: 0.05, metalness: 0, transparent: true, opacity: 0.25, depthWrite: false },
    mirror: { roughness: 0.02, metalness: 1 },
    emissive: { roughness: 0.8, metalness: 0 },
  }[finish] || { roughness: 0.8, metalness: 0 };
  const opts = Object.assign({ color: colorHex }, params);
  if (finish === 'emissive') opts.emissive = colorHex;
  return new THREE.MeshStandardMaterial(opts);
}

/**
 * Build one radiator, with its optional cover. Pure function: same input
 * always produces an equivalent group. Returns a THREE.Group with x centred
 * on the OUTER ENVELOPE's width, y=0 at the item's own bottom (the PLACER
 * applies `elevation`), z=0 at the back (wall) face, z=depth (the envelope's
 * own depth) at the outermost front face.
 *
 * @param {object} THREE     the three.js namespace (module or UMD/global build)
 * @param {object} [params]
 * @param {number} [params.width]        cm, the OUTER ENVELOPE's width (always; includes any cover)
 * @param {number} [params.height]       cm, the OUTER ENVELOPE's height (always; includes any cover)
 * @param {number} [params.depth]        cm, the OUTER ENVELOPE's wall-to-front distance (always; includes any cover)
 * @param {number} [params.bodyWidth]    cm, the RADIATOR BODY's own width (default: a snug fit == width)
 * @param {number} [params.bodyHeight]   cm, the RADIATOR BODY's own height (default: a snug fit == height)
 * @param {number} [params.bodyDepth]    cm, the RADIATOR BODY's own wall-to-front distance (default: a snug fit, clamped for cover clearance)
 * @param {number} [params.thickness]    cm, the radiator body's own slab depth
 * @param {string} [params.valveCorner]  one of VALVE_CORNERS
 * @param {string} [params.color]        radiator body colour
 * @param {'none'|'shelf'|'box'} [params.cover]
 * @param {string} [params.coverColor]   cover wood/paint colour
 * @param {object} [opts]
 * @param {'full'|'low'} [opts.detail]   'low' drops the valve assemblies
 *                                       and reduces curve segments (default 'full')
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const o = Object.assign({}, DEFAULTS, params || {});
  const detail = (opts && opts.detail === 'low') ? 'low' : 'full';
  const cover = COVERS.includes(o.cover) ? o.cover : DEFAULTS.cover;

  // The OUTER ENVELOPE — width/height/depth ALWAYS mean this, cover or not.
  const ENV_W = o.width * CM, ENV_H = o.height * CM, ENV_D = o.depth * CM;

  // The RADIATOR BODY's own size: a snug fit against the envelope by
  // default, or explicit bodyWidth/bodyHeight/bodyDepth (each clamped so
  // the body never exceeds the envelope, and bodyDepth additionally
  // clamped for real cover clearance on a box).
  const body = bodyEnvelope(Object.assign({}, o, { cover }));
  const corner = VALVE_CORNERS.includes(o.valveCorner) ? o.valveCorner : DEFAULTS.valveCorner;
  const BODY_W = body.width * CM, H = body.height * CM;
  // `thickness` is the body's own slab depth, so it can never exceed the
  // body's own total wall-to-front distance (body.depth) -- clamping
  // bodyDepth down (for cover clearance) without ALSO clamping thickness
  // would let the panel's own geometry (built from thickness) overshoot
  // the clamped body.depth it is supposed to fit inside, silently eating
  // back into the clearance margin bodyEnvelope() just reserved.
  const thicknessCm = Math.min(o.thickness, body.depth);
  const T = thicknessCm * CM;
  const GAP = Math.max(0, wallGapOf(body.depth, thicknessCm)) * CM;
  const BODY_D = body.depth * CM;

  // Both body and envelope are centred on x=0.
  const bodyOffsetX = 0;

  // Box-cover interior geometry constants, computed once here so the valve
  // budget (below) and the cover build (further below) always agree on
  // exactly where the backing panel's inner (wall-facing) face sits —
  // duplicating this arithmetic in two places is what let the valve clamp
  // and the backing's real position drift apart before.
  const panelThickM = PANEL_THICK_CM * CM;
  const backingThickM = 0.008;
  const boxBackingInnerZ = cover === 'box' ? (ENV_D - panelThickM - backingThickM) : null;

  const group = new THREE.Group();
  group.name = 'radiator';

  const panelMat = finishMaterial(THREE, 'gloss', new THREE.Color(o.color).getHex());
  panelMat.userData.finish = 'gloss';

  const add = (mesh, name, finish, mat) => {
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.finish = finish || 'matte';
    if (mat) mat.userData.finish = mesh.userData.finish;
    group.add(mesh);
    return mesh;
  };

  // ---- main panel: back face at z=GAP, bottom edge at y=0, ALWAYS the
  // BODY's own width/height (independent of a wider/taller envelope/cover).
  // Front face convector fins scored in as a ribbed strip pattern via
  // repeated thin boxes — fewer fins at 'low' detail.
  const panel = new THREE.Mesh(new THREE.BoxGeometry(BODY_W, H, T), panelMat);
  panel.position.set(bodyOffsetX, H / 2, GAP + T / 2);
  add(panel, 'radiatorPanel', 'gloss', panelMat);

  const finCount = detail === 'low'
    ? Math.max(2, Math.round(H / (8 * CM)))
    : Math.max(4, Math.round(H / (4 * CM)));
  const finH = (H * 0.82) / finCount;
  const finGap = (H * 0.82 - finH * finCount) / Math.max(1, finCount - 1);
  const finTop = H * 0.91;
  // The fins sit PROUD of the panel's own front face by a small amount, but
  // must never claim more depth than the OUTER ENVELOPE actually has left
  // beyond the panel — capped by whatever room remains to z=(envelope
  // depth). bodyEnvelope() already reserves COVER_CLEARANCE_CM ahead of the
  // body on a box cover, so in practice the fins land well short of the
  // slats/backing; this cap is the last-resort guard for a bare radiator
  // (no cover) whose own depth/thickness leaves little room.
  const finRoomLeft = Math.max(0, ENV_D - (GAP + T));
  const finProtrusion = Math.min(0.006, finRoomLeft);
  const finFrontZ = GAP + T + finProtrusion / 2;
  for (let i = 0; i < finCount; i++) {
    const fy = finTop - i * (finH + finGap) - finH / 2;
    const finMat = finishMaterial(THREE, 'metal', 0xb9bdc2);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(BODY_W * 0.94, Math.max(0.004, finH * 0.6), Math.max(0.0005, finProtrusion)), finMat);
    fin.position.set(bodyOffsetX, fy, finFrontZ);
    add(fin, `radiatorFin_${i}`, 'metal', finMat);
  }

  // ---- wall brackets: two, set roughly a fifth of the BODY's own width
  // from each end, BRIDGING the gap exactly — from the wall face (z=0) to
  // the body's back (z=GAP). Never DEEPER than GAP itself: a bracket needs
  // a minimum real thickness to read as a solid part (0.4cm), but when the
  // derived GAP is smaller than that (a tight wall gap), a fixed 0.4cm
  // minimum used to push the bracket's own front face PAST z=GAP and into
  // the panel it is supposed to only bridge up to — coplanar with, and
  // slightly piercing, the panel's own back face (round-4 nit: hidden
  // against the wall in practice, but a real overlap). Capped to GAP so the
  // bracket only ever THINS as the gap narrows, never overshoots it.
  const bracketInset = Math.min(BODY_W * 0.22, 0.18);
  const bracketW = 0.03, bracketH = H * 0.5;
  // Spans exactly 0..GAP, same as the "bridging the gap exactly" contract
  // always intended — GAP itself is the correct depth for a wide gap and
  // was already used unclamped in that case (Math.max(GAP, 0.004) reduces
  // to GAP whenever GAP >= 0.004). Only the near-zero-gap case needs a
  // floor, and that floor must never exceed GAP itself, or the bracket
  // pierces the panel it is meant to only reach up to.
  const bracketD = GAP > 0 ? GAP : 0.0001;
  for (const sx of [-1, 1]) {
    const bx = bodyOffsetX + sx * (BODY_W / 2 - bracketInset);
    const brMat = finishMaterial(THREE, 'metal', 0x3a3a3e);
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(bracketW, bracketH, bracketD), brMat);
    bracket.position.set(bx, H / 2, bracketD / 2);
    add(bracket, `radiatorBracket_${sx < 0 ? 'L' : 'R'}`, 'metal', brMat);
  }

  // ---- valves: the smart TRV head on `corner`, the lockshield on the
  // opposite corner. Dropped entirely at 'low' detail.
  if (detail === 'full') {
    const valveInsetCm = Math.min(body.width, body.height) * 0.1 + 4;
    const segs = 12;
    function buildValve(atCorner, isSmart) {
      const p = cornerPoint(atCorner, body.width, body.height, valveInsetCm);
      const g = new THREE.Group();
      g.name = isSmart ? 'radiatorValveSmart' : 'radiatorValveLockshield';

      const frontZ = GAP + T;
      // The valve stem + body + tail-radius + LED epsilon must ALL stay
      // INSIDE the OUTER ENVELOPE (never push the bbox past z=depth, and
      // never poke through a shallower cover than the body's own depth) —
      // AND, on a box cover, never pierce the backing panel either (the
      // backing's own inner face, not the envelope's outer face, is the
      // real ceiling for a box; the envelope depth is still correct for a
      // bare radiator or a shelf, where there is no backing to clear).
      const ceilingZ = boxBackingInnerZ != null ? Math.min(ENV_D, boxBackingInnerZ) : ENV_D;
      const roomLeft = Math.max(0, ceilingZ - frontZ);
      // The ENTIRE valve assembly's outermost point — including the tail's
      // own radius (it hangs vertically, so its radius sticks out in Z) and
      // the LED's tiny standoff — must land at or before z=ceilingZ (the
      // envelope depth, or the box backing's inner face if that's closer).
      // Everything below is sized as a FRACTION of `budget`, so nothing can
      // ever overflow it: with zero room the whole assembly (stem, body,
      // tail radius, LED) collapses toward zero rather than pushing past
      // the ceiling.
      const budget = roomLeft;
      const tailRadius = budget * 0.12;
      const ledEpsilon = budget * 0.01;
      const wantedFraction = isSmart ? 0.75 : 0.55; // stem+body use this share of budget; rest is tailRadius+ledEpsilon reserve
      const stemBodyBudget = Math.max(0, budget - tailRadius - ledEpsilon);
      const protrusion = Math.min(stemBodyBudget, budget * wantedFraction);
      const stemLen = Math.max(0, protrusion * 0.55);
      const stemRadius = Math.max(0.001, Math.min(0.010, budget * 0.08));
      const stemMat = finishMaterial(THREE, 'metal', 0xb9bdc2);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(stemRadius, stemRadius, Math.max(0.001, stemLen), segs), stemMat);
      stem.name = 'stem';
      stem.userData.finish = 'metal';
      stemMat.userData.finish = 'metal';
      stem.rotation.x = Math.PI / 2;
      stem.position.set(p.x, p.y, frontZ + stemLen / 2);
      g.add(stem);

      const bodyRadius = Math.max(0.001, Math.min(isSmart ? 0.020 : 0.015, budget * 0.16));
      const bodyLen = Math.max(0.001, protrusion - stemLen);
      const bodyFinish = isSmart ? 'gloss' : 'metal';
      const bodyMat = finishMaterial(THREE, bodyFinish, isSmart ? 0xffffff : 0xb9bdc2);
      const bodyMesh = new THREE.Mesh(new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyLen, segs + 4), bodyMat);
      bodyMesh.name = 'body';
      bodyMesh.userData.finish = bodyFinish;
      bodyMat.userData.finish = bodyFinish;
      bodyMesh.rotation.x = Math.PI / 2;
      bodyMesh.position.set(p.x, p.y, frontZ + stemLen + bodyLen / 2);
      g.add(bodyMesh);

      // The pipe tail's Z position is where its FACE sits (it hangs
      // vertically, so its own radius sticks out in Z on both sides) — this
      // lands tailRadius short of frontZ+budget, which is exactly what the
      // reserve above was budgeted for, so tailZ+tailRadius <= ceilingZ always.
      const tailTopY = p.y;
      const tailZ = Math.min(frontZ + stemLen + bodyLen, ceilingZ - tailRadius - ledEpsilon);
      const tailMat = finishMaterial(THREE, 'metal', 0xb9bdc2);
      const tail = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(0.001, tailRadius), Math.max(0.001, tailRadius), tailTopY, segs), tailMat);
      tail.name = 'tail';
      tail.userData.finish = 'metal';
      tailMat.userData.finish = 'metal';
      tail.position.set(p.x, tailTopY / 2, tailZ);
      g.add(tail);

      // smart TRV only: a small emissive status LED — the one visible cue
      // that this valve is "smart". Flagged userData.keep so a culling pass
      // never drops it.
      if (isSmart) {
        const ledColor = 0x2ecc71;
        const ledMat = finishMaterial(THREE, 'emissive', ledColor);
        ledMat.emissiveIntensity = 1.2;
        ledMat.userData.finish = 'emissive';
        const led = new THREE.Mesh(new THREE.CircleGeometry(Math.min(0.006, bodyRadius * 0.7), segs), ledMat);
        led.name = 'statusLed';
        led.userData.finish = 'emissive';
        led.userData.keep = true;
        ledMat.userData.keep = true;
        // CircleGeometry lies flat in the XY plane, facing +Z by default —
        // exactly "outward" here, so NO rotation is needed (a rotation
        // around Y or X would turn its flat disc edge-on into Z, which is
        // what silently blew the envelope budget before an earlier fix).
        led.position.set(p.x, p.y, Math.min(tailZ + ledEpsilon, ceilingZ));
        g.add(led);
      }

      g.traverse(m => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
      group.add(g);
      return g;
    }
    buildValve(corner, true);
    buildValve(oppositeCorner(corner), false);
  }

  // ---- cover: 'shelf' or 'box', spanning the OUTER ENVELOPE's own width/
  // height/depth (which can be larger than the radiator body it encloses —
  // a real hallway cover is a 50x60 radiator inside a 75x92 box). The
  // shelf sits at the top of the envelope, leaving exactly shelfT of height
  // for itself; everything below the shelf line is the enclosure's clear
  // interior height, which comfortably contains the body's own H.
  if (cover !== 'none') {
    const shelfColorHex = new THREE.Color(o.coverColor || DEFAULTS.coverColor).getHex();
    const shelfMat = finishMaterial(THREE, 'matte', shelfColorHex);
    const shelfT = SHELF_T_CM * CM;
    const shelfY = ENV_H - shelfT; // top of the enclosure's clear interior — the shelf sits directly above this
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(ENV_W, shelfT, ENV_D), shelfMat);
    shelf.position.set(0, shelfY + shelfT / 2, ENV_D / 2);
    add(shelf, 'coverShelf', 'matte', shelfMat);

    // A short downward fascia lip at the shelf's front edge. Offset BACK
    // (toward the wall) from the envelope's own front face by a hair so it
    // never shares a z-plane with the slat tops / front panel face —
    // low-severity fix for the reported z-fight between the oak fascia and
    // the white slat tops. Narrower than the full envelope width — inset an
    // extra hair PAST the side panels' own inner faces (not merely flush
    // with their outer faces, which would still be coplanar) — so its own
    // ends are not coplanar with the box's side panels either (follow-up
    // d9fb9d55a).
    const lipH = 0.04;
    const fasciaSetback = FASCIA_SETBACK_CM * CM; // kept in sync with the FASCIA_SETBACK_CM constant used by bodyEnvelope()'s own clamp
    const lipW = cover === 'box' ? ENV_W - 2 * panelThickM - 0.01 : ENV_W;
    const lipMat = finishMaterial(THREE, 'matte', shelfColorHex);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(lipW, lipH, 0.015), lipMat);
    lip.position.set(0, shelfY - lipH / 2, ENV_D - 0.0075 - fasciaSetback);
    add(lip, 'coverFascia', 'matte', lipMat);

    if (cover === 'box') {
      // Full enclosure spanning the ENVELOPE's own width/height/depth (not
      // the body's) — front + two side panels, white by default, with
      // vertical slats on the front backed by a solid panel. The panels run
      // from the enclosure's own bottom (y=0) up to the underside of the
      // shelf.
      // If the caller passed an explicit colour it wins for the body; the
      // enclosure defaults to white regardless, per the reference photos,
      // unless coverColor was explicitly set away from the shelf default.
      const enclosureColorHex = (o.coverColor && o.coverColor !== DEFAULTS.coverColor)
        ? new THREE.Color(o.coverColor).getHex() : 0xffffff;
      const panelThick = panelThickM; // shared with the valve-budget/bodyEnvelope() constants above

      // side panels: full envelope depth, full enclosure height, at each
      // end of the envelope's own width.
      for (const sx of [-1, 1]) {
        const sideMat = finishMaterial(THREE, 'matte', enclosureColorHex);
        const side = new THREE.Mesh(new THREE.BoxGeometry(panelThick, shelfY, ENV_D), sideMat);
        side.position.set(sx * (ENV_W / 2 - panelThick / 2), shelfY / 2, ENV_D / 2);
        add(side, `coverSide_${sx < 0 ? 'L' : 'R'}`, 'matte', sideMat);
      }

      // FIX 444c3a1e — a solid backing panel directly behind the slat
      // layer, spanning the full envelope width/height, so the gaps between
      // slats show painted MDF (the reference photo's clean, solid-reading
      // front) rather than the radiator's metal fins behind. Sits right
      // behind the slats' own inner face, at boxBackingInnerZ (computed
      // once, above, and shared with the valve-budget ceiling so the two
      // can never drift apart). The real clearance from the BODY's front
      // face is guaranteed upstream, by bodyEnvelope()'s COVER_CLEARANCE_CM
      // clamp — that clamp accounts for the slat/backing material thickness
      // too (see its own comment), so by the time `body.depth` reaches here
      // it is already small enough that this fixed "just behind the slats"
      // position always lands a real margin ahead of the body.
      const backingThick = backingThickM;
      const backingZ = boxBackingInnerZ + backingThick / 2;
      const backingMat = finishMaterial(THREE, 'matte', enclosureColorHex);
      const backing = new THREE.Mesh(new THREE.BoxGeometry(ENV_W - panelThick * 2, shelfY, backingThick), backingMat);
      backing.position.set(0, shelfY / 2, backingZ);
      add(backing, 'coverBacking', 'matte', backingMat);

      // front face: vertical slats spanning the enclosure height, leaving a
      // small gap between each for airflow (a real slatted radiator cover)
      // — the backing panel just behind them means those gaps show solid
      // MDF, never the fins.
      const slatCount = Math.max(6, Math.round(o.width / 6));
      const slatGap = 0.006;
      const usableW = ENV_W - panelThick * 2;
      const slatW = Math.max(0.01, (usableW - slatGap * (slatCount - 1)) / slatCount);
      for (let i = 0; i < slatCount; i++) {
        const sx2 = -usableW / 2 + slatW / 2 + i * (slatW + slatGap);
        const slatMat = finishMaterial(THREE, 'matte', enclosureColorHex);
        const slat = new THREE.Mesh(new THREE.BoxGeometry(slatW, shelfY, panelThick), slatMat);
        slat.position.set(sx2, shelfY / 2, ENV_D - panelThick / 2);
        add(slat, `coverSlat_${i}`, 'matte', slatMat);
      }
    }
  }

  return group;
}

// Named alias, per the shared contract ("`buildRadiator` (etc.) is fine as
// well").
export const buildRadiator = build;
