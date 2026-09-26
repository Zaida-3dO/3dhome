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
 * `width`/`height`/`depth`/`thickness` ALWAYS describe the RADIATOR BODY
 * itself, independent of any cover: `depth` is the body's wall-to-front
 * distance (thickness + the derived wallGap), never the cover's. The
 * wall-to-body-back air gap `wallGap` is always DERIVED, never authored:
 *   wallGap = depth - thickness
 *
 * COVER — `params.cover`: 'none' | 'shelf' | 'box'. When present, it can be
 * LARGER than the radiator body (a real hallway cover: a 50x60 radiator
 * inside a 75w x 92h box projecting 19cm) via three independent, OPTIONAL
 * envelope params:
 *   coverWidth   cm, default = width  (the cover is at least as wide as the body)
 *   coverHeight  cm, default = height + shelf thickness (room for the shelf)
 *   coverDepth   cm, default = depth  (the cover is at least as deep as the body)
 * WHEN A COVER IS PRESENT, THE BUILT GROUP'S BBOX IS THE COVER'S ENVELOPE
 * (coverWidth/coverHeight/coverDepth), not the radiator body's — the
 * bbox-matches-params rule is checked against whichever of the two is
 * actually the outer surface. The radiator body sits inside the cover,
 * centred on width and flush with the wall (z=0), exactly as it would with
 * no cover.
 *   'shelf'  a wooden shelf sitting on top of the radiator, spanning the
 *            cover's width and depth, about 2cm thick, with a short downward
 *            fascia lip at the front edge. NOT a full enclosure — the sides
 *            stay open, so the radiator body is visible from the front/sides
 *            below the shelf.
 *   'box'    a full slatted radiator cover: the same top shelf, plus front
 *            and side panels FULLY ENCLOSING the radiator (spanning the
 *            cover's own width/height/depth, not the body's), with vertical
 *            slats on the front face backed by a solid panel — see FIX
 *            444c3a1e below — so nothing of the radiator body is visible
 *            through the gaps between slats. White by default
 *            (params.coverColor).
 *
 * FIX 444c3a1e (fins showing through the slatted box cover): a real slatted
 * cover reads as solid from the front — the reference photo
 * (hallway-radiator-cover-mirror.jpg) shows clean white verticals with dark
 * gaps between them, never a hint of the metal fins behind. The earlier
 * version modelled only the slats, so the fins (and their contrasting metal
 * colour) were visible through the airflow gaps whenever a slat's depth
 * placement left them exposed. Fixed by putting a solid backing panel
 * (`coverBacking`, same colour as the slats) directly behind the slat layer
 * — the gaps between slats now show painted MDF, not radiator fins, exactly
 * as a real cover does. The radiator body is unchanged (still fully modelled
 * behind the cover, for a future "remove the cover" toggle), just no longer
 * visible from outside a 'box' cover.
 *
 * ── DIMENSIONS ARE ILLUSTRATIVE, EXCEPT DEFAULTS ────────────────────────
 * DEFAULTS below are the standard house radiator: 80w x 60h, thickness 10,
 * depth 12 (a 2cm wall gap), elevation 17 (applied by the placer, so the
 * top sits at 77cm), no cover. Other rooms vary (remodel.sh3d: living room
 * 95cm, hallway typically a smaller radiator inside a larger slatted cover,
 * bedroom 95cm) — pass those as `params`, never by editing DEFAULTS.
 * ─────────────────────────────────────────────────────────────────────
 */

export const TYPE = 'radiator';

export const VALVE_CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];
export const COVERS = ['none', 'shelf', 'box'];
const SHELF_T_CM = 2; // 2cm shelf thickness — the default coverHeight margin

export const DEFAULTS = Object.freeze({
  width: 80,        // cm, the radiator BODY's own width, along the wall
  height: 60,       // cm, the radiator BODY's own height
  depth: 12,        // cm, the radiator BODY's own wall-to-front distance (thickness + derived wallGap)
  thickness: 10,    // cm, the radiator BODY's own depth (wallGap is derived: depth - thickness)
  elevation: 17,    // cm, floor to the item's bottom edge (applied by the placer)
  valveCorner: 'bottom-right',
  color: '#f2f2ef',
  cover: 'none',
  coverColor: '#c8a878', // light oak, used for 'shelf'; 'box' defaults to white below
  // coverWidth/coverHeight/coverDepth are intentionally ABSENT from DEFAULTS
  // (there is no sensible universal default independent of width/height/
  // depth — see coverEnvelope() below, which derives them from whichever of
  // width/height/depth the caller passed when these are left unset).
});

