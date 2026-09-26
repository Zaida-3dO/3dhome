/**
 * src/furniture/radiator.js — one design for every house radiator: a modern
 * white panel radiator (horizontal convector fins, wall brackets bridging
 * the wall gap, pipe tails to the floor) with a smart TRV valve head on one
 * corner and a lockshield valve diagonally opposite it, plus an optional
 * cover (a plain shelf, or a full slatted enclosure).
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it — see
 * src/furniture/box.js for the minimal example once PR "furniture data
 * layer" lands; this module is written to the same shape so it needs no
 * rework when that PR's shared finishes.js arrives):
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
 * `DEFAULTS.depth` is the TOTAL envelope depth — wall face (z=0) to the
 * outermost front face (z=depth) — INCLUDING any cover. `thickness` (the
 * radiator body's own depth) is a separate param; the wall-to-body-back air
 * gap `wallGap` is always DERIVED as `depth - thickness` and is never an
 * authored field in its own right:
 *   wallGap = depth - thickness
 * With no cover, depth is exactly the wall-to-front distance (thickness +
 * wallGap, e.g. 10 + 2 = 12). With a cover, `depth` is the OUTER envelope of
 * the cover (which must be >= thickness + wallGap), and the bracket still
 * spans 0..wallGap, the body wallGap..wallGap+thickness, with the cover's
 * own geometry filling the rest of the envelope out to z=depth.
 *
 * COVER — `params.cover`: 'none' | 'shelf' | 'box'.
 *   'shelf'  a wooden shelf sitting on top of the radiator, spanning exactly
 *            `width`, deep enough to cover the body plus the wall gap (i.e.
 *            depth), about 2cm thick, with a short downward fascia lip at
 *            the front edge. NOT a full enclosure — the sides stay open.
 *   'box'    a full slatted radiator cover: the same top shelf, plus front
 *            and side panels enclosing the radiator, with vertical slats on
 *            the front face. White by default (params.coverColor).
 * When a cover is present, DEFAULTS/params width, height and depth describe
 * the OUTER ENVELOPE including the cover — the bbox-matches-params rule
 * holds either way.
 *
 * ── DIMENSIONS ARE ILLUSTRATIVE, EXCEPT DEFAULTS ────────────────────────
 * DEFAULTS below are the standard house radiator: 80w x 60h, thickness 10,
 * depth 12 (a 2cm wall gap), elevation 17 (applied by the placer, so the
 * top sits at 77cm), no cover. Other rooms vary (remodel.sh3d: living room
 * 95cm, hallway 80cm typically behind a full slatted cover, bedroom 95cm)
 * — pass those as `params`, never by editing DEFAULTS.
 * ─────────────────────────────────────────────────────────────────────
 */

export const TYPE = 'radiator';

export const VALVE_CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];
export const COVERS = ['none', 'shelf', 'box'];

