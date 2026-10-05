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
 * `ottoman`: a channel-tufted storage bench in velvet. All generic, no brands or
 * models -- the repo is public.
 */
import { makeFinish, isKeptFinish } from './finishes.js';
import { roundedBox, concatGeometries } from './soft.js';
import { range, color } from './controls.js';

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
  'piano-bench': Object.freeze({ full: 1500, low: 300 }),
  'ottoman': Object.freeze({ full: 1500, low: 300 })
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
const BENCH_BUTTON_RISE = 1.1;   // crown above the rim: near seat level, so a button shows from a standing eye line

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

/**
 * Defaults, in cm: a channel-tufted storage bench, 92 x 46 x 40 as measured.
 * A plain upholstered box on four tiny recessed feet, with a lid that
 * overhangs it slightly all round and carries soft rolls running front to
 * back: one wide flat-topped panel in the middle and `sideChannels` rolls
 * each side of it, narrowing toward the ends.
 */
const OTTOMAN_DEFAULTS = Object.freeze({
  width: 92,
  depth: 46,
  height: 40,
  sideChannels: 4,     // rolls each side of the centre panel
  centreWidth: 27,     // the wide flat panel in the middle
  channelDepth: 3.5,   // how far the rolls rise above the lid
  lidThickness: 4,     // the lid slab under the rolls (its rounded edge is the piping)
  lidOverhang: 1,      // the lid overhangs the box by this much all round
  color: '#1b5e6a',    // teal plush velvet
  footColor: '#1c1c1c',
  finish: 'satin'      // velvet's soft sheen, between matte fabric and gloss
});

const OTTOMAN_FOOT_H = 1.5;      // cm, tiny square feet recessed under the box
const OTTOMAN_FRONT_BAND = 5;    // cm of flat lid in front of the rolls (the photo's front band)
const OTTOMAN_RIM = 1.5;         // cm of flat lid round the rolls at the back and the ends

function resolveOttomanParams(params) {
  return Object.assign({}, OTTOMAN_DEFAULTS, params || {});
}

/**
 * The widths (cm) of the lid's channels, left to right: `sideChannels`
 * rolls, the centre panel, the same rolls mirrored. Side rolls narrow
 * toward the ends (weights 1 down to 0.45), as in the photo. Exported for
 * the tests.
 */
export function ottomanChannelWidths(params) {
  const p = resolveOttomanParams(params);
  const n = Math.max(0, Math.min(8, Math.round(p.sideChannels)));
  const innerW = Math.max(1, p.width - 2 * OTTOMAN_RIM);
  const centre = n === 0 ? innerW : Math.max(1, Math.min(p.centreWidth, innerW * 0.7));
  const side = [];
  if (n > 0) {
    const weights = [];
    for (let k = 0; k < n; k++) weights.push(n === 1 ? 1 : 1 - 0.55 * Math.pow(k / (n - 1), 1.3));
    const sum = weights.reduce((a, b) => a + b, 0);
    const perSide = (innerW - centre) / 2;
    for (let k = 0; k < n; k++) side.push(perSide * weights[k] / sum); // k = 0 is next to the centre
  }
  return side.slice().reverse().concat([centre], side);
}

/**
 * One soft roll lying on the lid, centred on x and z with its (open) flat
 * underside at y = 0 -- it sits on the lid, so it needs no bottom. Its
 * cross-section is a rounded rectangle with elliptical edges (horizontal
 * radius r, vertical h), so a narrow roll is a full dome and a wide one a
 * flat-topped panel; the ends round off the same way. Vertex colours shade
 * it darker into the creases and lighter on the crown, which is how velvet
 * catches the light.
 */
