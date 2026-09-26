/**
 * wall-fittings.js - windows, balcony glazing and curtains (sheers included).
 *
 * The models are ported from the spec pages (specs/WindowSpec.html,
 * specs/BalconyWindowSpec.html, specs/CurtainSpec.html), which build each
 * fitting in isolation around its own reference wall. Here the reference wall
 * is dropped -- the house's real wall is carved instead (see the wall loop in
 * home3d-scene.js) -- and each assembly is placed on that wall.
 *
 * LOCAL FRAME, shared by every builder below (the same one the spec pages use):
 *   x  along the wall
 *   y  up, 0 = the floor's walking surface
 *   z  across the wall, +z = INTO THE ROOM
 * placeOnWall() turns that frame into a world transform for a compiled
 * window/curtain (house-loader compileWindow / compileCurtain).
 *
 * THREE is passed in rather than imported so this module has no import-map
 * dependency and can be loaded by a plain Node test.
 */

// The frame's reveal each side of the glazing, and the depth of the frame's
// bottom member. The wall is carved to glazing + this on every side.
export const WINDOW_REVEAL_CM = 4;

const CM = 0.01;

/**
 * Vertical extents of a window, in METRES.
 *   openBot/openTop  the glazing
 *   holeBot/holeTop  the hole carved in the wall (glazing + reveal)
 * A sill under the reveal depth is raised to it, so the frame's bottom member
 * never has to sink into the floor slab.
 */
export function windowVerticals(win) {
  const sillCm = Math.max(win.sill, WINDOW_REVEAL_CM);
  const openBot = sillCm * CM;
  const openTop = (win.sill + win.h) * CM;
  return {
    openBot: openBot,
    openTop: Math.max(openTop, openBot + 0.05),
    holeBot: openBot - WINDOW_REVEAL_CM * CM,
    holeTop: Math.max(openTop, openBot + 0.05) + WINDOW_REVEAL_CM * CM
  };
}

/**
 * +1 when the fitting's local +x runs along the wall's plan axis in the
 * POSITIVE direction (east for an east-west wall, south for a north-south
 * one), -1 when it runs the other way. Follows from the rotation in
 * placeOnWall: local +z must face into the room.
 */
export function localXSign(item) {
  if (item.axis === 'x') return item.inDir > 0 ? 1 : -1;
  return item.inDir > 0 ? -1 : 1;
}

/** Position + rotate `group` so its local frame sits on `planFace` of the wall. */
export function placeOnWall(group, item, planFace, tx, tz) {
  if (item.axis === 'x') {
    group.position.set(tx(item.c), 0, tz(planFace));
    group.rotation.y = item.inDir > 0 ? 0 : Math.PI;
  } else {
    group.position.set(tx(planFace), 0, tz(item.c));
    group.rotation.y = item.inDir > 0 ? Math.PI / 2 : -Math.PI / 2;
  }
}

function lighten(THREE, hex, amt) {
  return new THREE.Color(hex).lerp(new THREE.Color(0xffffff), amt);
}

/**
 * Build one window or balcony glazing run. Returns { group, fadeMeshes }:
 * `fadeMeshes` are the opaque parts that should fade with an exterior host
 * wall (glass is already translucent and is left out of the fade).
 *
 * @param {boolean} fadeable  host wall is exterior: give opaque parts
 *                            transparent-capable materials for the fade loop.
 */
