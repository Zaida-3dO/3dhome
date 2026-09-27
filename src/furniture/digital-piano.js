/**
 * digital-piano.js - multi-type module: `digital-piano`, `piano-bench` and
 * `ottoman`.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0, and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 * See docs/house-profile.md, "Furniture", and PR8 of
 * plan-furniture-system-r2.md.
 *
 * `digital-piano`: a slim white 88-key digital piano on its matching panel
 * stand (solid side panels and a back board), with 36 individual black keys,
 * a lit display, speaker grilles and a small music rest. `piano-bench`: a
 * classic adjustable piano bench -- a button-tufted faux-leather seat on an
 * apron with an adjustment knob at each end, on four square tapered legs.
 * `ottoman`: a simple channel-tufted-lid ottoman. All generic, no brands or
 * models -- the repo is public.
 */
import { makeFinish, isKeptFinish } from './finishes.js';
import { roundedBox, concatGeometries } from './soft.js';

const CM = 0.01;

// ---------------------------------------------------------------------------
// digital-piano
// ---------------------------------------------------------------------------

/**
 * Defaults, in cm: the proportions of a slim portable-style 88-key digital
 * piano sitting on its own matching panel stand (a common arrangement: the
 * case is only ~15 cm deep top to bottom and the stand brings its top to
 * ~76 cm). Illustrative, not a survey of any particular instrument.
 */
const PIANO_DEFAULTS = Object.freeze({
  width: 140,
  depth: 45,
  height: 97,            // floor to the top of the music rest -- honoured exactly
  caseTopHeight: 76,     // floor to the top of the case (the control panel)
  caseHeight: 15,        // the case itself, top to bottom
  keyDepth: 15,          // front-to-back length of a white key
  restWidth: 55,         // the music rest: a small centred panel, not full width
  restLean: 12,          // degrees the rest leans back, away from the player
  sidePanelDepth: 40,    // the stand's solid side panels
  bodyColor: '#f5f5f2',
  keyWhiteColor: '#fdfdfb',
  keyBlackColor: '#151515',
  standColor: '#f0f0ec',
  screenColor: '#6c8cff',
  grilleColor: '#bdbdbd',
  finish: 'matte'
});

/** Per-type triangle budgets (perf audit): asserted by scripts/test-digital-piano.mjs. */
export const TRIANGLE_CAPS = Object.freeze({
  'digital-piano': Object.freeze({ full: 1500, low: 300 }),
  'piano-bench': Object.freeze({ full: 1500, low: 300 })
});

function resolvePianoParams(params) {
  return Object.assign({}, PIANO_DEFAULTS, params || {});
}

/**
 * The 88-key layout, A0 to C8: 52 white keys, and a black key after every
 * white key named A, C, D, F or G except the last -- 36 black keys, grouped
 * in twos and threes. Returns, for each black key, the index of the white key
 * it follows (its centre sits on the boundary after that white key).
 */
export function blackKeyAfter() {
  const names = 'ABCDEFG';
  const out = [];
  for (let i = 0; i < 51; i++) {
    const n = names[i % 7];
    if (n === 'A' || n === 'C' || n === 'D' || n === 'F' || n === 'G') out.push(i);
  }
  return out;
}

/**
 * Build the digital piano: a slim white case -- a lower tray, end cheeks, a
 * raised control panel along the back with a lit display and two speaker
 * grilles, and a recessed keybed in front with 52 white keys (one strip with
 * key-gap lines) and 36 individual black keys -- on a stand of two solid side
 * panels joined by a back board, with a small music rest standing at the back
 * of the panel, leaning away from the player.
 */
