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

console.log('7. the scene\'s room click is wired through pickRoom');
{
  const src = fs.readFileSync(path.join(root, 'src/home3d-scene.js'), 'utf8');
  ok(/import \{ pickRoom \} from '\.\/room-pick\.js';/.test(src), 'home3d-scene.js imports pickRoom');
  ok(/pickRoom\(rc\.intersectObjects\(scene\.children, true\), rc\.ray\.direction/.test(src), 'the click handler calls it with the ray');
  ok(!/\.find\(x => x\.object\.userData\.clickable\)/.test(src), 'the old first-catcher rule is gone');
}

if (failed) { console.log('\n' + failed + ' FAILED'); process.exit(1); }
console.log('\nall room-pick tests passed');
