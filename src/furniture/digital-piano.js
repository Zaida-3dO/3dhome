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
 * `digital-piano`: a generic white 88-key stage piano on a white stand, with
 * a music rest. `piano-bench`: a white padded bench on an adjustable-height
 * X-base or column base. `ottoman`: a simple channel-tufted-lid ottoman,
 * included alongside the other two as a cheap third type. All generic, no
 * brands or models -- the repo is public.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

const CM = 0.01;

// ---------------------------------------------------------------------------
// digital-piano
// ---------------------------------------------------------------------------

const PIANO_DEFAULTS = Object.freeze({
  width: 138,
  depth: 46,
  height: 97,
  keybedHeight: 82,     // floor to the top of the white keys
  keybedDepth: 30,       // front-to-back depth of the keybed/body
  legInset: 8,           // how far the stand legs sit in from each end
  restHeight: 15,        // music rest height above the keybed top
  bodyColor: '#f5f5f2',
  keyWhiteColor: '#fdfdfb',
  keyBlackColor: '#161616',
  standColor: '#f0f0ec',
  finish: 'matte'
});

function resolvePianoParams(params) {
  return Object.assign({}, PIANO_DEFAULTS, params || {});
}

/**
 * Build the digital piano: a white slab body on two A-frame (or straight)
 * stand legs, a keybed with alternating white/black key strips (a flat
 * texture-free approximation -- individual keys would be far more geometry
 * for no visible gain at spec-page or room-scale distance), and a music
 * rest panel standing up at the back of the body.
 */
function buildDigitalPiano(THREE, params, opts) {
  const p = resolvePianoParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';

  const widthM = p.width * CM, depthM = p.depth * CM, heightM = p.height * CM;
  const keybedHM = p.keybedHeight * CM;
  const keybedDepthM = Math.min(p.keybedDepth * CM, depthM * 0.9);

  const group = new THREE.Group();
  group.name = 'furniture:digital-piano';

  const bodyMat = makeFinish(THREE, p.finish, p.bodyColor);
  const whiteKeyMat = makeFinish(THREE, 'gloss', p.keyWhiteColor);
  const blackKeyMat = makeFinish(THREE, 'gloss', p.keyBlackColor);
  const standMat = makeFinish(THREE, 'metal', p.standColor);

  function addMesh(geo, mat, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }

  // ---- stand: two straight legs + a crossbar, back at z=0 -------------------
  // Depth layout: the stand/body run from z=0 (back) to keybedDepthM (front,
  // the player's edge); the whole item's back face is the legs' own back
  // face, so a leg is centred at z = depthM/2 with a depth of exactly
  // depthM -- its back face lands exactly on z=0.
  const legW = 0.05, legSpan = widthM - 2 * p.legInset * CM;
  const legX = legSpan / 2;
  const crossbarY = keybedHM * 0.25;
  for (const s of [-1, 1]) {
    const footGeo = new THREE.BoxGeometry(legW * 3, legW * 0.6, depthM);
    addMesh(footGeo, standMat, s * legX, legW * 0.3, depthM / 2);
    const upright = new THREE.BoxGeometry(legW, keybedHM - legW * 0.6, legW);
    addMesh(upright, standMat, s * legX, legW * 0.6 + (keybedHM - legW * 0.6) / 2, depthM / 2);
  }
  // crossbar between the legs
  const crossbar = new THREE.BoxGeometry(legSpan, legW * 0.7, legW * 0.7);
  addMesh(crossbar, standMat, 0, crossbarY, depthM / 2);

  // ---- body / keybed slab, sits on top of the stand, back at z=0 -----------
  // height budget above the keybed splits: most of it is the body slab, with
  // a fixed sliver reserved for the music rest so the two always sum to
  // exactly (heightM - keybedHM) -- keeping the built bbox equal to
  // DEFAULTS.height regardless of restHeight.
  const aboveKeybedM = heightM - keybedHM;
  const restHM = Math.min(p.restHeight * CM, aboveKeybedM * 0.9);
  const bodyHM = Math.max(0.01, aboveKeybedM - restHM);
  addMesh(new THREE.BoxGeometry(widthM, bodyHM, depthM), bodyMat, 0, keybedHM + bodyHM / 2, depthM / 2);

  // key strips: one long white strip along the front edge, with a thinner
  // black strip set back slightly to read as the black-key row.
  const keyStripH = 0.02;
  const whiteKeyDepth = keybedDepthM * 0.55;
  addMesh(new THREE.BoxGeometry(widthM * 0.97, keyStripH, whiteKeyDepth), whiteKeyMat,
    0, keybedHM + keyStripH / 2, depthM - whiteKeyDepth / 2 - 0.01);
  if (full) {
    const blackKeyDepth = keybedDepthM * 0.32;
    addMesh(new THREE.BoxGeometry(widthM * 0.95, keyStripH * 1.4, blackKeyDepth), blackKeyMat,
      0, keybedHM + keyStripH * 1.4 / 2 + 0.002, depthM - whiteKeyDepth - blackKeyDepth / 2 - 0.01);
  }

  // ---- music rest: a thin upright panel at the very back of the body -------
  addMesh(new THREE.BoxGeometry(widthM * 0.9, restHM, 0.015), bodyMat,
    0, keybedHM + bodyHM + restHM / 2, 0.01);

  group.userData = { type: 'digital-piano', params: p, detail: full ? 'full' : 'low' };
  return group;
}