function buildDigitalPiano(THREE, params, opts) {
  const p = resolvePianoParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';

  const W = p.width, D = p.depth;
  const caseTop = Math.max(p.caseHeight + 10, p.caseTopHeight);
  const caseH = Math.max(6, Math.min(p.caseHeight, caseTop - 10));
  const caseBottom = caseTop - caseH;
  const keyDepth = Math.max(5, Math.min(p.keyDepth, D - 12));
  const whiteTop = caseTop - 3;          // the keybed is recessed below the panel
  const keyT = 2.5;                      // white key thickness
  const trayTop = whiteTop - keyT;
  const cheekW = 5;
  const panelFront = D - keyDepth - 0.5; // the panel block runs from the back to the key backs
  const m = v => v * CM;

  const group = new THREE.Group();
  group.name = 'furniture:digital-piano';

  const bodyMat = makeFinish(THREE, p.finish, p.bodyColor);
  const whiteKeyMat = makeFinish(THREE, 'gloss', p.keyWhiteColor);
  const blackKeyMat = makeFinish(THREE, 'gloss', p.keyBlackColor);
  const gapMat = makeFinish(THREE, 'matte', '#8e8e8a');
  // 'gloss', not 'metal': the live scene has no environment map, so a
  // metalness-0.9 material reflects only black ambient and renders as dark
  // grey regardless of its base colour -- wrong for a white stand.
  const standMat = makeFinish(THREE, 'gloss', p.standColor);
  const screenMat = makeFinish(THREE, 'emissive', p.screenColor);
  const grilleMat = makeFinish(THREE, 'matte', p.grilleColor);

  function add(geo, mat, name, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'piano:' + name;
    mesh.position.set(x || 0, y || 0, z || 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }
  const box = (w, h, d, cx, cy, cz) => new THREE.BoxGeometry(m(w), m(h), m(d)).translate(m(cx), m(cy), m(cz));

  // ---- case ------------------------------------------------------------------
  add(box(W, trayTop - caseBottom, D, 0, (caseBottom + trayTop) / 2, D / 2), bodyMat, 'case-tray');
  for (const s of [-1, 1]) {
    add(box(cheekW, caseTop - trayTop, D, s * (W / 2 - cheekW / 2), (trayTop + caseTop) / 2, D / 2), bodyMat, 'case-cheek');
  }
  add(box(W - 2 * cheekW, caseTop - trayTop, panelFront, 0, (trayTop + caseTop) / 2, panelFront / 2), bodyMat, 'case-panel');

  // ---- keys ------------------------------------------------------------------
  const keyW = W - 2 * cheekW - 1;       // 52 white keys across this
  const pitch = keyW / 52;
  const k0 = -keyW / 2;
  const keyZ0 = panelFront + 0.5, keyZ1 = D;
  add(box(keyW, keyT, keyZ1 - keyZ0, 0, trayTop + keyT / 2, (keyZ0 + keyZ1) / 2), whiteKeyMat, 'white-keys');
  if (full) {
    // 51 key gaps: thin dark lines on top of the white strip, one mesh
    const gaps = [];
    const gw = Math.min(0.18, pitch * 0.08);
    for (let i = 1; i < 52; i++) {
      const g = new THREE.PlaneGeometry(m(gw), m(keyZ1 - keyZ0));
      g.rotateX(-Math.PI / 2);
      g.translate(m(k0 + i * pitch), m(whiteTop + 0.03), m((keyZ0 + keyZ1) / 2));
      gaps.push(g);
    }
    add(concatGeometries(THREE, gaps), gapMat, 'key-gaps');
    // 36 black keys, one mesh
    const bw = pitch * 0.58, bl = keyDepth * 0.62, bh = 1.2;
    const blacks = blackKeyAfter().map(i =>
      box(bw, bh, bl, k0 + (i + 1) * pitch, whiteTop + bh / 2, keyZ0 + bl / 2));
    add(concatGeometries(THREE, blacks), blackKeyMat, 'black-keys');
  } else {
    // low detail: the black keys collapse into one grey band
    const bl = keyDepth * 0.62;
    add(box(keyW, 0.6, bl, 0, whiteTop + 0.3, keyZ0 + bl / 2), makeFinish(THREE, 'matte', '#5a5a5a'), 'black-key-band');
  }

  // ---- control panel: a lit display left of centre, speaker grilles ------------
  if (full) {
    add(box(10, 0.3, 4, -W * 0.1, caseTop + 0.15, panelFront * 0.55), screenMat, 'display');
    for (const s of [-1, 1]) {
      add(box(20, 0.2, 8, s * (W / 2 - cheekW - 12), caseTop + 0.1, panelFront * 0.5), grilleMat, 'grille');
    }
  }

  // ---- stand: two solid side panels and a back board -------------------------
  const spT = 2;
  const spD = Math.min(p.sidePanelDepth, D);
  const spX = W / 2 - cheekW / 2;
  for (const s of [-1, 1]) {
    add(box(spT, caseBottom, spD, s * spX, caseBottom / 2, (D - spD) / 2 + spD / 2), standMat, 'stand-side');
  }
  const bbH = Math.min(13, caseBottom * 0.5);
  add(box(2 * spX - spT, bbH, 1.5, 0, caseBottom - bbH / 2, (D - spD) / 2 + 1.5), standMat, 'stand-back');

  // ---- music rest ---------------------------------------------------------------
  // A centred panel standing at the back of the control panel, leaning back
  // by restLean. Its length is solved so its top lands exactly on `height`;
  // the lean pushes its back past the pivot, so the pivot moves forward by
  // that overshoot to keep the item's back at z = 0.
  const lean = Math.max(0, Math.min(40, p.restLean)) * Math.PI / 180;
  const restT = 1;
  const upright = Math.max(1, p.height - caseTop);
  const panelLen = (upright - restT * Math.sin(lean)) / Math.cos(lean);
  const restGeo = new THREE.BoxGeometry(m(Math.min(p.restWidth, W)), m(panelLen), m(restT));
  restGeo.translate(0, m(panelLen / 2), m(restT / 2));
  const rest = add(restGeo, bodyMat, 'music-rest', 0, m(caseTop), m(panelLen * Math.sin(lean)));
  rest.rotation.x = -lean;

  group.userData = { type: 'digital-piano', params: p, detail: full ? 'full' : 'low' };
  return group;
}

// ---------------------------------------------------------------------------
// piano-bench
// ---------------------------------------------------------------------------

/**
 * A classic adjustable piano bench: a padded, button-tufted faux-leather
 * seat with rolled edges, a shallow apron under it housing the height
 * mechanism with a round adjustment knob at each end, on four square
 * tapered legs, slightly splayed, with no stretchers. Defaults in cm.
 */
const BENCH_DEFAULTS = Object.freeze({
  width: 58,
  depth: 34,
  height: 50,            // floor to the top of the seat
  seatThickness: 9,
  apronHeight: 7,
  seatColor: '#f3f1ec',
  baseColor: '#f7f7f4',  // the frame: apron, knobs and legs
  finish: 'satin'        // the seat: faux leather
});

function resolveBenchParams(params) {
  return Object.assign({}, BENCH_DEFAULTS, params || {});
}

/** Tufting, cm: how far each button pulls the seat top down, and the domed button's rim radius and crown. */
export const BENCH_TUFT_DIP = 2.0;
const BENCH_TUFT_RING = 3.25;   // the dimple's radius: where the seat is back at full height
const BENCH_BUTTON_R = 1.1;
const BENCH_BUTTON_RISE = 0.6;

/** The 2 x 4 tuft-button grid, as [x, z] offsets from the seat centre, cm. */
export function benchButtons(p) {
  const out = [];
  for (const fz of [-0.25, 0.25]) for (const fx of [-0.375, -0.125, 0.125, 0.375]) out.push([fx * (p.width - 6), fz * (p.depth - 4)]);
  return out;
}

function buildPianoBench(THREE, params, opts) {
  const p = resolveBenchParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';
  const W = p.width, D = p.depth, H = p.height;
  const seatT = Math.max(3, Math.min(p.seatThickness, H / 3));
  const apronH = Math.max(2, Math.min(p.apronHeight, H / 4));
  const m = v => v * CM;

  const group = new THREE.Group();
  group.name = 'furniture:piano-bench';

  const seatMat = makeFinish(THREE, p.finish, p.seatColor);
  const frameMat = makeFinish(THREE, 'gloss', p.baseColor);
  const c = new THREE.Color(p.seatColor).multiplyScalar(0.6);
  const buttonMat = makeFinish(THREE, p.finish, '#' + c.getHexString());

  function add(geo, mat, name, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'bench:' + name;
    mesh.position.set(x || 0, y || 0, z || 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }

  // ---- seat: rounded (rolled edges), button-tufted top ------------------------
  // The seat grid is CUT exactly through every button and through a ring of
  // lines BENCH_TUFT_RING either side of it, so at any size each button pulls
  // one vertex down (the dimple) while its ring stays at the seat top. The
  // ring's vertex normals tilt into the dimple, which is what lets the light
  // show it; a uniform grid put the buttons between vertices -- a shallow
  // 13 cm pyramid with the button disc buried in it.
  const buttons = benchButtons(p);
  const bxs = [...new Set(buttons.map(b => b[0]))].sort((a, b) => a - b);
  const bzs = [...new Set(buttons.map(b => b[1]))].sort((a, b) => a - b);
  const pitchX = bxs.length > 1 ? bxs[1] - bxs[0] : W / 2;
  const pitchZ = bzs.length > 1 ? bzs[1] - bzs[0] : D / 2;
  const ring = Math.min(BENCH_TUFT_RING, 0.4 * pitchX, 0.4 * pitchZ);
  const around = cs => cs.flatMap(c => [c - ring, c, c + ring]);
  const cutX = around(bxs), cutZ = around(bzs);
  // A button's pull: 1 at the button, 0 from its ring outward.
  const pull = (x, z) => {
    let best = 0;
    for (const [bx, bz] of buttons) {
      const u = Math.max(Math.abs(x - bx), Math.abs(z - bz)) / ring;
      if (u < 1) best = Math.max(best, 1 - u);
    }
    return best;
  };
  const tuft = v => {
    if (!full || v.y <= 0) return;
    v.y -= m(BENCH_TUFT_DIP) * pull(v.x / CM, v.z / CM) * Math.min(1, v.y / m(seatT / 2));
  };
  const seatGeo = roundedBox(THREE, m(W), m(seatT), m(D), m(Math.min(2.5, seatT / 2)),
    full ? { bevel: 2, inner: [8, 1, 4], cuts: [cutX.map(m), null, cutZ.map(m)], displace: tuft } : { bevel: 1, inner: [1, 1, 1] });
  add(seatGeo, seatMat, 'seat', 0, m(H - seatT / 2), m(D / 2));
  if (full) {
    // Each button: a low domed hexagonal cap (6 triangles) whose rim sits on
    // the dimple's slope and whose crown stands proud of the dimple floor.
    const bg = [];
    const rim = BENCH_BUTTON_R;
    // The seat surface at the rim, above the dimple floor: the grid is linear
    // between the button vertex and its ring.
    const rimLift = BENCH_TUFT_DIP * rim / ring;
    const rise = rimLift + BENCH_BUTTON_RISE;
    for (const [bx, bz] of buttons) {
      const pos = [], idx = [];
      const floorY = H - BENCH_TUFT_DIP;
      pos.push(m(bx), m(floorY + rise), m(D / 2 + bz));
      for (let k = 0; k < 6; k++) {
        const a = k / 6 * Math.PI * 2;
        pos.push(m(bx + rim * Math.cos(a)), m(floorY + rimLift), m(D / 2 + bz + rim * Math.sin(a)));
      }
      for (let k = 0; k < 6; k++) idx.push(0, 1 + ((k + 1) % 6), 1 + k);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      bg.push(g);
    }
    add(concatGeometries(THREE, bg), buttonMat, 'buttons');
  }

  // ---- apron with an adjustment knob at each end ------------------------------
  const knobL = 3, knobR = 3;
  const apronW = W - 2 * (1.5 + knobL);
  const apronD = D - 3;
  const apronTop = H - seatT;
  add(new THREE.BoxGeometry(m(apronW), m(apronH), m(apronD)), frameMat, 'apron',
    0, m(apronTop - apronH / 2), m(D / 2));
  for (const s of [-1, 1]) {
    const g = new THREE.CylinderGeometry(m(knobR), m(knobR), m(knobL), full ? 8 : 6);
    g.rotateZ(Math.PI / 2);
    add(g, frameMat, 'knob', m(s * (apronW / 2 + knobL / 2)), m(apronTop - apronH / 2), m(D / 2));
  }

  // ---- four square tapered legs, slightly splayed, no stretchers --------------
  const legTop = apronTop - apronH;
  const splay = 3 * Math.PI / 180;
  const lt = 4.5, lb = 3.5;
  const legLen = legTop / Math.cos(splay);
  const legGeo = new THREE.CylinderGeometry(m(lt / Math.SQRT2), m(lb / Math.SQRT2), m(legLen), 4, 1, false);
  legGeo.rotateY(Math.PI / 4);
  // inset so the splayed feet stay inside the seat's footprint
  const lx = apronW / 2 - lt / 2, lz = apronD / 2 - lt / 2 - 1.2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = add(legGeo, frameMat, 'leg', m(sx * lx), m(legTop / 2), m(D / 2 + sz * lz));
      // splay the foot outward in x and z; the leg's top stays under the apron
      leg.rotation.z = sx * splay;
      leg.rotation.x = -sz * splay;
      leg.position.x += m(sx * Math.sin(splay) * legLen / 2);
      leg.position.z += m(sz * Math.sin(splay) * legLen / 2);
      // the tilt lifts one corner of the foot off the floor and drops the
      // other through it: rest the lowest corner on the floor exactly
      leg.updateMatrixWorld(true);
      leg.position.y -= new THREE.Box3().setFromObject(leg).min.y;
    }
  }

  // ---- bbox: bottom on the floor, back at z = 0 --------------------------------
  group.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(group);
  const dy = -bb.min.y, dz = -bb.min.z, dx = -(bb.min.x + bb.max.x) / 2;
  if (Math.abs(dy) > 1e-6 || Math.abs(dz) > 1e-6 || Math.abs(dx) > 1e-6) {
    group.children.forEach(ch => { ch.position.x += dx; ch.position.y += dy; ch.position.z += dz; });
    group.updateMatrixWorld(true);
  }

  group.userData = { type: 'piano-bench', params: p, detail: full ? 'full' : 'low' };
  return group;
}

