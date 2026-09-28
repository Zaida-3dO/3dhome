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
 *     STEP_BACK_M toward the camera, along the reversed ray, and the room
 *     whose floor polygon (house cm) contains that point wins. No room ->
 *     the tap selects nothing (a wall top seen from above, the outside face
 *     of an exterior wall).
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
    const p = h.point;
    const sx = p.x - direction.x * STEP_BACK_M;
    const sz = p.z - direction.z * STEP_BACK_M;
    const [hx, hy] = toHouse(sx, sz);
    return { roomId: roomAt(rooms || [], hx, hy), via: 'wall', hit: h };
  }
  return { roomId: null, via: 'none', hit: null };
}