function ottomanRoll(THREE, w, len, h, arcSeg) {
  function samples(half, r) {
    const out = [];
    for (let i = 0; i <= arcSeg; i++) {
      const th = i / arcSeg * Math.PI / 2;
      out.push([-half + r * (1 - Math.cos(th)), Math.sin(th)]);
    }
    const mirror = out.slice().reverse().map(([x, f]) => [-x, f]);
    if (Math.abs(out[out.length - 1][0] - mirror[0][0]) < 1e-9) mirror.shift();
    return out.concat(mirror);
  }
  const xs = samples(w / 2, Math.min(w / 2, h * 1.6));
  const zs = samples(len / 2, Math.min(len / 2, h * 1.6));
  const pos = [], col = [], idx = [];
  for (let j = 0; j < zs.length; j++) {
    for (let i = 0; i < xs.length; i++) {
      const f = Math.min(xs[i][1], zs[j][1]);
      pos.push(xs[i][0], h * f, zs[j][0]);
      const shade = 0.68 + 0.32 * Math.pow(f, 0.6);
      col.push(shade, shade, shade);
    }
  }
  const nu = xs.length;
  for (let j = 0; j < zs.length - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i, b = a + 1, c = a + nu, e = c + 1;
      idx.push(a, c, b, b, c, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Paint a whole geometry by vertex colour: `side` shade, blending to `top` where it faces up. */
function shadeGeometry(THREE, geo, side, top) {
  const nor = geo.attributes.normal;
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const up = nor ? Math.max(0, nor.getY(i)) : 0;
    const s = side + (top - side) * up;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = s;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/**
 * Build a channel-tufted storage ottoman in plush velvet: a plain box, a
 * lid with a rounded (piped) edge that overhangs it slightly, soft rolls
 * running front to back across the lid (a wide centre panel, narrower rolls
 * toward each end), a small pull-tab at the front centre, and four tiny
 * recessed feet (full detail only; at low detail the box goes to the floor).
 */
function buildOttoman(THREE, params, opts) {
  const p = resolveOttomanParams(params);
  const o = opts || {};
  const full = o.detail !== 'low';
  const m = v => v * CM;

  const W = p.width, D = p.depth, H = p.height;
  const crown = Math.max(0.2, Math.min(p.channelDepth, H * 0.2));
  const lidT = Math.max(1, Math.min(p.lidThickness, H * 0.25));
  const ov = Math.max(0, Math.min(p.lidOverhang, W / 4, D / 4));
  const footH = full ? Math.min(OTTOMAN_FOOT_H, H * 0.1) : 0;
  const lidBottom = H - crown - lidT;
  const baseH = lidBottom - footH;

  const group = new THREE.Group();
  group.name = 'furniture:ottoman';

  // One velvet material, vertex-coloured: the merge honours a palette part's
  // own vertex colours, so the crease/crown shading costs no extra draw.
  const velvet = makeFinish(THREE, p.finish, p.color);
  velvet.vertexColors = true;
  const footMat = makeFinish(THREE, 'matte', p.footColor);

  function add(geo, mat, name, x, y, z) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'ottoman:' + name;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }

  // ---- the box: plain upholstered sides, inset by the lid overhang ----------
  const bw = W - 2 * ov, bd = D - 2 * ov;
  const baseGeo = full
    ? roundedBox(THREE, m(bw), m(baseH), m(bd), m(1), { bevel: 1, omit: ['-y'] })
    : new THREE.BoxGeometry(m(bw), m(baseH), m(bd));
  add(shadeGeometry(THREE, baseGeo, 0.9, 0.9), velvet, 'base', 0, m(footH + baseH / 2), m(D / 2));

  // ---- feet: four tiny dark squares, recessed under the box -----------------
  if (full && footH > 0) {
    const fs = 3, inset = 4;
    const footGeo = new THREE.BoxGeometry(m(fs), m(footH), m(fs));
    for (const sx of [-1, 1]) {
      for (const zz of [ov + inset, D - ov - inset]) {
        add(footGeo, footMat, 'foot', m(sx * (bw / 2 - inset)), m(footH / 2), m(zz));
      }
    }
  }

  // ---- the lid: full width x depth, its rounded edge reads as the piping ----
  const lidGeo = full
    ? roundedBox(THREE, m(W), m(lidT), m(D), m(Math.min(1.6, lidT / 2)), { bevel: 2 })
    : new THREE.BoxGeometry(m(W), m(lidT), m(D));
  add(shadeGeometry(THREE, lidGeo, 0.86, 1.0), velvet, 'lid', 0, m(lidBottom + lidT / 2), m(D / 2));

  // ---- the pull-tab, hanging from the lid's front edge at the centre --------
  const tabH = Math.min(6, baseH * 0.3);
  const tabGeo = shadeGeometry(THREE, new THREE.BoxGeometry(m(3.2), m(tabH), m(0.4)), 0.8, 0.8);
  const tabMesh = add(tabGeo, velvet, 'tab', 0, m(lidBottom + 0.5 - tabH / 2), m(D - ov + 0.25));
  // Too thin to shadow itself cleanly: at 4 mm it striped with shadow acne.
  tabMesh.castShadow = false;
  tabMesh.receiveShadow = false;

  // ---- the rolls: centre panel + side rolls, running front to back ----------
  const widths = ottomanChannelWidths(p);
  const centreIdx = (widths.length - 1) / 2;
  const runLen = Math.max(1, D - OTTOMAN_FRONT_BAND - OTTOMAN_RIM);
  const runZ = OTTOMAN_RIM + runLen / 2;
  const arcSeg = full ? 3 : 1;
  let x = -W / 2 + OTTOMAN_RIM;
  widths.forEach((w, i) => {
    const isCentre = i === centreIdx;
    const h = isCentre ? crown : Math.min(crown, w * 0.5);
    add(ottomanRoll(THREE, m(w), m(runLen), m(h), arcSeg), velvet,
      isCentre ? 'panel' : 'channel', m(x + w / 2), m(lidBottom + lidT), m(runZ));
    x += w;
  });

  group.userData = { type: 'ottoman', params: p, detail: full ? 'full' : 'low' };
  return group;
}

// ---------------------------------------------------------------------------
// Multi-type export
// ---------------------------------------------------------------------------

// ---- edit-mode controls ---------------------------------------------------------
// Ranges, steps, options and labels are copied from the spec page (see controls.js).
const PIANO_CONTROLS = [
  range('width', 'Width', 100, 160, 1, 'cm'),
  range('depth', 'Depth', 30, 60, 1, 'cm'),
  range('height', 'Height', 80, 110, 1, 'cm'),
  range('caseTopHeight', 'Case top height', 66, 86, 1, 'cm'),
  range('restLean', 'Music rest lean', 0, 25, 1, '°'),
  color('bodyColor', 'Body'),
  color('standColor', 'Stand'),
];

const BENCH_CONTROLS = [
  range('width', 'Width', 50, 110, 1, 'cm'),
  range('depth', 'Depth', 25, 45, 1, 'cm'),
  range('height', 'Height', 40, 65, 1, 'cm'),
  range('apronHeight', 'Apron height', 4, 10, 0.5, 'cm'),
  color('seatColor', 'Seat'),
  color('baseColor', 'Frame'),
];

const OTTOMAN_CONTROLS = [
  range('width', 'Width', 60, 130, 1, 'cm'),
  range('depth', 'Depth', 30, 65, 1, 'cm'),
  range('height', 'Height', 30, 50, 1, 'cm'),
  range('sideChannels', 'Rolls each side', 0, 6, 1),
  range('centreWidth', 'Centre panel', 10, 60, 1, 'cm'),
  range('channelDepth', 'Roll height', 1, 6, 0.5, 'cm'),
  color('color', 'Body (velvet)'),
  color('footColor', 'Feet'),
];

export const TYPES = {
  'digital-piano': { DEFAULTS: PIANO_DEFAULTS, build: buildDigitalPiano, CONTROLS: PIANO_CONTROLS },
  'piano-bench': { DEFAULTS: BENCH_DEFAULTS, build: buildPianoBench, CONTROLS: BENCH_CONTROLS },
  'ottoman': { DEFAULTS: OTTOMAN_DEFAULTS, build: buildOttoman, CONTROLS: OTTOMAN_CONTROLS }
};
