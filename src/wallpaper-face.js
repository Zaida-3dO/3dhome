// Which face of a wall a profile's wallpaper (walls[].faceTexture) lands on.
//
// Pure functions, no three.js: the renderer hands in the wall (plan cm) and
// its plan->world transform, and gets back a face it can build.
//
// A wall's `faceTexture.side` names a compass side ("the hall is SOUTH of this
// wall"). Two things in the renderer have to turn that into geometry:
//
//  1. The material-array pass papers one long face of the wall's own box. The
//     box is BoxGeometry(thickness, height, length) rotated by
//     atan2(dx, dz), so its local +x face points to world (dz, -dx) / len --
//     which of +x/-x is "south" therefore depends on which way the wall was
//     DRAWN. The old mapping ignored that, so a wall drawn east (or north)
//     got its paper on the face opposite the one the profile asked for.
//
//  2. The room-clipped overlay pass builds thin UNROTATED panels proud of one
//     face of a north-south wall. It has to know which world-x side to sit on,
//     and which way along world z the image runs so it reads the right way
//     round from that side (a box's +x face runs its texture u along -z, its
//     -x face along +z).
//
// Both are decided from the side's direction, never from the draw direction.

import { compassVector, faceNormalToward } from './wall-finish.js';

/**
 * The side's outward normal in WORLD (x, z), or null when the side names an
 * END of the wall rather than one of its two long faces (e.g. "east" on a
 * wall running east-west) or the wall is degenerate.
 */
export function sideNormalWorld(wall, side, tx, tz) {
  const ref = compassVector(side);
  if (!ref) return null;
  const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  // A side pointing more ALONG the wall than across it is an end face.
  if (Math.abs(dx * ref[0] + dy * ref[1]) / len > Math.SQRT1_2 + 1e-9) return null;
  const n = faceNormalToward(wall, ref);
  if (!n) return null;
  // The plan->world transform is affine per axis; its sign is what matters
  // (a profile may flip an axis).
  const sx = tx(1) - tx(0), sz = tz(1) - tz(0);
  return [n[0] * sx, n[1] * sz];
}

/**
 * The wall box's local face ('px' | 'nx') that looks toward `side`, or null
 * for an end face. Matches the box the renderer builds: rotation.y =
 * atan2(dx, dz) over the transformed endpoints, so local +x -> (dz, -dx).
 */
export function wallpaperFaceAxis(wall, side, tx, tz) {
  const wn = sideNormalWorld(wall, side, tx, tz);
  if (!wn) return null;
  const dx = tx(wall.x2) - tx(wall.x1), dz = tz(wall.y2) - tz(wall.y1);
  return (wn[0] * dz - wn[1] * dx) > 0 ? 'px' : 'nx';
}

/**
 * Where the room-clipped overlay goes on a NORTH-SOUTH wall, and which way
 * its image runs. null if `side` is not one of the wall's long faces.
 *
 *   faceSign     -1 / +1: the papered face is on the wall's world -x / +x side
 *   overlayX     world x of the overlay panels' centre (just proud of that face)
 *   uAscendingZ  true when image u should grow with world z (the panel's -x
 *                face), false when it grows with -z (its +x face) -- so the
 *                image reads left-to-right for someone looking at that face
 *
 * `thicknessM` and `panelM` are the wall's and the panel's thickness in metres.
 */
export function overlayFace(wall, side, tx, tz, thicknessM, panelM) {
  const wn = sideNormalWorld(wall, side, tx, tz);
  if (!wn || Math.abs(wn[0]) < 1e-9) return null;
  const faceSign = wn[0] > 0 ? 1 : -1;
  const faceX = tx(wall.x1) + faceSign * thicknessM / 2;
  return { faceSign, overlayX: faceX + faceSign * panelM / 2, uAscendingZ: faceSign < 0 };
}

/**
 * The u offset of one overlay panel spanning world z [zMin, zMax] within the
 * whole papered face [faceZMin, faceZMax], so every panel samples its own slice
 * of ONE image. (The repeat is simply the panel's share of the face's length.)
 */
export function overlayUOffset(face, zMin, zMax, faceZMin, faceZMax) {
  const faceLen = faceZMax - faceZMin;
  return face.uAscendingZ ? (zMin - faceZMin) / faceLen : (faceZMax - zMax) / faceLen;
}