/**
 * The cover's own outer envelope, in cm. Each of coverWidth/coverHeight/
 * coverDepth is independently optional: unset, it defaults to a snug fit
 * around the radiator body (coverWidth->width, coverDepth->depth,
 * coverHeight->height + the shelf thickness so the shelf has room to sit
 * on top). A cover is never smaller than the body it encloses — an
 * undersized cover value is clamped up to the body's own size, since a
 * cover that clips through its own radiator is not a valid design.
 */
export function coverEnvelope(o) {
  const w = Math.max(o.width, o.coverWidth != null ? o.coverWidth : o.width);
  const h = Math.max(o.height + SHELF_T_CM, o.coverHeight != null ? o.coverHeight : o.height + SHELF_T_CM);
  const d = Math.max(o.depth, o.coverDepth != null ? o.coverDepth : o.depth);
  return { width: w, height: h, depth: d };
}

/**
 * Four generic, publishable presets (no owner-specific naming — this repo is
 * public). Each is a partial params object layered onto DEFAULTS; width is a
 * param in every case, per room.
 */
export const PRESETS = Object.freeze([
  { name: '80 wide, no cover, valve bottom-right', params: Object.freeze({ width: 80, cover: 'none', valveCorner: 'bottom-right' }) },
  { name: '120 wide, shelf top, valve bottom-left', params: Object.freeze({ width: 120, cover: 'shelf', valveCorner: 'bottom-left' }) },
  { name: '95 wide, shelf top', params: Object.freeze({ width: 95, cover: 'shelf' }) },
  { name: '80 wide, full slatted cover', params: Object.freeze({ width: 80, cover: 'box' }) },
  { name: '50 wide in 75x92 slatted cover', params: Object.freeze({
    width: 50, height: 60, depth: 12, thickness: 10, cover: 'box',
    coverWidth: 75, coverHeight: 92, coverDepth: 19,
  }) },
]);

const CM = 0.01;

/** wallGap, derived from depth and thickness. Never pass this in as an
 * authored field — depth and thickness are the source of truth. */
