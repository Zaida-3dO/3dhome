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

/**
 * CurtainSpec's fold placement, made static. u in [0,1] runs from the outer
 * (wall-end) edge to the centre part; v in [0,1] floor -> top. `maxAmp` caps
 * the fold depth so the lining never passes through the wall, nor through
 * another curtain hung behind this one (house-loader stackCurtains) -- the
 * spec page has no such neighbour to respect.
 */
export function curtainFoldVertex(u, v, side, isBack, openN, P) {
  const span = P.closedSpan + (P.gatherFrac * P.width / 2 - P.closedSpan) * openN;
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
  const pleats = Math.max(2, (cur.outerPleats | 0) + (cur.innerPleats | 0));
  const outerPleats = Math.min(pleats, Math.max(0, cur.outerPleats | 0));
  const P = {
    width: W, drop: DROP, bottom: TOP - DROP, pleats,
    ampBase: 0.055, thickness: 0.02, gatherFrac: 0.16,
    closedSpan: W / 2 * 1.03, midZ,
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
  const makeSurface = (side, isBack) => {
    const cols = nU + 1, rows = nV + 1;
    const pos = new Float32Array(cols * rows * 3);
    const col = new Float32Array(cols * rows * 3);
    let p = 0;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const u = i / nU, vv = j / nV;
        const [x, y, z] = curtainFoldVertex(u, vv, side, isBack, openN, P);
        pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
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
  };
  makeSurface(-1, false); makeSurface(+1, false);
  if (!sheer) { makeSurface(-1, true); makeSurface(+1, true); }

  if (!cn) return { group, fadeMeshes };

  // ---- cornice: front face (+ optional ends), top flush with `top` ----
  const cH = cn.height * CM;
  const s = localXSign(cur);
  let cWidth, cOffset;
  if (cn.sideFaces) {
    cWidth = W * 1.04; cOffset = 0;
  } else {
    // Wall-to-wall: span the room along this wall, wherever the curtain sits.
    cWidth = (cur.roomSpan[1] - cur.roomSpan[0]) * CM;
    cOffset = s * (((cur.roomSpan[0] + cur.roomSpan[1]) / 2) - cur.c) * CM;
  }
  const cMat = new THREE.MeshStandardMaterial({ color: cn.color, roughness: 0.7, transparent: !!fadeable, opacity: 1 });
  const cMidY = TOP - cH / 2;
  const front = new THREE.Mesh(new THREE.BoxGeometry(cn.sideFaces ? cWidth + 0.02 : cWidth, cH, 0.02), cMat);
  front.position.set(cOffset, cMidY, cDepth);
  add(group, front).name = 'corniceFront';
  if (cn.sideFaces) {
    [-1, 1].forEach(sx => {
      const sideFace = new THREE.Mesh(new THREE.BoxGeometry(0.02, cH, cDepth), cMat);
      sideFace.position.set(cOffset + sx * cWidth / 2, cMidY, cDepth / 2);
      add(group, sideFace).name = 'corniceSide';
    });
  }
  if (cn.light) {
    // Emissive strip only. The spec page adds three shadow-casting point
    // lights per cornice; in the house that would blow the fragment-uniform
    // budget the quality tiers in home3d-scene.js exist to protect.
    const lc = new THREE.Color(cn.lightColor);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(cWidth * 0.96, 0.02, 0.03),
      new THREE.MeshStandardMaterial({ color: lc, emissive: lc, emissiveIntensity: 1.5, transparent: !!fadeable, opacity: 1 }));
    strip.position.set(cOffset, TOP - cH * 0.35, cDepth - 0.025);
    add(group, strip).name = 'corniceLightStrip';
    strip.castShadow = false;
  }
  return { group, fadeMeshes };
}
