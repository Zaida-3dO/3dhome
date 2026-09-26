/**
 * standing-desk.js - a sit-stand desk: rectangular top + two telescoping
 * T-foot legs, a crossbar under the top between the legs, and a small
 * control panel on the front edge.
 *
 * Pure builder, same convention as wall-fittings.js: THREE is passed in
 * rather than imported, so this module has no import-map dependency and can
 * be loaded by a plain Node test.
 *
 * LOCAL FRAME (matches wall-fittings.js / the spec pages):
 *   x  along the desk's width (left-right, facing the desk)
 *   y  up, 0 = the floor
 *   z  along the desk's depth (front-back; +z = front, toward the user)
 * The returned group is centred on x=0, z=0, with the top's underside at
 * y = height (so `height` is the desk's usable working height, i.e. the top
 * of the frame). Each leg is a front-to-back foot bar (flat, running the
 * full depth) with a single telescoping column rising from its centre.
 *
 * @param {object} THREE  the three.js module (or a THREE-shaped test double)
 * @param {object} opts
 * @param {number} opts.width        desk top width, cm (x)
 * @param {number} opts.depth        desk top depth, cm (z)
 * @param {number} opts.height       current working height, cm (top of frame
 *                                   / underside of the desk top) -- clamped
 *                                   to [minHeight, maxHeight]
 * @param {number} [opts.minHeight]  lowest sit height, cm (default 72)
 * @param {number} [opts.maxHeight]  highest stand height, cm (default 120)
 * @param {number} [opts.topThickness] desk top thickness, cm (default 2.5)
 * @param {number|string} [opts.topColor]   desk top colour (default white 0xf4f2ee)
 * @param {number|string} [opts.frameColor] leg/frame colour (default white 0xf2f1ec)
 * @returns {{ group: THREE.Group, clampedHeight: number }}
 */
export function buildStandingDesk(THREE, opts) {
  const o = opts || {};
  const CM = 0.01;

  const width = o.width;
  const depth = o.depth;
  const minHeight = o.minHeight != null ? o.minHeight : 72;
  const maxHeight = o.maxHeight != null ? o.maxHeight : 120;
  const clampedHeight = clampHeight(o.height, minHeight, maxHeight);
  const topThickness = o.topThickness != null ? o.topThickness : 2.5;
  const topColor = o.topColor != null ? o.topColor : 0xf4f2ee;
  const frameColor = o.frameColor != null ? o.frameColor : 0xf2f1ec;

  const W = width * CM;
  const D = depth * CM;
  const H = clampedHeight * CM;         // underside-of-top height (frame height)
  const TOP_T = topThickness * CM;

  const topMat = new THREE.MeshStandardMaterial({ color: topColor, roughness: 0.4 });
  const frameMat = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.45, metalness: 0.05 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5 });

  const group = new THREE.Group();
  group.name = 'standingDesk';

  // ---- desk top: a single rectangular slab, underside at y = H ----
  const top = new THREE.Mesh(new THREE.BoxGeometry(W, TOP_T, D), topMat);
  top.position.set(0, H + TOP_T / 2, 0);
  top.name = 'deskTop';
  top.castShadow = true; top.receiveShadow = true;
  group.add(top);

  // ---- legs: one T-foot column per side, set in FROM the top's edges ----
  const FOOT_W = Math.min(0.08, W * 0.08);     // foot bar cross-section (x)
  const FOOT_H = 0.04;                         // foot bar height off the floor
  const COL_W = 0.07;                          // column cross-section (x, along width)
  const COL_D = 0.05;                          // column cross-section (z, front-back)
  const INSET = Math.min(0.10, W * 0.08);      // legs sit in slightly from the top's side edges
  const legX = W / 2 - INSET - COL_W / 2;

  function buildLeg(sign) {
    const legGroup = new THREE.Group();
    legGroup.name = sign < 0 ? 'legLeft' : 'legRight';

    // flat foot bar, running the FULL depth front-to-back
    const foot = new THREE.Mesh(new THREE.BoxGeometry(FOOT_W, FOOT_H, D), frameMat);
    foot.position.set(sign * legX, FOOT_H / 2, 0);
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
    lowerStage.position.set(sign * legX, columnBot + lowerH / 2, 0);
    lowerStage.name = 'legColumnLower';
    lowerStage.castShadow = true; lowerStage.receiveShadow = true;
    legGroup.add(lowerStage);

    const upperStage = new THREE.Mesh(
      new THREE.BoxGeometry(COL_W * 0.72, upperH, COL_D * 0.72), frameMat);
    upperStage.position.set(sign * legX, upperBottomY + upperH / 2, 0);
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
  crossbar.position.set(0, H - 0.06, 0);
  crossbar.name = 'crossbar';
  crossbar.castShadow = true; crossbar.receiveShadow = true;
  group.add(crossbar);

  // ---- control panel: small box on the front edge, under the top, centred ----
  const panelW = Math.min(0.12, W * 0.1);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(panelW, 0.035, 0.03), panelMat);
  panel.position.set(0, H - 0.03, D / 2 - 0.05);
  panel.name = 'controlPanel';
  panel.castShadow = true; panel.receiveShadow = true;
  group.add(panel);

  return { group, clampedHeight };
}

/** Clamp a desk height into [minHeight, maxHeight], defaulting an absent
 * height to the range's midpoint. Exported so the tweaks panel and the test
 * can both apply exactly this rule rather than reimplementing it. */
export function clampHeight(height, minHeight, maxHeight) {
  const lo = Math.min(minHeight, maxHeight);
  const hi = Math.max(minHeight, maxHeight);
  const h = height != null ? height : (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, h));
}
