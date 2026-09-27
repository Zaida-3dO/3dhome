/**
 * strip-light-playground.js - the StripLightSpec playground room and where its
 * strips are mounted, as plain ESM so scripts/test-strip-light.mjs can build
 * the SAME room in Node and prove no strip is buried inside a piece of
 * furniture (a strip inside a TV draws its tube and its lights on the screen,
 * which corrupts the comparison the page exists for).
 *
 * THREE and the furniture modules are injected: this file imports nothing.
 * Metres, y up; the room is centred on the origin.
 *
 * DIMENSIONS ARE ILLUSTRATIVE: a made-up 6 x 4.5 m living-kitchen, not any
 * real home.
 */

export const ROOM = Object.freeze({ w: 6, d: 4.5, h: 2.6 });
export const WIN = Object.freeze({ z0: -0.6, z1: 0.6, y0: 0.9, y1: 2.1 });

/** Surface colours, shared by the room and the D glow cards that lie on them. */
export const COLOURS = Object.freeze({
  wall: '#e9e5dc', floor: '#a88560', ceiling: '#f2f0ea', shelf: '#7a5a3a',
  worktop: '#8e8c88', deskTop: '#f4f2ee', carcass: '#ffffff', tv: '#111114'
});

/** The TV panel: x from TV_X0 to TV_X1 (6 cm off the east wall). */
const TV = Object.freeze({ x0: 2.91, x1: 2.94, y: 1.22, h: 0.71, w: 1.23 });

/**
 * Every strip mounting, in the order the page's "Strips" slider adds them.
 * pos: the MOUNTING POINT (the channel's back, on the surface it is stuck to);
 * rotY turns the strip's local X; wash/back: D's distances (cm) to the lit
 * surface and to a wall behind; spread: D's card reach (cm); aim: up-facing
 * strips use aimed lights so they do not light the wall below their ledge.
 */
export function stripSlots() {
  const N = -ROOM.d / 2, E = ROOM.w / 2, Wx = -ROOM.w / 2;
  const C = COLOURS;
  const slots = [
    // Under the wall cabinets (bottom at 1.40), 3 cm in from their fronts.
    // Worktop 51.5 cm below; the backsplash 26 cm behind. The worktop card
    // reaches 34 cm across: to the worktop's front edge (its back half runs
    // into the wall, where the wall hides it).
    { name: 'under kitchen wall cabinets', length: 170, facing: 'down', pos: [-1.7, 1.40, N + 0.26], rotY: 0,
      wash: 51.5, spread: 34, back: 26, washAlbedo: C.worktop, backAlbedo: C.wall },
    // Under the desk top (0.74), behind the control panel (its back is 63.5 cm out).
    { name: 'desk, under the top', length: 110, facing: 'down', pos: [1.3, 0.74, N + 0.60], rotY: 0,
      wash: 74, spread: 45, washAlbedo: C.floor },
    // A cove on a ledge along the window wall, behind a 7 cm lip, lighting the ceiling.
    { name: 'cove over the window wall', length: 340, facing: 'up', pos: [Wx + 0.14, 2.43, 0], rotY: Math.PI / 2,
      wash: 17, spread: 30, back: 14, aim: true, washAlbedo: C.ceiling, backAlbedo: C.wall },
    // On the BACK of the TV, facing the wall 6 cm behind it.
    { name: 'behind the TV', length: 120, facing: 'back', pos: [TV.x1, 1.52, 0], rotY: -Math.PI / 2,
      wash: 6, spread: 30, washAlbedo: C.wall },
    // On top of the wall cabinets (2.10), lighting the ceiling.
    { name: 'on top of the wall cabinets', length: 170, facing: 'up', pos: [-1.7, 2.10, N + 0.12], rotY: 0,
      wash: 50, spread: 40, back: 12, aim: true, washAlbedo: C.ceiling, backAlbedo: C.wall },
    // Under the base run's carcass, in the 3 cm recess in front of the plinth.
    { name: 'kitchen plinth', length: 170, facing: 'down', pos: [-1.7, 0.13, N + 0.545], rotY: 0,
      wash: 13, spread: 25, washAlbedo: C.floor },
    // Under the floating shelf over the desk; the desk top below, the wall behind.
    { name: 'shelf over the desk', length: 60, facing: 'down', pos: [1.3, 1.55, N + 0.16], rotY: 0,
      wash: 78.5, spread: 30, back: 16, washAlbedo: C.deskTop, backAlbedo: C.wall },
    // Under the TV console's top, at the front of its open centre bay.
    { name: 'TV console open bay (10 cm)', length: 10, facing: 'down', pos: [E - 0.36, 0.322, 0], rotY: -Math.PI / 2,
      wash: 10, spread: 12, washAlbedo: C.carcass },
  ];
  // Stress slots: linear ceiling strips on a grid.
  const xs = [-2.2, -0.75, 0.75, 2.2], zs = [-1.75, -1.25, -0.75, -0.25, 0.25, 0.75, 1.25, 1.75];
  const lens = [60, 120, 240, 120];
  for (const z of zs) for (let i = 0; i < xs.length; i++) {
    slots.push({ name: 'ceiling strip', length: lens[i], facing: 'down', pos: [xs[i], ROOM.h, z], rotY: 0,
      wash: 260, spread: 80, washAlbedo: C.floor, stress: true });
  }
  return slots;
}

/** StripLight.build params for a slot (technique, N, diameter from the page). */
export function slotParams(slot, technique, n, diameter) {
  return {
    technique, n, length: slot.length, facing: slot.facing, diameter, aim: !!slot.aim,
    washDistance: slot.wash, washSpread: slot.spread, backWash: slot.back || 0,
    washAlbedo: slot.washAlbedo, backAlbedo: slot.backAlbedo || '#ffffff'
  };
}

