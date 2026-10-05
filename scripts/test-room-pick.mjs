#!/usr/bin/env node
/**
 * Room picking (src/room-pick.js). No framework, no install -
 * `node scripts/test-room-pick.mjs`.
 *
 * Builds a small real THREE scene -- two rooms either side of a solid
 * dividing wall, zero-opacity floor click-catchers built the way
 * home3d-scene.js builds them, an exterior wall, a faded wall, furniture --
 * and raycasts it from real camera positions, so the hit lists are the ones
 * THREE actually produces.
 *
 * WHAT THIS GUARDS
 *   1. A wall face tapped from room A selects A, never the room behind it
 *      (the owner-reported bug: the old first-catcher rule picked B). Both
 *      sides, and a steep downward tap near the wall's base.
 *   2. A wall top seen from straight above selects nothing; so does the
 *      outside face of an exterior wall.
 *   2b. The step back follows the tapped face's world normal, so a tilted
 *      view cannot step a wall-top tap off the wall into a room, and a steep
 *      tap on a face still reaches a room polygon drawn a few cm short.
 *   2c. A door keeps stepping (up to DOOR_REACH_M) out of its doorway gap
 *      to the tapped side's room; a wall keeps the single step.
 *   2d. A back face (DoubleSide panel) is stepped toward the camera.
 *   3. A faded (see-through) wall passes the tap to the room behind it.
 *   4. Furniture (a merged bucket, or a mesh under a tagged group) passes the
 *      tap to the floor of the room it stands in.
 *   5. A floor tap selects its room, as before; a hidden wall never blocks.
 *   6. home3d-scene.js's room click actually goes through pickRoom.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const R = await imp('src/room-pick.js');

let failed = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ok  ' + msg);
  else {
    failed++;
    const e = extra && typeof extra === 'object' && 'roomId' in extra ? { roomId: extra.roomId, via: extra.via } : extra;
    console.log('  FAIL ' + msg + (e !== undefined ? '  -> ' + JSON.stringify(e) : ''));
  }
};

// ---- A synthetic two-room house (house cm; the demo profile's transform) ----
const OX = 450, OY = 350, S = 0.01;
const tx = x => (x - OX) * S, tz = y => (y - OY) * S;
const toHouse = (x, z) => [x / S + OX, z / S + OY];
const WALL_H = 2.5;
// Room A west of a 10 cm divider at x=300, room B east of it. Polys stop at
// the wall faces, as the demo profile's do. The exterior wall on the north
// (y=0, 20 cm thick) bounds both.
const rooms = [
  { id: 'room_a', poly: [[10, 10], [295, 10], [295, 275], [10, 275]] },
  { id: 'room_b', poly: [[305, 10], [555, 10], [555, 275], [305, 275]] },
];

function build({ fadedDivider = false, hiddenDivider = false } = {}) {
  const scene = new THREE.Scene();
  // Click-catchers exactly as home3d-scene.js builds them.
  rooms.forEach(rm => {
    const shape = new THREE.Shape();
    shape.moveTo(tx(rm.poly[0][0]), -tz(rm.poly[0][1]));
    for (let i = 1; i < rm.poly.length; i++) shape.lineTo(tx(rm.poly[i][0]), -tz(rm.poly[i][1]));
    shape.closePath();
    const cc = new THREE.Mesh(new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    cc.rotation.x = -Math.PI / 2;
    cc.position.set(0, 0.006, 0);
    cc.userData = { roomId: rm.id, clickable: true };
    scene.add(cc);
  });
  // Floor slab under everything (solid, not a catcher).
  const slab = new THREE.Mesh(new THREE.BoxGeometry(20, 0.02, 20), new THREE.MeshStandardMaterial());
  slab.position.set(0, -0.01, 0);
  scene.add(slab);
  const wall = (x1, y1, x2, y2, thick, mat) => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x2 - x1) * S || thick * S, WALL_H,
      Math.abs(y2 - y1) * S || thick * S), mat || new THREE.MeshStandardMaterial());
    w.position.set(tx((x1 + x2) / 2), WALL_H / 2, tz((y1 + y2) / 2));
    scene.add(w);
    return w;
  };
  // The divider: x=300, 10 cm thick, y 0..280.
  const divider = wall(300, 0, 300, 280, 10, fadedDivider
    ? new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.05 })
    : new THREE.MeshStandardMaterial());
  if (hiddenDivider) {
    const g = new THREE.Group(); g.visible = false; scene.remove(divider); g.add(divider); scene.add(g);
  }
  // North exterior wall: y=0, 20 cm thick.
  wall(0, 0, 900, 0, 20);
  // Furniture in room A: a merged bucket mesh (userData.furniture on the
  // mesh), and a dynamic part under a tagged wrapper group.
  const bucket = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 0.5), new THREE.MeshStandardMaterial());
  bucket.position.set(tx(150), 0.45, tz(150));
  bucket.userData = { furniture: 'beauty', room: 'room_a' };
  scene.add(bucket);
  const dyn = new THREE.Group();
  dyn.userData = { furniture: 'dynamic', itemId: 'clock' };
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshStandardMaterial());
  hand.position.set(tx(80), 0.15, tz(200));
  dyn.add(hand);
  scene.add(dyn);
  scene.updateMatrixWorld(true);
  return scene;
}

// Raycast from a camera position (scene metres) toward a target point.
function tap(scene, from, to) {
  const o = new THREE.Vector3(...from);
  const d = new THREE.Vector3(...to).sub(o).normalize();
  const rc = new THREE.Raycaster(o, d);
  const hits = rc.intersectObjects(scene.children, true);
  return { hits, dir: d, pick: R.pickRoom(hits, d, rooms, toHouse) };
}
// The rule this replaces: first click-catcher along the ray.
const oldRule = hits => { const h = hits.find(x => x.object.userData.clickable); return h ? h.object.userData.roomId : null; };

const mid = y => tz(y);          // scene z of a house y
const wallX = tx(300);           // divider centreline, scene x

console.log('1. a wall face resolves to the side tapped');
{
  const s = build();
  // Camera standing in room A, looking east at the divider, aimed low so
  // the ray would carry on to B's floor if the wall did not block.
  const t = tap(s, [tx(100), 1.6, mid(140)], [wallX, 0.4, mid(140)]);
  ok(oldRule(t.hits) === 'room_b', 'the scene reproduces the bug: the old rule picks the room BEHIND the wall', oldRule(t.hits));
  ok(t.pick.roomId === 'room_a', 'from inside A, the divider selects A', t.pick);
  ok(t.pick.via === 'wall', 'resolved as a wall hit', t.pick.via);

  const u = tap(s, [tx(500), 1.6, mid(140)], [wallX, 0.4, mid(140)]);
  ok(u.pick.roomId === 'room_b', 'from inside B, the same divider selects B', u.pick);

  // Overhead, steep: the ray meets A's side of the divider near its base.
  const v = tap(s, [tx(230), 6, mid(140)], [tx(295), 0.3, mid(140)]);
  ok(v.hits[0] && !v.hits[0].object.userData.clickable, 'steep tap: nearest hit is the wall face, not a floor');
  ok(v.pick.roomId === 'room_a', 'a steep tap on A\'s side of the divider selects A', v.pick);

  // A wall running the other way: the exterior wall's inside face, from A.
  const w = tap(s, [tx(150), 1.6, mid(200)], [tx(150), 0.5, tz(10)]);
  ok(oldRule(w.hits) === null || oldRule(w.hits) === 'room_a', 'sanity: nothing but A lies behind the north wall');
  ok(w.pick.roomId === 'room_a' && w.pick.via === 'wall', 'the exterior wall\'s inside face selects A', w.pick);
}

console.log('2. a wall top from above, and an exterior wall from outside, select nothing');
{
  const s = build();
  const t = tap(s, [wallX, 10, mid(140)], [wallX, 0, mid(140)]);
  ok(t.hits.length > 0 && Math.abs(t.hits[0].point.y - WALL_H) < 1e-6, 'nearest hit is the wall top');
  ok(t.pick.roomId === null && t.pick.via === 'wall', 'a wall top selects nothing', t.pick);
  // Outside, north of the house, looking south at the exterior wall, low.
  const u = tap(s, [tx(150), 1.6, tz(-400)], [tx(150), 0.4, tz(0)]);
  ok(oldRule(u.hits) !== null, 'the old rule would have tapped through the exterior wall', oldRule(u.hits));
  ok(u.pick.roomId === null, 'the outside face of an exterior wall selects nothing', u.pick);
}

console.log('2b. the step follows the tapped face, not the ray\'s tilt');
{
  const s = build();
  // Default-ish 3/4 view from over room A: the ray lands on the divider's
  // TOP, 2 cm in from A's face. Stepped back 5 cm along the ray, about 4 cm
  // of that is horizontal and would carry the point off the wall into A.
  const target = [tx(297), WALL_H, mid(140)];
  const from = [tx(297) - 3, WALL_H + 5, mid(140)];
  const t = tap(s, from, target);
  ok(t.hits.length && Math.abs(t.hits[0].point.y - WALL_H) < 1e-6 && Math.abs(t.hits[0].point.x - tx(297)) < 1e-6,
    'nearest hit is the divider top, 2 cm from A\'s face');
  const alongRay = toHouse(t.hits[0].point.x - t.dir.x * R.STEP_BACK_M, t.hits[0].point.z - t.dir.z * R.STEP_BACK_M);
  ok(R.roomAt(rooms, alongRay[0], alongRay[1]) === 'room_a', 'control: a step along the ray WOULD land in A');
  ok(t.pick.roomId === null, 'a wall top tapped from a tilted view selects nothing', t.pick);

  // A steep tap on a wall face whose room polygon stops 3 cm short of it
  // (real profiles are drawn that loosely): along the ray the step moves
  // under a centimetre sideways and misses the room; along the face normal
  // it moves the full 5 cm.
  const inset = [{ id: 'room_a', poly: [[10, 10], [292, 10], [292, 275], [10, 275]] }, rooms[1]];
  const v = tap(s, [tx(295) - 0.6, 6, mid(140)], [tx(295), 0.3, mid(140)]);
  ok(v.hits[0] && v.hits[0].face.normal.x === -1, 'steep tap: nearest hit is A\'s face of the divider');
  ok(R.pickRoom(v.hits, v.dir, inset, toHouse).roomId === 'room_a', 'a steep tap reaches a room drawn 3 cm short of the wall');

  // A rotated, non-uniformly scaled wall: world normals, not local ones.
  const s2 = new THREE.Scene();
  const w = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  w.scale.set(2.8, WALL_H, 0.1);          // long along local x, thin along local z
  w.rotation.y = Math.PI / 2;             // ...turned to run north-south
  w.position.set(wallX, WALL_H / 2, mid(140));
  s2.add(w); s2.updateMatrixWorld(true);
  const r1 = new THREE.Raycaster(new THREE.Vector3(tx(100), 1.6, mid(140)),
    new THREE.Vector3(wallX, 0.4, mid(140)).sub(new THREE.Vector3(tx(100), 1.6, mid(140))).normalize());
  const hw = r1.intersectObjects(s2.children, true);
  const sb = R.stepBack(hw[0], r1.ray.direction);
  ok(Math.abs(sb.x + 1) < 1e-9 && Math.abs(sb.y) < 1e-9 && Math.abs(sb.z) < 1e-9, 'a rotated, scaled wall steps straight back west', sb);
  ok(R.pickRoom(hw, r1.ray.direction, rooms, toHouse).roomId === 'room_a', 'and selects A');
  // A slanted face under non-uniform scale: only the inverse-transpose keeps
  // it a true normal. THREE's own normal matrix is the oracle.
  const obj = new THREE.Object3D();
  obj.scale.set(1, 3, 0.5); obj.rotation.y = 0.5; obj.updateMatrixWorld(true);
  const ln = new THREE.Vector3(1, 1, 1).normalize();
  const want = ln.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(obj.matrixWorld)).normalize();
  const got = R.stepBack({ point: new THREE.Vector3(), face: { normal: ln }, object: obj }, want.clone().negate());
  ok(Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z) < 1e-9, 'a slanted face under non-uniform scale gets its true world normal', { got, want });
  // A room polygon drawn 3 cm INTO the divider (real profiles do this):
  // containment alone would hand that strip of the wall top to A.
  const over = [{ id: 'room_a', poly: [[10, 10], [298, 10], [298, 275], [10, 275]] }, rooms[1]];
  const top = tap(s, [tx(297), 10, mid(140)], [tx(297), 0, mid(140)]);
  ok(top.hits[0] && top.hits[0].point.y === WALL_H && R.roomAt(over, 297, 140) === 'room_a',
    'fixture: the tap lands on the wall top, over the overlapping polygon');
  ok(R.pickRoom(top.hits, top.dir, over, toHouse).roomId === null, 'a wall top selects nothing even where a polygon overlaps it');
  // ...while a floor-level solid (a rug) still resolves to its room.
  const rug = new THREE.Mesh(new THREE.BoxGeometry(1, 0.01, 1), new THREE.MeshStandardMaterial());
  rug.position.set(tx(150), 0.012, mid(60)); s.add(rug); s.updateMatrixWorld(true);
  const onRug = tap(s, [tx(150), 6, mid(60)], [tx(150), 0, mid(60)]);
  ok(onRug.hits[0] && onRug.hits[0].object === rug, 'fixture: nearest hit is the rug');
  ok(onRug.pick.roomId === 'room_a' && onRug.pick.via === 'wall', 'a rug (up-facing, floor level) still selects its room', onRug.pick);
  s.remove(rug);
  const nf = R.stepBack({ point: hw[0].point, object: hw[0].object }, { x: 0.6, y: -0.8, z: 0 });
  ok(nf.x === -0.6 && nf.y === 0.8 && nf.z === -0, 'a hit with no face steps back along the reversed ray', nf);
}

console.log('2c. a door steps on out of its doorway gap');
{
  // Two rooms whose polygons leave a 16 cm doorway gap (x 292..308) around a
  // closed door leaf standing in the wall line at x=300 (4 cm thick). One
  // 5 cm step from either face lands in the gap.
  const gapRooms = [
    { id: 'room_a', poly: [[10, 10], [292, 10], [292, 275], [10, 275]] },
    { id: 'room_b', poly: [[308, 10], [555, 10], [555, 275], [308, 275]] },
  ];
  const doorScene = (profileId, tagged = true) => {
    const sc = new THREE.Scene();
    const mount = new THREE.Group();
    mount.position.set(wallX, 0, mid(140));
    if (tagged) mount.userData = { doorId: 'D', doorProfileId: profileId, maxAngleDeg: 90, swingSign: 1 };
    const pivot = new THREE.Group();
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.04, 2.0, 0.8), new THREE.MeshStandardMaterial());
    leaf.position.set(0, 1.0, 0);
    pivot.add(leaf); mount.add(pivot); sc.add(mount);
    sc.updateMatrixWorld(true);
    return sc;
  };
  const fromA = [tx(150), 1.6, mid(140)], fromB = [tx(450), 1.6, mid(140)], onLeaf = [wallX, 1.0, mid(140)];
  const d = doorScene('hall_door');
  const a = tap(d, fromA, onLeaf), b = tap(d, fromB, onLeaf);
  ok(a.hits[0] && R.isDoor(a.hits[0].object), 'fixture: the nearest hit is the door leaf');
  const one = toHouse(a.hits[0].point.x - R.STEP_BACK_M, a.hits[0].point.z);
  ok(R.roomAt(gapRooms, one[0], one[1]) === null, 'control: a single 5 cm step from the leaf lands in the gap');
  ok(R.pickRoom(a.hits, a.dir, gapRooms, toHouse).roomId === 'room_a', 'a door tapped from A selects A');
  ok(R.pickRoom(b.hits, b.dir, gapRooms, toHouse).roomId === 'room_b', 'the same door tapped from B selects B');
  const unnamed = doorScene(null);
  const u = tap(unnamed, fromA, onLeaf);
  ok(R.pickRoom(u.hits, u.dir, gapRooms, toHouse).roomId === 'room_a', 'a door with no profile id (doorProfileId null) still steps on');
  const plain = doorScene(null, false);
  const w = tap(plain, fromA, onLeaf);
  ok(R.pickRoom(w.hits, w.dir, gapRooms, toHouse).roomId === null, 'control: the same slab untagged is a wall and keeps the single step');
  // Reach is bounded: a room 70 cm from the leaf is out of reach, 55 cm is in.
  const far = [{ id: 'room_a', poly: [[10, 10], [228, 10], [228, 275], [10, 275]] }];
  ok(R.pickRoom(a.hits, a.dir, far, toHouse).roomId === null, 'nothing within DOOR_REACH_M -> nothing');
  const near = [{ id: 'room_a', poly: [[10, 10], [245, 10], [245, 275], [10, 275]] }];
  ok(R.pickRoom(a.hits, a.dir, near, toHouse).roomId === 'room_a', 'a room ~55 cm from the leaf is within reach');
}

console.log('2d. a back face is stepped toward the camera, not through the panel');
{
  // A DoubleSide panel (a thin leaf, glass...) hit from its BACK: its own
  // face normal points away from the camera and must be flipped.
  const sc = new THREE.Scene();
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 2), new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }));
  panel.rotation.y = -Math.PI / 2;           // front face (+z local) now faces -x: toward room A
  panel.position.set(wallX, 1, mid(140));
  sc.add(panel); sc.updateMatrixWorld(true);
  const t = tap(sc, [tx(450), 1.6, mid(140)], [wallX, 1.0, mid(140)]);   // from B: the back face
  const n = t.hits[0].face.normal.clone().transformDirection(panel.matrixWorld);
  ok(n.x < -0.99, 'fixture: the hit face\'s own normal points away from the camera (toward A)');
  const sb = R.stepBack(t.hits[0], t.dir);
  ok(sb.x > 0.99, 'stepBack turns it toward the camera (toward B)', sb);
  ok(R.pickRoom(t.hits, t.dir, rooms, toHouse).roomId === 'room_b', 'so the back face selects B, the side tapped');
}

console.log('3. a faded wall passes the tap to the room behind it');
{
  const s = build({ fadedDivider: true });
  const t = tap(s, [tx(100), 1.6, mid(140)], [wallX, 0.4, mid(140)]);
  ok(t.pick.roomId === 'room_b', 'through a faded divider, the room behind is selected', t.pick);
  ok(t.pick.via === 'floor', 'by its floor catcher', t.pick.via);
  const h = build({ hiddenDivider: true });
  const u = tap(h, [tx(100), 1.6, mid(140)], [wallX, 0.4, mid(140)]);
  ok(u.pick.roomId === 'room_b', 'a hidden (visible=false) wall never blocks', u.pick);
}

console.log('4. furniture passes the tap to the room it stands in');
{
  const s = build();
  const t = tap(s, [tx(150), 6, mid(150)], [tx(150), 0, mid(150)]);
  ok(t.hits[0] && t.hits[0].object.userData.furniture === 'beauty', 'nearest hit is the furniture bucket');
  ok(t.pick.roomId === 'room_a' && t.pick.via === 'floor', 'a merged furniture bucket passes through to A', t.pick);
  const u = tap(s, [tx(80), 6, mid(200)], [tx(80), 0, mid(200)]);
  ok(u.hits[0] && u.hits[0].object.parent.userData.furniture === 'dynamic', 'nearest hit is a dynamic furniture part');
  ok(u.pick.roomId === 'room_a', 'a mesh under a furniture-tagged group passes through too', u.pick);
  ok(R.isFurniture(u.hits[0].object) && !R.isFurniture(s.children[2]), 'isFurniture walks ancestors, and a floor slab is not furniture');
}

console.log('5. floor taps behave as before');
{
  const s = build();
  const a = tap(s, [tx(60), 6, mid(60)], [tx(60), 0, mid(60)]);
  ok(a.pick.roomId === 'room_a' && a.pick.via === 'floor', 'a floor tap in A selects A', a.pick);
  const b = tap(s, [tx(450), 6, mid(200)], [tx(450), 0, mid(200)]);
  ok(b.pick.roomId === 'room_b' && b.pick.via === 'floor', 'a floor tap in B selects B', b.pick);
  ok(R.pickRoom([], b.dir, rooms, toHouse).roomId === null, 'no hits -> nothing');
  // A sprite (a room label) is not a mesh and never decides.
  const sprite = { object: { isSprite: true, userData: {}, parent: null }, point: { x: 0, y: 0, z: 0 } };
  ok(R.pickRoom([sprite].concat(b.hits), b.dir, rooms, toHouse).roomId === 'room_b', 'a non-mesh hit is skipped');
}

console.log('6. roomAt uses the house-cm polygons');
{
  ok(R.roomAt(rooms, 290, 100) === 'room_a' && R.roomAt(rooms, 310, 100) === 'room_b' && R.roomAt(rooms, 300, 100) === null,
    'either side of the divider, and its centreline');
  ok(R.roomAt([{ id: 'bad', poly: null }], 0, 0) === null, 'a room without a polygon is skipped');
}

console.log('6b. roomPolygons and sceneToHouse, against the real loader');
{
  const { HouseLoader } = await imp('src/house-loader.js');
  const geo = JSON.parse(fs.readFileSync(path.join(root, 'houses/demo/geometry.json'), 'utf8'));
  const w = console.warn; console.warn = () => {};
  let house; try { house = HouseLoader.compile(geo, ''); } finally { console.warn = w; }
  const T = house.transform, back = R.sceneToHouse(T.S, T.OX, T.OY);
  const [hx, hy] = back(T.tx(123.4), T.tz(567.8));
  ok(Math.abs(hx - 123.4) < 1e-9 && Math.abs(hy - 567.8) < 1e-9, 'sceneToHouse inverts the loader\'s own tx/tz', [hx, hy]);
  const polys = R.roomPolygons(house.rooms);
  ok(polys.length === Object.keys(house.rooms).length && polys.length > 0 && polys.every(p => house.rooms[p.id].poly === p.poly),
    'every compiled room keeps its own poly');
  const rect = R.roomPolygons({ r: { x1: 1, y1: 2, x2: 3, y2: 4 } })[0];
  ok(JSON.stringify(rect) === JSON.stringify({ id: 'r', poly: [[1, 2], [3, 2], [3, 4], [1, 4]] }), 'a room with no poly falls back to its rect', rect);
  ok(R.roomAt([rect], 2, 3) === 'r' && R.roomAt([rect], 3.5, 3) === null, 'and the rect contains what it should');
}

console.log('7. the scene\'s room click is wired through pickRoom');
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  ok(/import \{ pickRoom, roomPolygons, sceneToHouse(, isFurniture)?(, stepBack)? \} from '\.\/room-pick\.js';/.test(src), 'home3d-scene.js imports pickRoom and its helpers');
  // Edit mode's placing tap (B2 review finding 1) decides its room with the
  // SAME picker: pickRoom over the scene, and a wall hit stepped back.
  ok(/function placementPick\(clientX, clientY\) \{[\s\S]{0,400}pickRoom\(rc\.intersectObjects\(scene\.children, true\), rc\.ray\.direction, roomPolygons\(ROOMS\), toHouse, null\)[\s\S]{0,300}stepBack\(h, rc\.ray\.direction\)/.test(src),
    'placing a new item picks its room through pickRoom (walls resolve to the side tapped)');
  // Camera focus passes the focused room as a fifth argument (room-pick.js
  // preferFocused); the transform is still read per tap.
  ok(/const toHouse = sceneToHouse\(S, OX, OY\);[\s\S]{0,900}pickRoom\(rc\.intersectObjects\(scene\.children, true\), rc\.ray\.direction,\s*roomPolygons\(ROOMS\), toHouse, focus\)/.test(src),
    'the click handler calls it with the ray, the rooms and the current transform');
  ok(!/\.find\(x => x\.object\.userData\.clickable\)/.test(src), 'the old first-catcher rule is gone');
}

if (failed) { console.log('\n' + failed + ' FAILED'); process.exit(1); }
console.log('\nall room-pick tests passed');
