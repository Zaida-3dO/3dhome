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
  // 'gloss', not 'metal': the live scene has no environment map, so a
  // metalness-0.9 material reflects only black ambient and renders as dark
  // grey regardless of its base colour -- wrong for a white stand. 'gloss'
  // (metalness 0) actually shows the white it's given.
  const standMat = makeFinish(THREE, 'gloss', p.standColor);

  function addMesh(geo, mat, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }

  // ---- body slab: a slim slab whose TOP surface is keybedHM (where the
  // keybed sits -- keybedHeight is measured to the top of the white keys,
  // i.e. the body's top face). A real stage piano's case is much thinner
  // than the stand is tall, so the body only occupies the top fraction of
  // keybedHM, with the stand's legs visible below it. Back at z=0.
  const bodyHM = Math.max(0.06, Math.min(keybedHM * 0.22, 0.12));
  const bodyBottomM = keybedHM - bodyHM;
  addMesh(new THREE.BoxGeometry(widthM, bodyHM, depthM), bodyMat, 0, bodyBottomM + bodyHM / 2, depthM / 2);

  // ---- stand: two straight legs + a crossbar, back at z=0 -------------------
  // Depth layout: the stand/body run from z=0 (back) to keybedDepthM (front,
  // the player's edge); the whole item's back face is the legs' own back
  // face, so a leg is centred at z = depthM/2 with a depth of exactly
  // depthM -- its back face lands exactly on z=0. Legs run from the floor up
  // to the underside of the body slab, so they read as visibly supporting it.
  const legW = 0.05, legSpan = widthM - 2 * p.legInset * CM;
  const legX = legSpan / 2;
  const crossbarY = bodyBottomM * 0.35;
  for (const s of [-1, 1]) {
    const footGeo = new THREE.BoxGeometry(legW * 3, legW * 0.6, depthM);
    addMesh(footGeo, standMat, s * legX, legW * 0.3, depthM / 2);
    const uprightH = Math.max(0.01, bodyBottomM - legW * 0.6);
    const upright = new THREE.BoxGeometry(legW, uprightH, legW);
    addMesh(upright, standMat, s * legX, legW * 0.6 + uprightH / 2, depthM / 2);
  }
  // crossbar between the legs
  const crossbar = new THREE.BoxGeometry(legSpan, legW * 0.7, legW * 0.7);
  addMesh(crossbar, standMat, 0, crossbarY, depthM / 2);

  // key strips: one long white strip along the front edge, with a thinner
  // black strip set back slightly to read as the black-key row -- both
  // flush with the body's top surface (keybedHM).
  const keyStripH = 0.02;
  const whiteKeyDepth = keybedDepthM * 0.55;
  addMesh(new THREE.BoxGeometry(widthM * 0.97, keyStripH, whiteKeyDepth), whiteKeyMat,
    0, keybedHM + keyStripH / 2, depthM - whiteKeyDepth / 2 - 0.01);
  if (full) {
    const blackKeyDepth = keybedDepthM * 0.32;
    addMesh(new THREE.BoxGeometry(widthM * 0.95, keyStripH * 1.4, blackKeyDepth), blackKeyMat,
      0, keybedHM + keyStripH * 1.4 / 2 + 0.002, depthM - whiteKeyDepth - blackKeyDepth / 2 - 0.01);
  }

  // ---- music rest: an upright panel standing up from the back of the body --
  // Upright extent pinned to exactly (heightM - keybedHM), so the overall
  // envelope always equals DEFAULTS.height. restHeight only affects how far
  // the panel leans AWAY FROM THE PLAYER (toward -z, back past the body's
  // own back face) -- visual only, since a reclined rest reads as shallower;
  // it never changes the panel's own upright reach.
  const uprightM = Math.max(0.01, heightM - keybedHM);
  const restLean = Math.min(0.4, (p.restHeight * CM) / Math.max(uprightM, 0.01) * 0.3);
  const restThickness = 0.02;
  // A box of length L and thickness T, rotated by `restLean` about X, has
  // its OWN vertical bbox extent equal to L*cos(restLean) + T*sin(restLean)
  // -- the thickness contributes too, not just the length -- so L is solved
  // backward from that so the panel's built vertical projection lands on
  // exactly uprightM (otherwise leaning shrinks the built bbox below
  // DEFAULTS.height; confirmed numerically for restHeight in [5,15,40]).
  const panelLen = (uprightM - restThickness * Math.sin(restLean)) / Math.cos(restLean);
  const restGeo = new THREE.BoxGeometry(widthM * 0.9, panelLen, restThickness);
  // Pivot at the bottom-back edge of the panel (body's back-top corner), then
  // lean it AWAY from the player -- geometry translated so the pivot is at
  // its own local origin before rotation.
  restGeo.translate(0, panelLen / 2, restThickness / 2);
  // NEGATIVE x-rotation swings the panel's top toward -z (away from the
  // player, who stands at the +z front) -- a POSITIVE rotation here was the
  // bug: it swung the top toward +z, into the player's space. Leaning
  // backward pushes the panel's own back-most point past the pivot's z=0,
  // which would break the furniture contract's "back at z=0" rule (measured
  // on the whole group) -- so the pivot is shifted forward by exactly that
  // overshoot (panelLen * sin(restLean)) to compensate, landing the leaned
  // panel's back-most point back on z=0 without moving anything else.
  const backOvershoot = panelLen * Math.sin(restLean);
  const rest = new THREE.Mesh(restGeo, bodyMat);
  rest.position.set(0, keybedHM, backOvershoot);
  rest.rotation.x = -restLean;
  rest.castShadow = true; rest.receiveShadow = true;
  if (isKeptFinish(bodyMat.userData.finish)) rest.userData.keep = true;
  group.add(rest);

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
  // 'gloss', not 'metal': see the digital-piano stand's note above -- with no
  // environment map, a metal finish reads as dark grey no matter its colour.
  const baseMat = makeFinish(THREE, 'gloss', p.baseColor);

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