// ---------------------------------------------------------------------------
// ottoman
// ---------------------------------------------------------------------------

const OTTOMAN_DEFAULTS = Object.freeze({
  width: 92,
  depth: 46,
  height: 40,
  channelCount: 5,
  channelDepth: 1.5,
  color: '#2e6e6b',   // teal velvet
  legColor: '#3a2f28',
  finish: 'matte'
});

function resolveOttomanParams(params) {
  return Object.assign({}, OTTOMAN_DEFAULTS, params || {});
}

/** Build a velvet ottoman with a channel-tufted lid, on four short legs. */
function buildOttoman(THREE, params, opts) {
  const p = resolveOttomanParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';

  const widthM = p.width * CM, depthM = p.depth * CM, heightM = p.height * CM;
  const legHM = Math.min(0.08, heightM * 0.18);
  // The ridge crown adds `radius` of height ON TOP of the flat lid (it
  // stands PROUD, per the fix below) -- so that budget is reserved up front
  // from the overall height, alongside the legs, leaving `caseHM` for the
  // legs-to-flat-lid-top stack. Without this the ridges would push the
  // built bbox `radius` cm above DEFAULTS.height.
  const channelDepthMEstimate = p.channelDepth * CM;
  const ridgeBudget = Math.min(channelDepthMEstimate, heightM * 0.15);
  const caseHM = heightM - legHM - ridgeBudget;

  const group = new THREE.Group();
  group.name = 'furniture:ottoman';

  const bodyMat = makeFinish(THREE, p.finish, p.color);
  const legMat = makeFinish(THREE, 'matte', p.legColor);

  function addMesh(geo, mat, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }

  // ---- legs, four corners -----------------------------------------------------
  const legInset = 0.05;
  const legR = 0.018;
  for (const sx of [-1, 1]) {
    for (const sz of [0.06, 1]) {
      const legGeo = new THREE.CylinderGeometry(legR, legR * 0.8, legHM, full ? 12 : 4);
      addMesh(legGeo, legMat, sx * (widthM / 2 - legInset), legHM / 2, sz === 0.06 ? legInset : depthM - legInset);
    }
  }

  // ---- body, back at z=0 -------------------------------------------------------
  const bodyGeo = new THREE.BoxGeometry(widthM, caseHM * 0.82, depthM);
  addMesh(bodyGeo, bodyMat, 0, legHM + caseHM * 0.82 / 2, depthM / 2);

  // ---- channel-tufted lid: parallel ridges across the top, front-to-back ----
  // The flat lid slab occupies the rest of `caseHM`; the ridges (below) then
  // stand proud of ITS top by `ridgeBudget`, and that budget is exactly what
  // was reserved above, so the whole assembly's top lands on heightM.
  const lidHM = caseHM * 0.18;
  const lidY = legHM + caseHM * 0.82 + lidHM / 2;
  const lidBase = new THREE.BoxGeometry(widthM * 0.98, lidHM, depthM * 0.98);
  addMesh(lidBase, bodyMat, 0, lidY, depthM / 2);

  // Built as an extruded semicircle profile rather than a rotated
  // CylinderGeometry, to avoid ambiguity about which axis lands where after
  // rotation: a Shape drawn in XY with a flat base at y=0 and a dome up to
  // y=radius, extruded along Z, gives EXACTLY the frame a proud ridge needs
  // with no rotation at all -- X centred `[-radius, radius]` (width), Y
  // one-sided `[0, radius]` (flat bottom, domed top = proud height), Z
  // centred `[-runLen/2, runLen/2]` (the run, front-to-back).
  const n = Math.max(1, Math.round(p.channelCount));
  const seg = full ? 10 : 2;
  const nominalW = (widthM * 0.98) / n;
  const creaseM = Math.min(0.01, nominalW * 0.06);
  // The dome's radius is its own proud height (a semicircle profile), so it
  // is capped at `ridgeBudget` -- the exact height reserved for it above --
  // as well as at half its own share of the lid width, whichever is smaller.
  const radius = Math.min(ridgeBudget, (nominalW - creaseM) / 2);
  const runLen = depthM * 0.98;
  const ridgeShape = new THREE.Shape();
  ridgeShape.moveTo(-radius, 0);
  ridgeShape.absarc(0, 0, radius, Math.PI, 0, true); // dome over the top (y > 0)
  ridgeShape.lineTo(radius, 0);
  ridgeShape.closePath();
  const ridgeGeo = new THREE.ExtrudeGeometry(ridgeShape, { depth: runLen, bevelEnabled: false, curveSegments: seg });
  ridgeGeo.translate(0, 0, -runLen / 2); // centre the extrusion on Z
  const startX = -widthM * 0.98 / 2 + nominalW / 2;
  for (let i = 0; i < n; i++) {
    const cx = startX + i * nominalW;
    const mesh = new THREE.Mesh(ridgeGeo, bodyMat);
    // Flat bottom face sits exactly on the lid's flat top, so the dome
    // stands PROUD of it (never sunk inside, never floating above it).
    mesh.position.set(cx, lidY + lidHM / 2, depthM / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(bodyMat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
  }

  group.userData = { type: 'ottoman', params: p, detail: full ? 'full' : 'low' };
  return group;
}

// ---------------------------------------------------------------------------
// Multi-type export
// ---------------------------------------------------------------------------

export const TYPES = {
  'digital-piano': { DEFAULTS: PIANO_DEFAULTS, build: buildDigitalPiano },
  'piano-bench': { DEFAULTS: BENCH_DEFAULTS, build: buildPianoBench },
  'ottoman': { DEFAULTS: OTTOMAN_DEFAULTS, build: buildOttoman }
};