/**
 * Build the room and its furniture into `root`.
 * @param {Object} THREE
 * @param {THREE.Group} root
 * @param {Object} F  { kitchen, desk, cabinet, sofa, plant } furniture modules
 * @returns {{ ceiling: THREE.Mesh, glass: THREE.Mesh }}
 */
export function buildRoom(THREE, root, F) {
  const C = COLOURS;
  const wallMat = new THREE.MeshStandardMaterial({ color: C.wall, roughness: 0.9 });
  const floorMat = new THREE.MeshStandardMaterial({ color: C.floor, roughness: 0.75 });
  const ceilMat = new THREE.MeshStandardMaterial({ color: C.ceiling, roughness: 0.95 });
  const box = (w, h, d, x, y, z, m, name) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z); b.name = name || 'room';
    b.castShadow = true; b.receiveShadow = true;
    root.add(b); return b;
  };
  const T = 0.1, { w, d, h } = ROOM;
  box(w + 2 * T, T, d + 2 * T, 0, -T / 2, 0, floorMat, 'floor');
  const ceiling = box(w + 2 * T, T, d + 2 * T, 0, h + T / 2, 0, ceilMat, 'ceiling');
  box(w + 2 * T, h, T, 0, h / 2, -d / 2 - T / 2, wallMat, 'wall-N');
  box(T, h, d, w / 2 + T / 2, h / 2, 0, wallMat, 'wall-E');
  // West wall with a window opening.
  const wx = -w / 2 - T / 2;
  box(T, h, WIN.z0 + d / 2, wx, h / 2, (-d / 2 + WIN.z0) / 2, wallMat, 'wall-W');
  box(T, h, d / 2 - WIN.z1, wx, h / 2, (WIN.z1 + d / 2) / 2, wallMat, 'wall-W');
  box(T, WIN.y0, WIN.z1 - WIN.z0, wx, WIN.y0 / 2, 0, wallMat, 'wall-W');
  box(T, h - WIN.y1, WIN.z1 - WIN.z0, wx, (h + WIN.y1) / 2, 0, wallMat, 'wall-W');
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfd8e8, roughness: 0.05, transparent: true, opacity: 0.18, depthWrite: false });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(WIN.z1 - WIN.z0, WIN.y1 - WIN.y0), glassMat);
  glass.name = 'window-glass';
  glass.position.set(wx + T / 2, (WIN.y0 + WIN.y1) / 2, 0); glass.rotation.y = Math.PI / 2; root.add(glass);
  // The cove: a ledge along the window wall and a 7 cm lip on its room edge,
  // so the tube is out of sight from below, as in a real cove.
  box(0.18, 0.03, 3.5, -w / 2 + 0.09, 2.415, 0, ceilMat, 'cove-ledge');
  box(0.02, 0.07, 3.5, -w / 2 + 0.19, 2.465, 0, ceilMat, 'cove-lip');
  // Floating shelf over the desk.
  box(1.0, 0.03, 0.22, 1.3, 1.565, -d / 2 + 0.11, new THREE.MeshStandardMaterial({ color: C.shelf, roughness: 0.7 }), 'shelf');

  const place = (g, x, y, z, rotY) => {
    g.position.set(x, y, z); g.rotation.y = rotY || 0;
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    root.add(g); return g;
  };
  const K = F.kitchen.TYPES;
  place(K['kitchen-base-run'].build(THREE, Object.assign({}, K['kitchen-base-run'].DEFAULTS, { width: 180, worktopColor: C.worktop })), -1.7, 0, -d / 2);
  place(K['kitchen-wall-run'].build(THREE, Object.assign({}, K['kitchen-wall-run'].DEFAULTS, { width: 180,
    // plain cabinets: a chimney hood would hang below the strip's line
    modules: [{ kind: 'cabinet', width: 60, hinge: 'left' }, { kind: 'cabinet', width: 60, hinge: 'right' }, { kind: 'cabinet', width: 60, hinge: 'right' }] })), -1.7, 1.40, -d / 2);
  place(F.desk.build(THREE, { width: 120, depth: 70, topHeight: 74, topColor: C.deskTop }), 1.3, 0, -d / 2);
  place(F.cabinet.build(THREE, {
    width: 180, height: 34, depth: 40,
    fronts: [{ height: 34, cells: [{ kind: 'door', width: 50 },
      { kind: 'stack', width: 80, cells: [{ kind: 'open', height: 14 }, { kind: 'drawer', height: 20 }] },
      { kind: 'door', width: 50 }] }],
    plinth: { type: 'plinth', height: 0 }, gloss: true, color: C.carcass, topColor: '#2a2a2a'
  }), w / 2, 0, 0, -Math.PI / 2);
  // The TV: a 55" panel, 6 cm off the wall.
  const tvMat = new THREE.MeshStandardMaterial({ color: C.tv, roughness: 0.3, metalness: 0.2 });
  box(TV.x1 - TV.x0, TV.h, TV.w, (TV.x0 + TV.x1) / 2, TV.y, 0, tvMat, 'tv');
  place(F.sofa.build(THREE, Object.assign({}, F.sofa.DEFAULTS, { chaise: 'none', width: 220, depth: 95 })), -w / 2 + 0.12, 0, 1.0, Math.PI / 2);
  place(F.plant.build(THREE, F.plant.DEFAULTS), w / 2 - 0.45, 0, -d / 2 + 0.45);
  return { ceiling, glass };
}