export const DEFAULTS = Object.freeze({
  width: 80,        // cm, along the wall
  height: 60,       // cm, outer envelope (includes any cover)
  depth: 12,        // cm, outer envelope, wall face to outermost front face
  thickness: 10,    // cm, the radiator BODY's own depth (wallGap is derived: depth - thickness)
  elevation: 17,    // cm, floor to the item's bottom edge (applied by the placer)
  valveCorner: 'bottom-right',
  color: '#f2f2ef',
  cover: 'none',
  coverColor: '#c8a878', // light oak, used for 'shelf'; 'box' defaults to white below
});

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
 * on width, y=0 at the item's own bottom (the PLACER applies `elevation`),
 * z=0 at the back (wall) face, z=depth at the outermost front face
 * (radiator body, or cover, whichever is present).
 *
 * @param {object} THREE     the three.js namespace (module or UMD/global build)
 * @param {object} [params]
 * @param {number} [params.width]        cm, along the wall (outer envelope)
 * @param {number} [params.height]       cm, outer envelope (includes any cover)
 * @param {number} [params.depth]        cm, outer envelope, wall to outermost front face
 * @param {number} [params.thickness]    cm, the radiator body's own depth
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
  const corner = VALVE_CORNERS.includes(o.valveCorner) ? o.valveCorner : DEFAULTS.valveCorner;
  const cover = COVERS.includes(o.cover) ? o.cover : DEFAULTS.cover;

  const ENV_W = o.width * CM, ENV_H = o.height * CM, ENV_D = o.depth * CM;
  const T = o.thickness * CM;
  const GAP = Math.max(0, wallGapOf(o.depth, o.thickness)) * CM;

  // The radiator body itself always sits at the BOTTOM of the envelope
  // (a cover, if any, sits above it) and spans the FULL requested width —
  // only its own height is capped so a shelf/box has somewhere to sit. With
  // no cover the body height IS the envelope height. The reserved space
  // above the body must equal EXACTLY what the cover geometry below
  // occupies (shelfT for 'shelf'; shelfT for 'box' too, since the box's
  // side/slat panels run body-height, same as the shelf case) so the
  // envelope height comes out exact to the bbox-matches-params rule.
  const SHELF_T_CM = 2; // 2cm shelf thickness, cm (kept in sync with shelfT below)
  const coverReserveCm = cover === 'none' ? 0 : SHELF_T_CM;
  const bodyHeightCm = cover === 'none' ? o.height : Math.max(20, o.height - coverReserveCm);
  const H = bodyHeightCm * CM;

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

  // ---- main panel: back face at z=GAP, bottom edge at y=0. Front face
  // convector fins scored in as a ribbed strip pattern via repeated thin
  // boxes — fewer fins at 'low' detail.
  const panel = new THREE.Mesh(new THREE.BoxGeometry(ENV_W, H, T), panelMat);
  panel.position.set(0, H / 2, GAP + T / 2);
  add(panel, 'radiatorPanel', 'gloss', panelMat);

  const finCount = detail === 'low'
    ? Math.max(2, Math.round(H / (8 * CM)))
    : Math.max(4, Math.round(H / (4 * CM)));
  const finH = (H * 0.82) / finCount;
  const finGap = (H * 0.82 - finH * finCount) / Math.max(1, finCount - 1);
  const finTop = H * 0.91;
  // The fins sit PROUD of the panel's own front face by a small amount, but
  // must never claim more depth than the envelope actually has left beyond
  // the panel (a tight wallGap/depth combination can leave zero room) — so
  // their protrusion is capped by whatever room remains to z=depth.
  const finRoomLeft = Math.max(0, ENV_D - (GAP + T));
  const finProtrusion = Math.min(0.006, finRoomLeft);
  const finFrontZ = GAP + T + finProtrusion / 2;
  for (let i = 0; i < finCount; i++) {
    const fy = finTop - i * (finH + finGap) - finH / 2;
    const finMat = finishMaterial(THREE, 'metal', 0xb9bdc2);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(ENV_W * 0.94, Math.max(0.004, finH * 0.6), Math.max(0.0005, finProtrusion)), finMat);
    fin.position.set(0, fy, finFrontZ);
    add(fin, `radiatorFin_${i}`, 'metal', finMat);
  }

  // ---- wall brackets: two, set roughly a fifth of the width from each end,
  // BRIDGING the gap exactly — from the wall face (z=0) to the body's back
  // (z=GAP).
  const bracketInset = Math.min(ENV_W * 0.22, 0.18);
  const bracketW = 0.03, bracketH = H * 0.5;
  const bracketD = Math.max(GAP, 0.004);
  for (const sx of [-1, 1]) {
    const bx = sx * (ENV_W / 2 - bracketInset);
    const brMat = finishMaterial(THREE, 'metal', 0x3a3a3e);
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(bracketW, bracketH, bracketD), brMat);
    bracket.position.set(bx, H / 2, bracketD / 2);
    add(bracket, `radiatorBracket_${sx < 0 ? 'L' : 'R'}`, 'metal', brMat);
  }

  // ---- valves: the smart TRV head on `corner`, the lockshield on the
  // opposite corner. Dropped entirely at 'low' detail.
  if (detail === 'full') {
    const valveInsetCm = Math.min(o.width, bodyHeightCm) * 0.1 + 4;
    const segs = 12;
    function buildValve(atCorner, isSmart) {
      const p = cornerPoint(atCorner, o.width, bodyHeightCm, valveInsetCm);
      const g = new THREE.Group();
      g.name = isSmart ? 'radiatorValveSmart' : 'radiatorValveLockshield';

      const frontZ = GAP + T;
      // The valve stem + body + tail-radius + LED epsilon must ALL stay
      // INSIDE the envelope (never push the bbox past z=depth): the whole
      // assembly's outer-face budget is capped by whatever room remains
      // between the panel's front face and the envelope's outer face (the
      // cover, if any, or the wall-to-front distance) — never more, even
      // when that room is zero (a tight wall gap flush-mounts the valve).
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

  // ---- cover: 'shelf' or 'box', sitting in the envelope ABOVE the body
  // (bodyHeightCm..envelope height) and spanning the full envelope depth
  // (0..depth) and width.
  if (cover !== 'none') {
    const shelfColorHex = new THREE.Color(o.coverColor || DEFAULTS.coverColor).getHex();
    const shelfMat = finishMaterial(THREE, 'matte', shelfColorHex);
    const shelfT = 0.02; // 2cm shelf thickness
    const shelfY = H; // shelf sits directly on top of the body's own height
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
      // Full enclosure: front + two side panels, white by default, with
      // vertical slats on the front. The panels run from the body's own
      // bottom (y=0) up to the underside of the shelf.
      const boxColorHex = new THREE.Color(o.color === DEFAULTS.color ? '#ffffff' : o.color).getHex();
      // If the caller passed an explicit colour it wins for the body; the
      // enclosure defaults to white regardless, per the reference photos,
      // unless coverColor was explicitly set away from the shelf default.
      const enclosureColorHex = (o.coverColor && o.coverColor !== DEFAULTS.coverColor)
        ? new THREE.Color(o.coverColor).getHex() : 0xffffff;
      const panelThick = 0.012;

      // side panels: full depth, full body height, at each end of the width
      for (const sx of [-1, 1]) {
        const sideMat = finishMaterial(THREE, 'matte', enclosureColorHex);
        const side = new THREE.Mesh(new THREE.BoxGeometry(panelThick, shelfY, ENV_D), sideMat);
        side.position.set(sx * (ENV_W / 2 - panelThick / 2), shelfY / 2, ENV_D / 2);
        add(side, `coverSide_${sx < 0 ? 'L' : 'R'}`, 'matte', sideMat);
      }

      // front face: vertical slats spanning the body height, leaving a
      // small gap between each for airflow (a real slatted radiator cover).
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