export function buildWindow(THREE, win, fadeable) {
  const v = windowVerticals(win);
  const isBalcony = win.kind === 'balcony';
  const WW = win.w * CM;
  const OPEN_BOT = v.openBot, OPEN_TOP = v.openTop;
  const GLAZ_H = OPEN_TOP - OPEN_BOT;
  const FT = (isBalcony ? 7 : 6) * CM;
  const HOST = win.hostThickness * CM;
  const FD = Math.min(14 * CM, HOST);
  const GI = 2 * CM;
  const REVEAL = WINDOW_REVEAL_CM * CM;
  const BEYOND = (win.beyond || 0) * CM;   // extra sandwich depth outside the host
  const frameSouthZ = 0;                   // host wall's OUTER face
  const frameMidZ = FD / 2;
  const SASH_FACE = Math.max(FT * 0.8, 3 * CM);

  const opaque = (params) => new THREE.MeshStandardMaterial(Object.assign(
    { transparent: !!fadeable, opacity: 1 }, params));
  const frameMat = opaque({ color: win.frameColor, roughness: 0.5 });
  const sashMat = opaque({ color: lighten(THREE, win.frameColor, 0.3), roughness: 0.55 });
  const cillMat = opaque({ color: win.frameColor, roughness: 0.65 });
  const handleMat = opaque({ color: 0xeef0f2, roughness: 0.18, metalness: 0.95 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xbcd8e6, roughness: 0.05, metalness: 0.0,
    transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false
  });

  const group = new THREE.Group();
  group.name = 'window:' + win.id;
  const fadeMeshes = [];
  const add = (parent, mesh, fades) => {
    mesh.castShadow = fades !== false;
    mesh.receiveShadow = true;
    parent.add(mesh);
    if (fades !== false) fadeMeshes.push(mesh);
    return mesh;
  };

  // ---- outer frame: a rectangle-with-hole ring filling the carved reveal ----
  const oHalfW = WW / 2 + REVEAL;
  const frameShape = new THREE.Shape();
  frameShape.moveTo(-oHalfW, v.holeBot);
  frameShape.lineTo(+oHalfW, v.holeBot);
  frameShape.lineTo(+oHalfW, v.holeTop);
  frameShape.lineTo(-oHalfW, v.holeTop);
  frameShape.lineTo(-oHalfW, v.holeBot);
  const hole = new THREE.Path();
  hole.moveTo(-WW / 2, OPEN_BOT);
  hole.lineTo(+WW / 2, OPEN_BOT);
  hole.lineTo(+WW / 2, OPEN_TOP);
  hole.lineTo(-WW / 2, OPEN_TOP);
  hole.lineTo(-WW / 2, OPEN_BOT);
  frameShape.holes.push(hole);
  const frameGeo = new THREE.ExtrudeGeometry(frameShape, { depth: FD, bevelEnabled: false, curveSegments: 1 });
  frameGeo.translate(0, 0, frameSouthZ);
  add(group, new THREE.Mesh(frameGeo, frameMat)).name = 'windowFrame';

  // ---- cill: spans the WHOLE wall depth (every leaf), outer face to room face.
  // Its top sits a hair under the glazing line so it never shares a plane with
  // the frame's bottom member (which covers it across the frame depth).
  const cillH = Math.max(0.005, OPEN_BOT - v.holeBot - 0.002);
  const cillD = HOST + BEYOND;
  const cill = new THREE.Mesh(new THREE.BoxGeometry(WW + 2 * REVEAL, cillH, cillD), cillMat);
  cill.position.set(0, v.holeBot + cillH / 2, (HOST - BEYOND) / 2);
  add(group, cill).name = 'windowCill';

  if (!isBalcony) {
    // ===== WindowSpec: fixed lower pane + centre-pivot upper sash =====
    const split = Math.max(0.2, Math.min(0.8, win.topSplit));
    const TOP_H = GLAZ_H * split;
    const BOT_H = GLAZ_H - TOP_H;
    const DIV_Y = OPEN_BOT + BOT_H;

    const transom = new THREE.Mesh(new THREE.BoxGeometry(WW, FT, FD * 0.9), frameMat);
    transom.position.set(0, DIV_Y, frameMidZ);
    add(group, transom).name = 'windowTransom';

    const botCY = OPEN_BOT + BOT_H / 2;
    const botInnerH = Math.max(0.01, BOT_H - SASH_FACE);
    const bar = (parent, w, h, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, FD * 0.5), sashMat);
      m.position.set(x, y, z);
      return add(parent, m);
    };
    bar(group, WW, SASH_FACE, 0, OPEN_BOT + SASH_FACE / 2, frameMidZ);
    bar(group, SASH_FACE, botInnerH, -WW / 2 + SASH_FACE / 2, botCY, frameMidZ);
    bar(group, SASH_FACE, botInnerH, +WW / 2 - SASH_FACE / 2, botCY, frameMidZ);
    const fixedGlass = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(0.01, WW - 2 * SASH_FACE), Math.max(0.01, BOT_H - 1.5 * SASH_FACE)), glassMat);
    fixedGlass.position.set(0, botCY, frameMidZ + GI * 0.5);
    add(group, fixedGlass, false).name = 'windowFixedGlass';

    // Top sash, built round its own centre inside a pivot group at 3/4 height
    // (closed pose: no rotation). Kept as a pivot so an open pose is a one-line
    // rotation later.
    const pivotFrac = 0.75;
    const pivot = new THREE.Group();
    pivot.name = 'windowSashPivot';
    pivot.position.set(0, DIV_Y + pivotFrac * TOP_H, frameMidZ);
    group.add(pivot);
    const sash = new THREE.Group();
    sash.position.set(0, (DIV_Y + TOP_H / 2) - (DIV_Y + pivotFrac * TOP_H), 0);
    pivot.add(sash);
    bar(sash, WW, SASH_FACE, 0, +TOP_H / 2 - SASH_FACE / 2, 0);
    bar(sash, WW, SASH_FACE, 0, -TOP_H / 2 + SASH_FACE / 2, 0);
    bar(sash, SASH_FACE, TOP_H - 2 * SASH_FACE, -WW / 2 + SASH_FACE / 2, 0, 0);
    bar(sash, SASH_FACE, TOP_H - 2 * SASH_FACE, +WW / 2 - SASH_FACE / 2, 0, 0);
    const sashGlass = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(0.01, WW - 2 * SASH_FACE), Math.max(0.01, TOP_H - 2 * SASH_FACE)), glassMat);
    add(sash, sashGlass, false).name = 'windowSashGlass';
    const handle = new THREE.Mesh(new THREE.BoxGeometry(10 * CM, 1.6 * CM, 1.6 * CM), handleMat);
    handle.position.set(0, -TOP_H / 2 + SASH_FACE * 1.2, FD * 0.25 + 1 * CM);
    add(sash, handle).name = 'windowHandle';
    return { group, fadeMeshes };
  }

  // ===== BalconyWindowSpec: fixed pane + outward-swinging hinged door =====
  const frac = Math.max(0.15, Math.min(0.4, win.doorFraction));
  const DOOR_W = WW * frac;
  // Which local end the door is at: the compiled `doorEnd` is a compass end of
  // the wall; compare it with the direction local +x runs.
  const endSign = (win.doorEnd === 'east' || win.doorEnd === 'south') ? 1 : -1;
  const doorAtNeg = localXSign(win) * endSign < 0;
  const splitX = doorAtNeg ? (-WW / 2 + DOOR_W) : (+WW / 2 - DOOR_W);
  const MULLION_W = Math.max(FT, 4 * CM);
  const mullion = new THREE.Mesh(new THREE.BoxGeometry(MULLION_W, GLAZ_H, FD * 0.9), frameMat);
  mullion.position.set(splitX, OPEN_BOT + GLAZ_H / 2, frameMidZ);
  add(group, mullion).name = 'balconyMullion';

  // The fixed pane has no stiles: it runs from the mullion face to the frame's
  // inner edge, so no sliver opens between glass and jamb.
  const fixX1 = doorAtNeg ? splitX + MULLION_W / 2 : -WW / 2;
  const fixX2 = doorAtNeg ? WW / 2 : splitX - MULLION_W / 2;
  const fixW = Math.max(0.01, fixX2 - fixX1), fixCx = (fixX1 + fixX2) / 2;
  const rail = (parent, w, h, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, FD * 0.5), sashMat);
    m.position.set(x, y, z);
    return add(parent, m);
  };
  rail(group, fixW, SASH_FACE, fixCx, OPEN_BOT + SASH_FACE / 2, frameMidZ);
  rail(group, fixW, SASH_FACE, fixCx, OPEN_TOP - SASH_FACE / 2, frameMidZ);
  const fixedGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(fixW, Math.max(0.01, GLAZ_H - 2 * SASH_FACE)), glassMat);
  fixedGlass.position.set(fixCx, OPEN_BOT + GLAZ_H / 2, frameMidZ + GI * 0.5);
  add(group, fixedGlass, false).name = 'balconyFixedGlass';

  // Door leaf: hinged on the OUTER jamb, swinging OUTWARD (-z). Closed pose;
  // the pivot is kept so an open pose is a rotation of doorPivot about y
  // (positive when the door is at local -x, negative at +x).
  const doorX1 = doorAtNeg ? -WW / 2 : splitX + MULLION_W / 2;
  const doorX2 = doorAtNeg ? splitX - MULLION_W / 2 : WW / 2;
  const leafW = Math.max(0.01, doorX2 - doorX1);
  const hingeX = doorAtNeg ? doorX1 : doorX2;
  const leafDir = doorAtNeg ? 1 : -1;
  const doorPivot = new THREE.Group();
  doorPivot.name = 'balconyDoorPivot';
  doorPivot.position.set(hingeX, 0, frameMidZ);
  group.add(doorPivot);
  const leaf = new THREE.Group();
  leaf.position.set(leafDir * leafW / 2, 0, 0);
  doorPivot.add(leaf);
  const leafCY = OPEN_BOT + GLAZ_H / 2;
  rail(leaf, leafW, SASH_FACE, 0, OPEN_TOP - SASH_FACE / 2, 0);
  rail(leaf, leafW, SASH_FACE, 0, OPEN_BOT + SASH_FACE / 2, 0);
  rail(leaf, SASH_FACE, GLAZ_H - 2 * SASH_FACE, -leafW / 2 + SASH_FACE / 2, leafCY, 0);
  rail(leaf, SASH_FACE, GLAZ_H - 2 * SASH_FACE, +leafW / 2 - SASH_FACE / 2, leafCY, 0);
  const leafGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.max(0.01, leafW - 2 * SASH_FACE), Math.max(0.01, GLAZ_H - 2 * SASH_FACE)), glassMat);
  leafGlass.position.set(0, leafCY, GI * 0.5);
  add(leaf, leafGlass, false).name = 'balconyDoorGlass';

  // Keyed lever handle on the room face near the latch edge.
  const hg = new THREE.Group();
  const rosette = new THREE.Mesh(new THREE.CylinderGeometry(2.5 * CM, 2.5 * CM, 0.8 * CM, 24), handleMat);
  rosette.rotation.x = Math.PI / 2;
  rosette.position.set(0, 0, 0.4 * CM);
  add(hg, rosette);
  const lever = new THREE.Mesh(new THREE.BoxGeometry(13 * CM, 1.8 * CM, 1.8 * CM), handleMat);
  lever.position.set(-leafDir * (6.5 * CM - 1.1 * CM), 0, 3.3 * CM);
  add(hg, lever);
  const keyMat = opaque({ color: 0x1a1a1a, roughness: 0.5, metalness: 0.4 });
  const key = new THREE.Mesh(new THREE.CylinderGeometry(0.85 * CM, 0.85 * CM, 1.2 * CM, 16), keyMat);
  key.rotation.x = Math.PI / 2;
  key.position.set(0, 4.5 * CM, 0.6 * CM);
  add(hg, key);
  hg.position.set(leafDir * (leafW / 2 - SASH_FACE * 1.4), leafCY, FD * 0.25 + 1 * CM);
  leaf.add(hg);
  hg.name = 'balconyDoorHandle';
  return { group, fadeMeshes };
}

