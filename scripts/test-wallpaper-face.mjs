#!/usr/bin/env node
/**
 * Which face of a wall its wallpaper (walls[].faceTexture) lands on -- the pure
 * functions in src/wallpaper-face.js, and the renderer's use of them.
 * No framework, no install: `node scripts/test-wallpaper-face.mjs`.
 *
 * WHAT THIS GUARDS
 *
 *   The material-array pass used to map a compass side straight to a box face
 *   ("south" -> +x) without looking at which way the wall was DRAWN. The wall
 *   box is rotated by atan2(dx, dz), so for a wall drawn east or north its +x
 *   face looks the other way: the demo house's hall panel (wall 10, drawn
 *   east, side south) was papered on the north face, into the rooms behind.
 *
 *   The room-clipped overlay pass never read `side` at all: it always papered
 *   the WEST face of a north-south wall, which is only right when the profile
 *   happens to say west.
 *
 *   Every case is checked two ways: against a hand-written expectation, and
 *   against the geometry itself (rotate the box's local +x the way the
 *   renderer does and confirm the chosen face really points toward `side`).
 *   Fixtures are synthetic walls; only the demo house is read from disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const { wallpaperFaceAxis, overlayFace, overlayUOffset, sideNormalWorld } = await imp('src/wallpaper-face.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Plan -> world transforms: the standard one (x east, y south -> +z), and one
// with z flipped, which a profile can declare.
const S = 0.01;
const STD = { name: 'std', tx: x => (x - 300) * S, tz: y => (y - 200) * S };
const FLIP = { name: 'flipped-z', tx: x => (x - 300) * S, tz: y => -(y - 200) * S };

// The world normal of a box face, rotated exactly as home3d-scene.js rotates a
// wall box: rotation.y = atan2(dx, dz) over the TRANSFORMED end points.
function boxFaceWorldNormal(wall, axis, T) {
  const dx = T.tx(wall.x2) - T.tx(wall.x1), dz = T.tz(wall.y2) - T.tz(wall.y1);
  const a = Math.atan2(dx, dz);
  const px = [Math.cos(a), -Math.sin(a)];            // local +x under rotation.y = a
  return axis === 'px' ? px : [-px[0], -px[1]];
}
// The compass side's direction in world space, independent of the module.
function compassWorld(side, T) {
  const v = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[side];
  return [v[0] * Math.sign(T.tx(1) - T.tx(0)), v[1] * Math.sign(T.tz(1) - T.tz(0))];
}

// ---- 1. material-array face: both draw directions x both axes x both sides

const EW_EAST = { x1: 100, y1: 400, x2: 700, y2: 400 };   // east-west, drawn east
const EW_WEST = { x1: 700, y1: 400, x2: 100, y2: 400 };   // east-west, drawn west
const NS_SOUTH = { x1: 500, y1: 100, x2: 500, y2: 600 };  // north-south, drawn south
const NS_NORTH = { x1: 500, y1: 600, x2: 500, y2: 100 };  // north-south, drawn north

// Expected under the standard transform. The old direction-blind mapping gave
// south/east -> px and north/west -> nx for EVERY row; it is right only for the
// walls drawn west or south, so the drawn-east / drawn-north rows are the ones
// that catch a regression.
const EXPECT_STD = [
  [EW_EAST, 'south', 'nx'], [EW_EAST, 'north', 'px'],
  [EW_WEST, 'south', 'px'], [EW_WEST, 'north', 'nx'],
  [NS_SOUTH, 'east', 'px'], [NS_SOUTH, 'west', 'nx'],
  [NS_NORTH, 'east', 'nx'], [NS_NORTH, 'west', 'px'],
];
for (const [wall, side, want] of EXPECT_STD) {
  const got = wallpaperFaceAxis(wall, side, STD.tx, STD.tz);
  check(`std: wall ${JSON.stringify(wall)} side ${side} -> ${want}`, got === want, got);
}

// Geometric cross-check over both transforms: the chosen face points toward
// the side (positive dot), for every wall and every long side.
for (const T of [STD, FLIP]) {
  for (const [wall, side] of EXPECT_STD) {
    const axis = wallpaperFaceAxis(wall, side, T.tx, T.tz);
    const n = boxFaceWorldNormal(wall, axis, T), c = compassWorld(side, T);
    check(`${T.name}: ${side} face of ${JSON.stringify(wall)} faces ${side}`,
      axis && n[0] * c[0] + n[1] * c[1] > 0.99, { axis, n, c });
  }
}
// The flipped transform changes the answer for the same wall -- so the
// transform really is consulted, not just the plan coordinates.
check('flipped-z: east-west wall drawn east, side south -> px',
  wallpaperFaceAxis(EW_EAST, 'south', FLIP.tx, FLIP.tz) === 'px',
  wallpaperFaceAxis(EW_EAST, 'south', FLIP.tx, FLIP.tz));

// End faces and nonsense sides are null, in either draw direction.
for (const [wall, side] of [[EW_EAST, 'east'], [EW_WEST, 'west'], [NS_SOUTH, 'north'], [NS_NORTH, 'south'],
                            [EW_EAST, 'up'], [{ x1: 5, y1: 5, x2: 5, y2: 5 }, 'south']]) {
  check(`end/invalid face: ${JSON.stringify(wall)} side ${side} -> null`,
    wallpaperFaceAxis(wall, side, STD.tx, STD.tz) === null && sideNormalWorld(wall, side, STD.tx, STD.tz) === null,
    wallpaperFaceAxis(wall, side, STD.tx, STD.tz));
}

// ---- 2. the room-clipped overlay on a north-south wall

const T_M = 0.10, P_M = 0.006;           // wall and panel thickness (m)
// A partly-fronted stretch of the wall: the room fronts plan y 150..380 of a
// wall that runs 100..600, so the face is NOT the whole wall.
const FRONT_Y0 = 150, FRONT_Y1 = 380;

for (const T of [STD, FLIP]) {
  for (const wall of [NS_SOUTH, NS_NORTH]) {
    for (const side of ['east', 'west']) {
      const f = overlayFace(wall, side, T.tx, T.tz, T_M, P_M);
      const sideX = compassWorld(side, T)[0];
      const want = sideX > 0 ? 1 : -1;
      const tag = `${T.name}: overlay ${side} of ${JSON.stringify(wall)}`;
      check(tag + ' is on that side', f && f.faceSign === want, f);
      check(tag + ' sits just proud of that face',
        f && near(f.overlayX, T.tx(500) + want * (T_M / 2 + P_M / 2)), f && f.overlayX);
      // Reads left-to-right from that side: looking at a face whose normal is
      // world +/-x, the viewer's right is world -/+z. The image's u must grow
      // toward the viewer's right, so a panel further right has a larger offset.
      const faceZ0 = Math.min(T.tz(FRONT_Y0), T.tz(FRONT_Y1)), faceZ1 = Math.max(T.tz(FRONT_Y0), T.tz(FRONT_Y1));
      const len = faceZ1 - faceZ0;
      const rightIsPlusZ = want < 0;
      const loZ = [faceZ0, faceZ0 + len * 0.3], hiZ = [faceZ0 + len * 0.6, faceZ1];
      const uLo = f && overlayUOffset(f, loZ[0], loZ[1], faceZ0, faceZ1);
      const uHi = f && overlayUOffset(f, hiZ[0], hiZ[1], faceZ0, faceZ1);
      check(tag + ' image reads the right way round from that side',
        f && (rightIsPlusZ ? uHi > uLo : uLo > uHi), { uLo, uHi, rightIsPlusZ });
      // The panels together cover [0, 1] of the image: the panel at the
      // viewer's LEFT edge starts at u = 0, the one at the right edge ends at 1.
      const leftPanel = rightIsPlusZ ? loZ : hiZ, rightPanel = rightIsPlusZ ? hiZ : loZ;
      const uL = f && overlayUOffset(f, leftPanel[0], leftPanel[1], faceZ0, faceZ1);
      const uR = f && overlayUOffset(f, rightPanel[0], rightPanel[1], faceZ0, faceZ1);
      check(tag + ' left panel starts the image, right panel ends it',
        f && near(uL, 0) && near(uR + (rightPanel[1] - rightPanel[0]) / len, 1), { uL, uR });
    }
    // North/south are the ends of a north-south wall.
    for (const side of ['north', 'south']) {
      check(`${T.name}: overlay ${side} (an end) of ${JSON.stringify(wall)} -> null`,
        overlayFace(wall, side, T.tx, T.tz, T_M, P_M) === null);
    }
  }
}

// A wall shaped like the one a real house papers through this pass: drawn
// NORTH, side WEST, the room fronting only part of it. Synthetic numbers. The
// overlay MUST come out exactly as the old hardcoded code placed it -- the west
// face, image u growing with world z from the near edge -- because that house
// already renders correctly.
{
  const w = { x1: 820, y1: 470, x2: 820, y2: 80, thickness: 10 };
  const f = overlayFace(w, 'west', STD.tx, STD.tz, T_M, P_M);
  const oldFaceX = STD.tx(820) - T_M / 2, oldOverlayX = oldFaceX - P_M / 2;
  check('north-drawn west-papered wall: overlay unchanged (west face, same x)',
    f && f.faceSign === -1 && near(f.overlayX, oldOverlayX), f);
  const faceZMin = STD.tz(95), faceZMax = STD.tz(290);
  for (const [a, b] of [[95, 140], [140, 170], [170, 290]]) {
    const zc = STD.tz((a + b) / 2), lm = (b - a) * S;
    const oldU = (zc - lm / 2 - faceZMin) / (faceZMax - faceZMin);
    const u = overlayUOffset(f, zc - lm / 2, zc + lm / 2, faceZMin, faceZMax);
    check(`north-drawn west-papered wall: panel ${a}..${b} same image slice as before`, near(u, oldU), { u, oldU });
  }
}

// ---- 3. the demo house: its hall panel goes on the hall's (south) face

{
  const geo = JSON.parse(fs.readFileSync(path.join(root, 'houses/demo/geometry.json'), 'utf8'));
  const ct = geo.coordinateTransform;
  check('demo transform is x_east_y_south (this test assumes it)', ct.planAxes === 'x_east_y_south', ct.planAxes);
  const T = { tx: x => (x - ct.originX) * ct.scale, tz: y => (y - ct.originY) * ct.scale };
  const papered = geo.walls.segments.filter(w => w.faceTexture);
  check('demo papers at least one wall', papered.length > 0);
  for (const w of papered) {
    const wall = { x1: w.start[0], y1: w.start[1], x2: w.end[0], y2: w.end[1] };
    const axis = wallpaperFaceAxis(wall, w.faceTexture.side, T.tx, T.tz);
    const n = axis && boxFaceWorldNormal(wall, axis, T), c = compassWorld(w.faceTexture.side, T);
    check(`demo wall ${w.id}: paper faces ${w.faceTexture.side}`, n && n[0] * c[0] + n[1] * c[1] > 0.99, { axis, n });
  }
  const w10 = geo.walls.segments.find(w => w.id === 10);
  if (w10 && w10.faceTexture && w10.faceTexture.side === 'south' && w10.end[0] > w10.start[0]) {
    check('demo wall 10 (drawn east, side south) -> nx, not the old px',
      wallpaperFaceAxis({ x1: w10.start[0], y1: w10.start[1], x2: w10.end[0], y2: w10.end[1] }, 'south', T.tx, T.tz) === 'nx');
  }
}

// ---- 4. the renderer actually uses these (a pure module nobody calls is no fix)

{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  check('scene imports the face functions',
    /import\s*\{[^}]*wallpaperFaceAxis[^}]*\}\s*from\s*'\.\/wallpaper-face\.js'/.test(src));
  check('material-array pass resolves the face with the draw direction',
    /wallpaperFaceAxis\(wall, ft\.side, tx, tz\)/.test(src));
  check('the direction-blind sideToFaceAxis is gone', !/sideToFaceAxis/.test(src));
  check('overlay pass reads the profile side', /overlayFace\(wall22, _overlaySpec\.side,/.test(src));
  check('overlay panels are placed at the resolved face', /mesh\.position\.set\(overlayX,/.test(src) &&
    /const overlayX = _face\.overlayX/.test(src));
  check('overlay image slice follows the resolved face', /overlayUOffset\(_face,/.test(src));
}

console.log(`test-wallpaper-face: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