// ---------------------------------------------------------------------------
// piano-bench
// ---------------------------------------------------------------------------

const BENCH_DEFAULTS = Object.freeze({
  width: 76,
  depth: 34,
  height: 50,
  seatThickness: 8,
  baseStyle: 'x',        // 'x' | 'column'
  seatColor: '#f7f6f2',
  baseColor: '#e9e8e3',
  finish: 'matte'
});

function resolveBenchParams(params) {
  return Object.assign({}, BENCH_DEFAULTS, params || {});
}

/** Build a white padded bench on an adjustable-height X-frame or column base. */
function buildPianoBench(THREE, params, opts) {
  const p = resolveBenchParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';

  const widthM = p.width * CM, depthM = p.depth * CM, heightM = p.height * CM;
  const seatTM = p.seatThickness * CM;

  const group = new THREE.Group();
  group.name = 'furniture:piano-bench';

  const seatMat = makeFinish(THREE, p.finish, p.seatColor);
  const baseMat = makeFinish(THREE, 'metal', p.baseColor);

  function addMesh(geo, mat, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }

  // ---- seat pad, back at z=0 --------------------------------------------------
  const seatGeo = new THREE.BoxGeometry(widthM, seatTM, depthM);
  addMesh(seatGeo, seatMat, 0, heightM - seatTM / 2, depthM / 2);

  const baseTop = heightM - seatTM;
  if (p.baseStyle === 'column') {
    const colR = Math.min(widthM, depthM) * 0.12;
    const col = new THREE.CylinderGeometry(colR, colR, baseTop * 0.85, full ? 16 : 8);
    addMesh(col, baseMat, 0, baseTop * 0.85 / 2, depthM / 2);
    const footGeo = new THREE.CylinderGeometry(colR * 2.4, colR * 2.4, baseTop * 0.08, full ? 16 : 8);
    addMesh(footGeo, baseMat, 0, baseTop * 0.08 / 2, depthM / 2);
  } else {
    // X-frame: two crossed flat legs per end, adjustable-height look via a
    // central turnbuckle-style connector. A rotated box's own AXIS-ALIGNED
    // bbox reaches slightly past its two endpoints by its cross-section
    // half-thickness projected onto the rotation -- so the leg's nominal
    // length (the exact endpoint-to-endpoint span) is drawn slightly SHORT
    // of the diagonal, by exactly that overshoot, leaving the drawn box's
    // own bbox landing precisely on [0, baseTop] in y once thickness is
    // accounted for.
    const legT = 0.02, legThickZ = legT * 1.5;
    const runY = baseTop, runZ = depthM * 0.7;
    const theta = Math.atan2(runZ, runY);
    const nominalLen = Math.hypot(runY, runZ);
    // Half-thickness overshoot along y from rotating a legT x legThickZ
    // cross-section by theta: max(|legT/2 * ? |) -- the box's local x stays
    // axis-aligned (rotation is about x), so only the y/z cross-section
    // (legLen x legThickZ, before rotation) contributes: its own half-extents
    // project onto world y as (legLen/2)*cos(theta) + (legThickZ/2)*sin(theta).
    // We want that to equal runY/2 exactly, i.e. solve for legLen.
    const legLen = (runY - legThickZ * Math.sin(theta)) / Math.cos(theta);
    const legGeo = new THREE.BoxGeometry(legT, legLen, legThickZ);
    for (const s of [-1, 1]) {
      const xPos = s * (widthM / 2 - 0.05);
      const legA = new THREE.Mesh(legGeo, baseMat);
      legA.position.set(xPos, baseTop / 2, depthM / 2);
      legA.rotation.x = theta;
      legA.castShadow = true; legA.receiveShadow = true;
      if (isKeptFinish(baseMat.userData.finish)) legA.userData.keep = true;
      group.add(legA);
      const legB = new THREE.Mesh(legGeo, baseMat);
      legB.position.set(xPos, baseTop / 2, depthM / 2);
      legB.rotation.x = -theta;
      legB.castShadow = true; legB.receiveShadow = true;
      if (isKeptFinish(baseMat.userData.finish)) legB.userData.keep = true;
      group.add(legB);
    }
    if (full) {
      const bar = new THREE.BoxGeometry(widthM - 0.1, legT * 1.2, legT * 1.2);
      addMesh(bar, baseMat, 0, baseTop / 2, depthM / 2);
    }
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
  const bodyHM = heightM - legHM;

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
      const legGeo = new THREE.CylinderGeometry(legR, legR * 0.8, legHM, full ? 12 : 6);
      addMesh(legGeo, legMat, sx * (widthM / 2 - legInset), legHM / 2, sz === 0.06 ? legInset : depthM - legInset);
    }
  }

  // ---- body, back at z=0 -------------------------------------------------------
  const bodyGeo = new THREE.BoxGeometry(widthM, bodyHM * 0.82, depthM);
  addMesh(bodyGeo, bodyMat, 0, legHM + bodyHM * 0.82 / 2, depthM / 2);

  // ---- channel-tufted lid: parallel ridges across the top, front-to-back ----
  const lidHM = bodyHM * 0.18;
  const lidY = legHM + bodyHM * 0.82 + lidHM / 2;
  const lidBase = new THREE.BoxGeometry(widthM * 0.98, lidHM, depthM * 0.98);
  addMesh(lidBase, bodyMat, 0, lidY, depthM / 2);

  const n = Math.max(1, Math.round(p.channelCount));
  const seg = full ? 10 : 5;
  const channelDepthM = p.channelDepth * CM;
  const nominalW = (widthM * 0.98) / n;
  const radius = Math.min(channelDepthM, nominalW / 2 * 0.98);
  const ridgeGeo = new THREE.CylinderGeometry(radius, radius, depthM * 0.98, seg, 1, false, 0, Math.PI);
  ridgeGeo.rotateX(Math.PI / 2); // swing the cylinder's axis from y into z, flat side down (round face up)
  const startX = -widthM * 0.98 / 2 + nominalW / 2;
  for (let i = 0; i < n; i++) {
    const cx = startX + i * nominalW;
    const mesh = new THREE.Mesh(ridgeGeo, bodyMat);
    // Sink the ridge's centre by its own radius below the lid's flat top, so
    // its crown is flush with (never proud of) the overall envelope height.
    mesh.position.set(cx, lidY + lidHM / 2 - radius, depthM / 2);
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