// ===== How far a curtain half spans =====
//
// ONE place for the gather, shared by the fabric (curtainFoldVertex) and the
// daylight coverage (curtainCoverIntervals) so what you see and what the
// window lets through can never disagree. specs/CurtainSpec.html mirrors it.
// Everything here is in CENTIMETRES.
//
// Closed, each half spans a touch over half the width (the halves overlap at
// the centre). Fully open, it bunches into a stack at its own wall end whose
// width is set by how much fabric is in it -- its pleat count -- not by how
// wide the curtain is. Precedence: the profile's absolute `stackWidth`, then
// its `stackPerPleat` x pleats, then STACK_PER_PLEAT_CM x pleats.
export const CURTAIN_CLOSED_OVERLAP = 1.03;
export const STACK_PER_PLEAT_CM = 4.7;

/** Pleats in one half, exactly as buildCurtain folds it (at least 2). */
export function curtainPleatsPerHalf(cur) {
  return Math.max(2, (cur.outerPleats | 0) + (cur.innerPleats | 0));
}

/**
 * The fully-open stack per side, cm, before the clamp. `cur` needs
 * outerPleats/innerPleats and may carry stackWidth / stackPerPleat (cm);
 * a missing or non-positive override falls through to the next rule.
 */
export function curtainStackWidth(cur) {
  if (cur.stackWidth != null && cur.stackWidth > 0) return +cur.stackWidth;
  const per = cur.stackPerPleat != null && cur.stackPerPleat > 0 ? +cur.stackPerPleat : STACK_PER_PLEAT_CM;
  return per * curtainPleatsPerHalf(cur);
}

