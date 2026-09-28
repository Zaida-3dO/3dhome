/**
 * room-pick.js -- which room a tap on the 3D scene selects.
 *
 * The room click used to take the FIRST per-room floor click-catcher along
 * the ray and ignore everything in front of it, so nothing occluded: tapping
 * the wall of room A with room B behind it opened room B. This decides the
 * tap from the whole hit list instead, nearest first:
 *
 *   - not a mesh / not drawn            -> ignored
 *   - a floor click-catcher             -> that room (as before). Checked
 *     (userData.clickable + roomId)        BEFORE the opacity test: the
 *                                          catchers are zero-opacity on purpose.
 *   - see-through (opacity < OPACITY_SOLID, the tap-popovers rule: a faded
 *     wall, window glass, the ceiling seen from above) -> passes the tap on
 *   - furniture (an ancestor tagged userData.furniture -- the merged beauty
 *     buckets, a dynamic part's wrapper group) -> passes the tap on, so it
 *     lands on the floor of the room the item stands in
 *   - anything else solid (a wall, pillar, door, frame, rug...) BLOCKS, and
 *     resolves to the side that was tapped: the hit point is stepped back
 *     STEP_BACK_M toward the camera and the room whose floor polygon (house
 *     cm) contains that point wins. No room -> the tap selects nothing (a
 *     wall top seen from above, the outside face of an exterior wall).
 *
 * "Toward the camera" is along the tapped FACE's normal, turned to face the
 * camera, when the hit carries a face (every mesh hit does); along the
 * reversed ray otherwise. Along the ray alone, the horizontal part of the
 * step shrinks with the view's tilt: from the default 3/4 view about 4 of the
 * 5 cm are horizontal, so the near 4 cm of a 10 cm wall TOP stepped off the
 * wall into the room beside it (seen in the browser on the demo house). The
 * face normal steps a wall face a full 5 cm sideways at any tilt, and a wall
 * top straight up -- its footprint never leaves the wall.
 *
 * Bound lights / doors / curtains / devices never get here: tap-popovers
 * catches those in the capture phase and stops the click.
 *
 * Pure: no DOM, no renderer, no THREE import. Unit-tested in
 * scripts/test-room-pick.mjs.
 */

import { materialOpacity, isDrawn, OPACITY_SOLID } from './tap-popovers.js';
import { insidePoly } from './footstep-walk.js';

/** How far (scene metres) a wall hit is stepped back toward the camera. */
export const STEP_BACK_M = 0.05;

/** True when the object or any ancestor is furniture (src/furniture.js tags). */
export function isFurniture(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData && o.userData.furniture) return true;
  return false;
}

/** The room (by id) whose house-cm polygon contains (hx, hy), or null. */
export function roomAt(rooms, hx, hy) {
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (r && Array.isArray(r.poly) && r.poly.length >= 3 && insidePoly(r.poly, hx, hy)) return r.id;
  }
  return null;
}

/**
 * The unit direction a blocking hit is stepped back along: the hit face's
 * world normal, turned toward the camera (against the ray); the reversed ray
 * when the hit has no face. The normal is carried to world space by the
 * cofactor of the object's 3x3 (the inverse-transpose up to scale, so a
 * non-uniformly scaled wall box keeps true normals); its sign is settled by
 * the ray, so a mirrored matrix or a back face cannot flip it.
 */
export function stepBack(hit, direction) {
  const back = { x: -direction.x, y: -direction.y, z: -direction.z };
  const n = hit.face && hit.face.normal;
  const e = hit.object && hit.object.matrixWorld && hit.object.matrixWorld.elements;
  if (!n || !e) return back;
  // Column-major 4x4 -> the 3x3 a..i (rows).
  const a = e[0], b = e[4], c = e[8], d = e[1], f = e[5], g = e[9], k = e[2], l = e[6], m = e[10];
  // Cofactor matrix rows.
  const c00 = f * m - g * l, c01 = g * k - d * m, c02 = d * l - f * k;
  const c10 = c * l - b * m, c11 = a * m - c * k, c12 = b * k - a * l;
  const c20 = b * g - c * f, c21 = c * d - a * g, c22 = a * f - b * d;
  let x = c00 * n.x + c01 * n.y + c02 * n.z;
  let y = c10 * n.x + c11 * n.y + c12 * n.z;
  let z = c20 * n.x + c21 * n.y + c22 * n.z;
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-9)) return back;
  x /= len; y /= len; z /= len;
  if (x * back.x + y * back.y + z * back.z < 0) { x = -x; y = -y; z = -z; }
  return { x, y, z };
}

/**
 * Decide a room tap.
 *
 * @param hits       raycast hits, nearest first ({ object, point, face }).
 * @param direction  the ray direction ({x,y,z}, camera -> scene, unit length).
 * @param rooms      [{ id, poly: [[x, y], ...] }] in house cm.
 * @param toHouse    (sceneX, sceneZ) => [houseX, houseY].
 * @returns { roomId, via, hit } -- roomId null when the tap selects nothing.
 *   via: 'floor' (a catcher), 'wall' (a blocking hit, resolved or not),
 *   or 'none' (the ray met nothing that decides).
 */
export function pickRoom(hits, direction, rooms, toHouse) {
  const list = hits || [];
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    const o = h && h.object;
    if (!o || !o.isMesh) continue;
    if (!isDrawn(o)) continue;
    const u = o.userData || {};
    if (u.clickable && u.roomId) return { roomId: u.roomId, via: 'floor', hit: h };
    if (materialOpacity(o.material, h.face ? h.face.materialIndex : 0) < OPACITY_SOLID) continue;
    if (isFurniture(o)) continue;
    const s = stepBack(h, direction);
    const [hx, hy] = toHouse(h.point.x + s.x * STEP_BACK_M, h.point.z + s.z * STEP_BACK_M);
    return { roomId: roomAt(rooms || [], hx, hy), via: 'wall', hit: h };
  }
  return { roomId: null, via: 'none', hit: null };
}