export function wallGapOf(depthCm, thicknessCm) {
  return depthCm - thicknessCm;
}

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
export function cornerPoint(corner, widthCm, bodyHeightCm, insetCm = 8) {
  const hw = widthCm / 2;
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
 * on the OUTER envelope's width (the cover's, if present; else the body's),
 * y=0 at the item's own bottom (the PLACER applies `elevation`), z=0 at the
 * back (wall) face, z=(outer envelope depth) at the outermost front face.
 *
 * @param {object} THREE     the three.js namespace (module or UMD/global build)
 * @param {object} [params]
 * @param {number} [params.width]        cm, the RADIATOR BODY's own width
 * @param {number} [params.height]       cm, the RADIATOR BODY's own height
 * @param {number} [params.depth]        cm, the RADIATOR BODY's own wall-to-front distance
 * @param {number} [params.thickness]    cm, the radiator body's own depth
 * @param {string} [params.valveCorner]  one of VALVE_CORNERS
 * @param {string} [params.color]        radiator body colour
 * @param {'none'|'shelf'|'box'} [params.cover]
 * @param {string} [params.coverColor]   cover wood/paint colour
 * @param {number} [params.coverWidth]   cm, the COVER's own width (default: width)
 * @param {number} [params.coverHeight]  cm, the COVER's own height (default: height + shelf thickness)
 * @param {number} [params.coverDepth]   cm, the COVER's own wall-to-front distance (default: depth)
 * @param {object} [opts]
 * @param {'full'|'low'} [opts.detail]   'low' drops the valve assemblies
 *                                       and reduces curve segments (default 'full')
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const o = Object.assign({}, DEFAULTS, params || {});
  const detail = (opts && opts.detail === 'low') ? 'low' : 'full';
  const corner = VALVE_CORNERS.includes(o.valveCorner) ? o.valveCorner : DEFAULTS.valveCorner;
  const cover = COVERS.includes(o.cover) ? o.cover : DEFAULTS.cover;

  // The radiator BODY's own dimensions — always width/height/depth/
  // thickness, independent of any cover.
  const BODY_W = o.width * CM, H = o.height * CM;
  const T = o.thickness * CM;
  const GAP = Math.max(0, wallGapOf(o.depth, o.thickness)) * CM;
  const BODY_D = o.depth * CM;

  // The OUTER envelope: the cover's own size when a cover is present (never
  // smaller than the body — see coverEnvelope()), else exactly the body's.
  const envelope = cover === 'none'
    ? { width: o.width, height: o.height, depth: o.depth }
    : coverEnvelope(o);
  const ENV_W = envelope.width * CM, ENV_H = envelope.height * CM, ENV_D = envelope.depth * CM;

  // The body sits centred in the (possibly wider) envelope and flush with
  // the wall (its own z=0..depth is unaffected by the cover being deeper).
  const bodyOffsetX = 0; // both body and envelope are centred on x=0

  const group = new THREE.Group();
  group.name = 'radiator';

  const panelMat = finishMaterial(THREE, 'gloss', new THREE.Color(o.color).getHex());
  panelMat.userData.finish = 'gloss';
  const metalMat = finishMaterial(THREE, 'metal', 0xb9bdc2);
  metalMat.userData.finish = 'metal';
  const bracketMat = finishMaterial(THREE, 'metal', 0x3a3a3e);
  bracketMat.userData.finish = 'metal';

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
  // body's own width/height (independent of a wider/taller cover). Front
  // face convector fins scored in as a ribbed strip pattern via repeated
  // thin boxes — fewer fins at 'low' detail.
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
  // beyond the panel (a tight wallGap/depth combination, or a shallow
  // cover, can leave zero room) — so their protrusion is capped by whatever
  // room remains to z=(envelope depth). This is what keeps the fins from
  // poking through a cover as well as from overflowing a bare radiator's
  // own declared depth.
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
  // the body's back (z=GAP).
  const bracketInset = Math.min(BODY_W * 0.22, 0.18);
  const bracketW = 0.03, bracketH = H * 0.5;
  const bracketD = Math.max(GAP, 0.004);
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
    const valveInsetCm = Math.min(o.width, o.height) * 0.1 + 4;
    const segs = 12;
    function buildValve(atCorner, isSmart) {
      const p = cornerPoint(atCorner, o.width, o.height, valveInsetCm);
      const g = new THREE.Group();
      g.name = isSmart ? 'radiatorValveSmart' : 'radiatorValveLockshield';

      const frontZ = GAP + T;
      // The valve stem + body + tail-radius + LED epsilon must ALL stay
      // INSIDE the OUTER ENVELOPE (never push the bbox past z=(envelope
      // depth), and never poke through a shallower cover than the body's
      // own depth): the whole assembly's outer-face budget is capped by
      // whatever room remains between the panel's front face and the
      // envelope's outer face — never more, even when that room is zero (a
      // tight wall gap, or a snug cover, flush-mounts the valve).
      const roomLeft = Math.max(0, ENV_D - frontZ);
      // The ENTIRE valve assembly's outermost point — including the tail's
      // own radius (it hangs vertically, so its radius sticks out in Z) and
      // the LED's tiny standoff — must land at or before z=ENV_D (=depth).
      // Everything below is sized as a FRACTION of `budget`, so nothing can
      // ever overflow it: with zero room the whole assembly (stem, body,
      // tail radius, LED) collapses toward zero rather than pushing past
      // the envelope.
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
      const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyRadius, bodyRadius, bodyLen, segs + 4), bodyMat);
      body.name = 'body';
      body.userData.finish = bodyFinish;
      bodyMat.userData.finish = bodyFinish;
      body.rotation.x = Math.PI / 2;
      body.position.set(p.x, p.y, frontZ + stemLen + bodyLen / 2);
      g.add(body);

      // The pipe tail's Z position is where its FACE sits (it hangs
      // vertically, so its own radius sticks out in Z on both sides) — this
      // lands tailRadius short of frontZ+budget, which is exactly what the
      // reserve above was budgeted for, so tailZ+tailRadius <= ENV_D always.
      const tailTopY = p.y;
      const tailZ = Math.min(frontZ + stemLen + bodyLen, ENV_D - tailRadius - ledEpsilon);
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
        // what silently blew the envelope budget before this fix).
        led.position.set(p.x, p.y, Math.min(tailZ + ledEpsilon, ENV_D));
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

    // A short downward fascia lip at the shelf's front edge, a few cm tall.
    const lipH = 0.04;
    const lipMat = finishMaterial(THREE, 'matte', shelfColorHex);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(ENV_W, lipH, 0.015), lipMat);
    lip.position.set(0, shelfY - lipH / 2, ENV_D - 0.0075);
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
      const panelThick = 0.012;

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
      // front) rather than the radiator's metal fins behind. Sits just in
      // front of the radiator body (so it never touches/z-fights the fins)
      // and just behind the slats.
      const backingThick = 0.008;
      const backingZ = ENV_D - panelThick - backingThick / 2;
      const backingMat = finishMaterial(THREE, 'matte', enclosureColorHex);
      const backing = new THREE.Mesh(new THREE.BoxGeometry(ENV_W - panelThick * 2, shelfY, backingThick), backingMat);
      backing.position.set(0, shelfY / 2, backingZ);
      add(backing, 'coverBacking', 'matte', backingMat);

      // front face: vertical slats spanning the enclosure height, leaving a
      // small gap between each for airflow (a real slatted radiator cover)
      // — the backing panel just behind them means those gaps show solid
      // MDF, never the fins.
      const slatCount = Math.max(6, Math.round(envelope.width / 6));
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