/** The gathered stack, clamped so it is never wider than a closed half. */
export function curtainGatheredSpan(halfCm, cur) {
  return Math.min(curtainStackWidth(cur), halfCm * CURTAIN_CLOSED_OVERLAP);
}

/** Span of one half at openness openN (0 closed .. 1 open), cm. */
export function curtainHalfSpan(halfCm, cur, openN) {
  const closed = halfCm * CURTAIN_CLOSED_OVERLAP;
  return closed + (curtainGatheredSpan(halfCm, cur) - closed) * openN;
}

/**
 * CurtainSpec's fold placement, made static. u in [0,1] runs from the outer
 * (wall-end) edge to the centre part; v in [0,1] floor -> top. `maxAmp` caps
 * the fold depth so the lining never passes through the wall, nor through
 * another curtain hung behind this one (house-loader stackCurtains) -- the
 * spec page has no such neighbour to respect.
 */
export function curtainFoldVertex(u, v, side, isBack, openN, P) {
  const span = curtainHalfSpan(P.width / 2 / CM, P.stack, openN) * CM;
  const anchorX = side < 0 ? -P.width / 2 : +P.width / 2;
  const x = side < 0 ? anchorX + u * span : anchorX - u * span;
  const y = P.bottom + v * P.drop;
  const pv = v >= 0.80 ? (1 - (v - 0.80) / 0.20 * 0.88) : 1;
  const depthGrow = 0.35 + 0.65 * (1 - v);
  const gatherAmp = 1 + 1.3 * openN;
  const amp = Math.min(P.maxAmp, P.ampBase * pv * depthGrow * gatherAmp);
  let z = P.midZ + amp * Math.sin(u * P.pleats * 2 * Math.PI);
  if (isBack) z -= P.thickness;
  return [x, y, z];
}

