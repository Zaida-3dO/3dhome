/**
 * place.js - pure placement arithmetic for furniture. No THREE, no DOM:
 * plan centimetres in, plan centimetres out, tested in Node
 * (scripts/test-furniture-core.mjs).
 *
 * CONVENTIONS (the same as the schema's, see docs/house-profile.md):
 *   - Plan coordinates are the profile's own: x east, y SOUTH (screen-down).
 *   - rotationDeg is clockwise in plan. 0 = the item's front faces +y (south).
 *     The front direction is (-sin r, cos r): 90 faces west, 180 north,
 *     270 east. This is Sweet Home 3D's convention verbatim.
 *   - The width runs along (cos r, sin r) -- where the builder's local +x
 *     lands once the renderer sets group.rotation.y = -r.
 *   - The "back-centre" is the midpoint of the item's back edge on the floor
 *     plan; builders put their back face at local z = 0, so this is the point
 *     the renderer positions the group at.
 */

const DEG = Math.PI / 180;

/** Round away float noise so 90 degrees gives exactly (-1, 0), not (-1, 6e-17). */
const clean = v => (Math.abs(v) < 1e-12 ? 0 : v);

/** Unit vector the item's front faces, in plan. */
export function frontVector(rotationDeg) {
  const r = rotationDeg * DEG;
  return [clean(-Math.sin(r)), clean(Math.cos(r))];
}

/** Unit vector along the item's width (the builder's local +x), in plan. */
export function widthVector(rotationDeg) {
  const r = rotationDeg * DEG;
  return [clean(Math.cos(r)), clean(Math.sin(r))];
}

/**
 * Where the item's back-centre stands, once its params are resolved.
 *
 * A wall-anchored item (origin 'back') was placed by the loader already. A
 * free item (origin 'centre') is authored by its footprint centre, so the back
 * is half the RESOLVED depth behind it: back = at - front * depth / 2. That is
 * why this runs after the builder's DEFAULTS have filled `params`, not in the
 * loader.
 *
 * @param {Object} compiled  one entry of house.furniture
 * @param {Object} params    fully resolved params (DEFAULTS + overrides)
 * @returns {{x:number, y:number, rotationDeg:number, elevation:number,
 *            front:number[], right:number[]}}
 */
export function resolvePlacement(compiled, params) {
  const front = frontVector(compiled.rotationDeg);
  const right = widthVector(compiled.rotationDeg);
  let x = compiled.x, y = compiled.y;
  if (compiled.origin === 'centre') {
    const d = (params && typeof params.depth === 'number') ? params.depth : 0;
    x -= front[0] * d / 2;
    y -= front[1] * d / 2;
  }
  return { x: x, y: y, rotationDeg: compiled.rotationDeg, elevation: compiled.elevation || 0, front: front, right: right };
}

/**
 * The floor footprint as four plan points, in order
 * back-left, back-right, front-right, front-left ("left" = -width vector).
 *
 * @param {number} backX
 * @param {number} backY
 * @param {number} rotationDeg
 * @param {number} width   cm
 * @param {number} depth   cm
 */
export function footprintRect(backX, backY, rotationDeg, width, depth) {
  const f = frontVector(rotationDeg), u = widthVector(rotationDeg);
  const hw = width / 2;
  const bl = [backX - u[0] * hw, backY - u[1] * hw];
  const br = [backX + u[0] * hw, backY + u[1] * hw];
  return [
    bl,
    br,
    [br[0] + f[0] * depth, br[1] + f[1] * depth],
    [bl[0] + f[0] * depth, bl[1] + f[1] * depth]
  ];
}

/**
 * The exterior wall a FREE item should fade with, if any (§2.5 of the plan):
 * the nearest exterior, axis-aligned wall that has a face parallel to one of
 * the footprint's edges, within `maxGap` cm of that edge, and overlapping it
 * along its length. A tie on distance goes to the longer overlap.
 *
 * A footprint that is not axis-aligned has no edge parallel to any wall and
 * gets null -- it fades with nothing, which is the accepted imperfection.
 *
 * @param {Array<number[]>} footprint  four plan points (footprintRect)
 * @param {Array<Object>} walls  compiled walls: {id, x1, y1, x2, y2, thickness, outer}
 * @param {number} [maxGap=30]
 * @returns {?(number|string)} the wall id, or null
 */
export function pickFadeWall(footprint, walls, maxGap) {
  const limit = maxGap == null ? 30 : maxGap;
  const EPS = 0.01;
  let best = null;
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i], b = footprint[(i + 1) % footprint.length];
    const edgeHoriz = Math.abs(a[1] - b[1]) < EPS && Math.abs(a[0] - b[0]) > EPS;
    const edgeVert = Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) > EPS;
    if (!edgeHoriz && !edgeVert) continue;
    for (const w of walls) {
      if (!w || !w.outer) continue;
      const wHoriz = Math.abs(w.y1 - w.y2) < 0.5 && Math.abs(w.x1 - w.x2) >= 0.5;
      const wVert = Math.abs(w.x1 - w.x2) < 0.5 && Math.abs(w.y1 - w.y2) >= 0.5;
      if (!(edgeHoriz && wHoriz) && !(edgeVert && wVert)) continue;
      const at = wHoriz ? w.y1 : w.x1;
      const edgeAt = wHoriz ? a[1] : a[0];
      // Distance from the edge to the nearer face of the wall (0 if touching
      // or inside it).
      const gap = Math.max(0, Math.abs(edgeAt - at) - (w.thickness || 0) / 2);
      if (gap > limit) continue;
      const e0 = wHoriz ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
      const e1 = wHoriz ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
      const w0 = wHoriz ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
      const w1 = wHoriz ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2);
      const overlap = Math.min(e1, w1) - Math.max(e0, w0);
      if (overlap <= 0) continue;
      if (!best || gap < best.gap - 1e-6 || (Math.abs(gap - best.gap) <= 1e-6 && overlap > best.overlap)) {
        best = { id: w.id, gap: gap, overlap: overlap };
      }
    }
  }
  return best ? best.id : null;
}