/**
 * Build one curtain pair, with its cornice unless it has none. Returns
 * { group, fadeMeshes } like buildWindow. A sheer (opacity < 1) is a single
 * translucent layer with no lining, and its fabric is left out of fadeMeshes:
 * the fade loop drives opacity between 0.05 and 1, which would turn a sheer
 * opaque whenever its wall is not being looked through.
 */
export function buildCurtain(THREE, cur, fadeable) {
  const group = new THREE.Group();
  group.name = 'curtain:' + cur.id;
  const fadeMeshes = [];
  const add = (parent, mesh, fades) => {
    mesh.castShadow = fades !== false;
    mesh.receiveShadow = true;
    parent.add(mesh);
    if (fades !== false) fadeMeshes.push(mesh);
    return mesh;
  };
  const W = cur.w * CM;
  const TOP = cur.top * CM;
  const DROP = Math.min(cur.drop, cur.top) * CM;
  const openN = Math.max(0, Math.min(1, cur.openPct / 100));
  const sheer = !!cur.sheer;

  // ---- two fabric halves, each a front surface (+ a lining unless sheer) ----
  const cn = cur.cornice;
  const cDepth = (cn ? cn.depth : 18) * CM;
  const midZ = cur.offset * CM;
  const pleats = curtainPleatsPerHalf(cur);
  const outerPleats = Math.min(pleats, Math.max(0, cur.outerPleats | 0));
  const P = {
    // A heading that hangs in a cornice (its own, or -- a sheer -- another
    // curtain's: cur.underCornice, set by the loader) stops CURTAIN_HEAD_GAP
    // under `top`, below the lid, so its top edge never pokes up through it.
    // The hem stays where it was. A curtain with no cornice over it keeps
    // its full drop.
    width: W, drop: (cn || cur.underCornice) ? Math.max(0.01, DROP - CURTAIN_HEAD_GAP) : DROP,
    bottom: TOP - DROP, pleats,
    ampBase: 0.055, thickness: 0.02,
    // What decides the fully-open stack (curtainStackWidth; cm).
    stack: { stackWidth: cur.stackWidth, stackPerPleat: cur.stackPerPleat,
      outerPleats: cur.outerPleats, innerPleats: cur.innerPleats }, midZ,
    maxAmp: (cur.maxAmp != null ? cur.maxAmp : 5.5) * CM
  };
  const outer = new THREE.Color(cur.outerColor);
  const inner = new THREE.Color(cur.innerColor);
  const lining = new THREE.Color(cur.liningColor);
  const fabricMat = new THREE.MeshStandardMaterial(sheer ? {
    vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
    transparent: true, opacity: cur.opacity, depthWrite: false
  } : {
    vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
    transparent: !!fadeable, opacity: 1
  });
  const nU = pleats * 6, nV = 16;
  const cols = nU + 1, rows = nV + 1;
  // Each surface keeps its (side, isBack) so setOpen() can re-pose it in
  // place: the vertex count, index and colours never change with openness,
  // only positions (and so normals) do.
  const surfaces = [];
  const writePositions = (pos, side, isBack, openFrac) => {
    let p = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const [x, y, z] = curtainFoldVertex(i / nU, j / nV, side, isBack, openFrac, P);
        pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
        p++;
      }
    }
  };
  const makeSurface = (side, isBack) => {
    const pos = new Float32Array(cols * rows * 3);
    const col = new Float32Array(cols * rows * 3);
    writePositions(pos, side, isBack, openN);
    let p = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const u = i / nU;
        // Sharp two-tone cut on a pleat seam (pleat index, not u, decides).
        const pleatIdx = Math.min(pleats - 1, Math.floor(u * pleats));
        const c = isBack ? lining : (pleatIdx < outerPleats ? outer : inner);
        col[p * 3] = c.r; col[p * 3 + 1] = c.g; col[p * 3 + 2] = c.b;
        p++;
      }
    }
    const idx = [];
    for (let j = 0; j < nV; j++) {
      for (let i = 0; i < nU; i++) {
        const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
        if (!isBack) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, fabricMat);
    mesh.name = 'curtain_' + (side < 0 ? 'L' : 'R') + '_' + (isBack ? 'back' : 'front');
    add(group, mesh, !sheer);
    surfaces.push({ mesh, side, isBack });
  };
  makeSurface(-1, false); makeSurface(+1, false);
  if (!sheer) { makeSurface(-1, true); makeSurface(+1, true); }

  // Re-pose the fabric at a new openness, 0..100. Each half keeps its anchor
  // at its own wall end and gathers toward it (curtainFoldVertex), so a
  // centre-parted pair opens from the middle outward. Cheap: ~700 vertices a
  // surface, rewritten in place with no reallocation.
  let currentPct = openN * 100;
  const setOpen = (pct) => {
    const n = Math.max(0, Math.min(1, (+pct || 0) / 100));
    currentPct = n * 100;
    surfaces.forEach(sf => {
      const attr = sf.mesh.geometry.getAttribute('position');
      writePositions(attr.array, sf.side, sf.isBack, n);
      attr.needsUpdate = true;
      sf.mesh.geometry.computeVertexNormals();
      sf.mesh.geometry.computeBoundingSphere();
    });
  };
  const getOpen = () => currentPct;

  if (!cn) return { group, fadeMeshes, setOpen, getOpen, corniceStrip: null };

  // ---- cornice: a light-tight box -- lid over front (+ ends) ----
  // Built so that no exterior view can find a crack to see the lit inside
  // through: nothing merely BUTTS against anything else.
  //   * The lid is the top of the box. It overhangs the front face's outer
  //     surface (and the side faces') by CORNICE_LID_LIP, and runs
  //     CORNICE_WALL_TUCK back into the host wall.
  //   * The front and side faces stop CORNICE_FACE_TUCK below the lid's
  //     top, i.e. their tops are buried inside the lid, so the only thing
  //     seen from above is the lid's one top face.
  //   * The side faces also run CORNICE_WALL_TUCK back into the wall; a
  //     wall-to-wall cornice runs CORNICE_WALL_TUCK into each side wall.
  // No two faces are coplanar: every overlap is a few millimetres deep.
  const cH = cn.height * CM;
  const s = localXSign(cur);
  let cWidth, cOffset;
  if (cn.sideFaces) {
    cWidth = W * 1.04; cOffset = 0;
  } else {
    // Wall-to-wall: span the room along this wall, wherever the curtain
    // sits -- plus a tuck into each side wall so no end gap can open.
    cWidth = (cur.roomSpan[1] - cur.roomSpan[0]) * CM + 2 * CORNICE_WALL_TUCK;
    cOffset = s * (((cur.roomSpan[0] + cur.roomSpan[1]) / 2) - cur.c) * CM;
  }
  const cMat = new THREE.MeshStandardMaterial({ color: cn.color, roughness: 0.7, transparent: !!fadeable, opacity: 1 });
  const lidTop = TOP - CORNICE_LID_GAP;
  const faceTop = lidTop - CORNICE_FACE_TUCK;
  const faceH = faceTop - (TOP - cH);
  const faceMidY = faceTop - faceH / 2;
  const outerW = cn.sideFaces ? cWidth + 0.02 : cWidth;   // front face, side-face outer to outer
  const front = new THREE.Mesh(new THREE.BoxGeometry(outerW, faceH, 0.02), cMat);
  front.position.set(cOffset, faceMidY, cDepth);
  add(group, front).name = 'corniceFront';
  if (cn.sideFaces) {
    const sideD = cDepth + CORNICE_WALL_TUCK;
    [-1, 1].forEach(sx => {
      const sideFace = new THREE.Mesh(new THREE.BoxGeometry(0.02, faceH, sideD), cMat);
      sideFace.position.set(cOffset + sx * cWidth / 2, faceMidY, cDepth - sideD / 2);
      add(group, sideFace).name = 'corniceSide';
    });
  }
  // Lid: closes the box from above, so a hidden or faded ceiling shows a
  // shut pelmet rather than the fabric heading and the LED strip inside it.
  // CORNICE_LID_GAP under `top` so it never z-fights the ceiling.
  const lidW = cn.sideFaces ? outerW + 2 * CORNICE_LID_LIP : cWidth;
  const lidFront = cDepth + 0.01 + CORNICE_LID_LIP, lidBack = -CORNICE_WALL_TUCK;
  const lid = new THREE.Mesh(new THREE.BoxGeometry(lidW, CORNICE_LID_T, lidFront - lidBack), cMat);
  lid.position.set(cOffset, lidTop - CORNICE_LID_T / 2, (lidFront + lidBack) / 2);
  add(group, lid).name = 'corniceTop';
  if (cn.light) {
    // The emissive strip is what you see; the light it throws is a row of
    // downlights the SCENE adds from corniceSpotLayout() (gated on its
    // quality tier -- this builder never adds a light source).
    const lc = new THREE.Color(cn.lightColor);
    // The inside run of the box (a wall-to-wall cornice's end tucks are in
    // the side walls, not the room).
    const innerW = cn.sideFaces ? cWidth : cWidth - 2 * CORNICE_WALL_TUCK;
    // Tucked into the inside top-front corner: just under the lid, just
    // behind the front face (the strip is 2 cm tall, 3 cm deep).
    const stripY = TOP - CORNICE_LID_GAP - CORNICE_LID_T - CORNICE_STRIP_DROP;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(innerW * 0.96, 0.02, 0.03),
      new THREE.MeshStandardMaterial({ color: lc, emissive: lc, emissiveIntensity: 1.5, transparent: !!fadeable, opacity: 1 }));
    strip.position.set(cOffset, stripY, cDepth - 0.025);
    add(group, strip).name = 'corniceLightStrip';
    strip.castShadow = false;
    // The colour this cornice rests at before any Home Assistant state
    // arrives, its length, and the box the downlights must stay inside.
    strip.userData.restColor = lc.getHex();
    strip.userData.stripLength = innerW * 0.96;
    strip.userData.cornice = {
      width: innerW, offset: cOffset,
      top: TOP, height: cH, depth: cDepth,
      stripY, stripZ: cDepth - 0.025, sideFaces: !!cn.sideFaces
    };
    return { group, fadeMeshes, setOpen, getOpen, corniceStrip: strip };
  }
  return { group, fadeMeshes, setOpen, getOpen, corniceStrip: null };
}

// ===== The cornice's light: a row of downlights =====
//
// A strip light is simulated by 3 SpotLights on a narrow cornice and 5 on a
// wide one, evenly along it. They shine DOWN out of the open bottom of the
// box, onto the curtain heading and the wall, and by construction cannot
// light any face of the cornice itself:
//   * each sits behind the front face and below the lid, aimed down and
//     tilted back toward the wall by CORNICE_SPOT_TILT, with a cone half-
//     angle CORNICE_SPOT_ANGLE smaller than the tilt -- so even the cone's
//     front edge leans toward the wall and never reaches the front face,
//     and (tilt + angle < 90 degrees) no ray points up at the lid;
//   * the end lights are held in from the ends by at least the furthest
//     sideways any ray can travel before it leaves the box (through the
//     bottom or into the wall), so the side faces stay dark too.
// The old single unshadowed PointLight sat in FRONT of the fascia and lit
// its outer face as a hotspot; a point light cannot be aimed at all.
//
// They are unshadowed, so they are held to CORNICE_SPOT_RANGE and the cone's
// back edge is kept 12 degrees below horizontal: what little reaches past
// the wall plane is within ~1 m of the light and falling.

// Cornice box, metres.
export const CORNICE_LID_T = 0.01;        // lid thickness
export const CORNICE_LID_GAP = 0.001;     // lid top below `top`: clear of the ceiling, 1 mm of wall face above it
export const CORNICE_LID_LIP = 0.002;     // lid overhang past the front/side outer faces
export const CORNICE_FACE_TUCK = 0.003;   // front/side tops buried this far below the lid top
export const CORNICE_WALL_TUCK = 0.01;    // lid + sides (and wall-to-wall ends) run into the walls
export const CORNICE_STRIP_DROP = 0.012;  // strip centre below the lid's underside
// How far under `top` a heading that hangs in a cornice stops: clear of the
// lid's underside (gap + thickness) by 3 mm.
export const CURTAIN_HEAD_GAP = CORNICE_LID_GAP + CORNICE_LID_T + 0.003;
// Downlights.
export const CORNICE_WIDE_CM = 250;       // a cornice at least this wide gets 5, else 3
export const CORNICE_SPOT_TILT = 42 * Math.PI / 180;
export const CORNICE_SPOT_ANGLE = 36 * Math.PI / 180;
// Far enough to light the heading and the upper wall, no further: the
// lights are unshadowed, so reach is also how far they could shine through
// the wall they hang on.
export const CORNICE_SPOT_RANGE = 1.2;

/** 3 downlights on a narrow cornice, 5 on a wide (>= 250 cm) one. */
export function corniceLightCount(widthCm) {
  return widthCm >= CORNICE_WIDE_CM ? 5 : 3;
}

/**
 * Share a total cap of cornice lights between cornices. `counts` is each
 * cornice's wanted count (corniceLightCount); returns the counts to build,
 * same order. Over the cap, the cornice with the most lights gives one up
 * (5 -> 4 -> 3 -> 2 -> 1) until it fits; if even one each is too many, the
 * later cornices get none (their strips still glow). Fewer lights never
 * means a leak: corniceSpotLayout keeps any count inside the box.
 */
export function corniceLightBudget(counts, cap) {
  const out = counts.slice();
  const limit = cap == null ? Infinity : Math.max(0, cap | 0);
  const total = () => out.reduce((a, b) => a + b, 0);
  while (total() > limit) {
    let best = -1;
    out.forEach((n, i) => { if (n > 1 && (best < 0 || n > out[best])) best = i; });
    if (best < 0) break;
    out[best]--;
  }
  for (let i = out.length - 1; i >= 0 && total() > limit; i--) out[i] = 0;
  return out;
}

/**
 * Where the downlights go, in the curtain group's local frame (metres; z out
 * of the wall, y up). `box` is a strip's userData.cornice. `n` defaults to
 * corniceLightCount; a quality tier may pass fewer. Returns
 * { angle, spots: [{ x, y, z, tx, ty, tz }] } -- position and target.
 */
export function corniceSpotLayout(box, n) {
  const count = Math.max(1, n || corniceLightCount(box.width / CM));
  const bottom = box.top - box.height;
  // Just under the strip, never below the box's open bottom.
  const y = Math.max(bottom + 0.005, box.stripY - 0.015);
  const z = box.stripZ;
  const h = y - bottom;
  // Furthest any ray travels sideways before leaving through the bottom or
  // meeting the wall: every ray in the cone points down and back, so its
  // path in the box is at most sqrt(h^2 + z^2) / cos(angle) long.
  const reach = Math.hypot(h, z) * Math.tan(CORNICE_SPOT_ANGLE) + 0.02;
  const margin = Math.min(box.width / 2, Math.max(box.width / (2 * count), reach));
  const run = box.width - 2 * margin;
  const dy = -Math.cos(CORNICE_SPOT_TILT), dz = -Math.sin(CORNICE_SPOT_TILT);
  const spots = [];
  for (let i = 0; i < count; i++) {
    const x = box.offset - box.width / 2 + margin + (count > 1 ? run * i / (count - 1) : run / 2);
    spots.push({ x, y, z, tx: x, ty: y + dy, tz: z + dz });
  }
  return { angle: CORNICE_SPOT_ANGLE, range: CORNICE_SPOT_RANGE, spots };
}

// ===== Daylight through a window, gated by whatever hangs in front of it =====
//
// Pure functions (no THREE), so the numbers a screenshot cannot pin are
// testable in Node.

// What a closed curtain lets through. A blackout is ~0 by definition; a
// sheer passes a share of the light that falls with its opacity and tints it
// toward its own colour (a golden sheer gives dim, warm light).
export const BLACKOUT_TRANSMIT = 0.02;
export function curtainTransmit(cur) {
  if (!cur.sheer) return BLACKOUT_TRANSMIT;
  const op = Math.max(0, Math.min(1, cur.opacity));
  return Math.max(BLACKOUT_TRANSMIT, (1 - op) * 0.55);
}

/**
 * Plan-coordinate intervals (cm, along the wall) the two halves of `cur`
 * cover at openness `pct`. Mirrors curtainFoldVertex's span: each half is
 * anchored at its own end and spans a touch over half the width when
 * closed (the halves meet with an overlap), down to its gathered stack
 * (curtainGatheredSpan) when fully open. Same helper as the fabric.
 */
export function curtainCoverIntervals(cur, pct) {
  const openN = Math.max(0, Math.min(1, (+pct || 0) / 100));
  const half = cur.w / 2;
  const span = curtainHalfSpan(half, cur, openN);
  const lo = cur.c - half, hi = cur.c + half;
  if (2 * span >= cur.w) return [[lo, hi]];
  return [[lo, lo + span], [hi - span, hi]];
}

/** Fraction (0..1) of the window's WIDTH that `cur` covers at `pct`. */
export function curtainCoverage(win, cur, pct) {
  if (win.wallId == null || String(win.wallId) !== String(cur.wallId)) return 0;
  const a = win.c - win.w / 2, b = win.c + win.w / 2;
  if (b <= a) return 0;
  let covered = 0;
  curtainCoverIntervals(cur, pct).forEach(([lo, hi]) => {
    covered += Math.max(0, Math.min(b, hi) - Math.max(a, lo));
  });
  return Math.max(0, Math.min(1, covered / (b - a)));
}

/**
 * How much daylight gets through a window, and in what colour.
 *
 * Curtains on the same wall act as stacked filters: each passes its
 * uncovered fraction plus its covered fraction times its own transmission,
 * and the results multiply. A sheer also tints what it covers toward its own
 * colour.
 *
 * @param win       compiled window ({ wallId, c, w })
 * @param curtains  compiled curtains ({ id, wallId, c, w, sheer, opacity, outerColor, openPct })
 * @param pctOf     id -> current openness (0..100); null/undefined falls back to cur.openPct
 * @returns { transmit: 0..1, tint: [r,g,b] each 0..1 }
 */
export function windowDaylight(win, curtains, pctOf) {
  let transmit = 1;
  let tint = [1, 1, 1];
  (curtains || []).forEach(cur => {
    const live = pctOf ? pctOf(cur.id) : null;
    const pct = live != null ? live : cur.openPct;
    const cov = curtainCoverage(win, cur, pct);
    if (cov <= 0) return;
    transmit *= (1 - cov) + cov * curtainTransmit(cur);
    if (cur.sheer) {
      const hex = cur.outerColor | 0;
      const col = [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
      // Normalised so the tint changes hue, not brightness -- dimming is the
      // transmission's job.
      const m = Math.max(col[0], col[1], col[2]) || 1;
      tint = tint.map((ch, i) => ch * ((1 - cov) + cov * (col[i] / m)));
    }
  });
  return { transmit, tint };
}
