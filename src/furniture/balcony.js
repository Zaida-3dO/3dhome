/**
 * balcony.js - single-type module: `balcony`.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0, and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js). No lights.
 *     TWO exceptions to "no textures", both small procedural maps on a
 *     `keep` mesh: the decking boards' groove map (makeGrooveMap, a canvas,
 *     null under Node) and the grating's alpha-cutout map (makeGratingMap, a
 *     DataTexture, so it exists under Node too and is unit-tested).
 *   - bbox == params.width/depth/height within 0.5 cm for ANY params.
 * See docs/house-profile.md, "Furniture".
 *
 * A cantilevered balcony: a slab and a balustrade. The BACK (z = 0)
 * is the building face; `width` runs along the facade and the front railing
 * runs along z = depth. `height` is slab bottom to rail top.
 *
 *   floor     'grating' (default) = black open metal bar grating: load bars
 *             running from the building out (along z) tied by cross bars
 *             parallel to the facade, with open gaps you see through to
 *             whatever is below. It is ONE mesh of two textured planes (the
 *             top and the bottom of the bars, GRATE_T apart, so the bars
 *             read as having depth) with an alpha-cutout map, in a
 *             matte-satin near-black (gratingColor, finish 'satin': the live
 *             scene has no env map, so a metalness-1 black would read as a
 *             dead hole). Round it: a dark metal perimeter frame (railColor)
 *             on all four edges, slab bottom to deck top, plus one support
 *             beam along x at mid-depth under the bars. The deck top is
 *             y = slabThickness. Low detail is one gratingColor slab box.
 *             'decking' = a dark structural slab under dark
 *             charcoal composite boards running ALONG x (parallel to the
 *             facade) with real gaps between them, a fine longitudinal
 *             groove map on the boards, and a dark metal edge trim
 *             (railColor) round the front and both ends. The deck top is
 *             still y = slabThickness. Low detail is one charcoal slab box.
 *             'slab' = the plain light slab (slabColor).
 *   slab      width x depth, slabThickness thick, y 0 .. slabThickness
 *   railing   'bars'  = a top rail, a bottom rail and vertical metal bars
 *             'glass' = a top rail and glass panels between posts
 *   sides     leftSide / rightSide at x = -width/2 / +width/2, each
 *             'railing' (the same balustrade, running back to the building
 *             face), 'solid' (a solid panel) or 'none' (open). Left and
 *             right are as seen from the FRONT, looking at the building, so
 *             +x is right.
 *
 * THE CLEAR GAP between adjacent vertical members (bar to bar, bar to post,
 * bar to the building face) is never more than min(barSpacing - bar, 10) cm
 * at full detail: the bars on each run are counted to satisfy that and then
 * spread evenly. barSpacing is the target CENTRE spacing. Low detail keeps
 * every second bar and drops their end caps (a distance LOD, not a safety
 * drawing); a glass railing at low detail is one pane per run, no posts.
 *
 * The bars of one run are ONE mesh (one geometry built box by box), so a
 * 78-bar balustrade is three draws, not 78.
 */
import { makeFinish, isKeptFinish } from './finishes.js';
import { range, color, select } from './controls.js';

export const TYPE = 'balcony';

/** Defaults, in cm. */
export const DEFAULTS = Object.freeze({
  width: 547,              // along the facade
  depth: 155,              // building face to the front of the railing
  height: 125,             // slab bottom to rail top (a 15 slab + a ~110 guard)
  slabThickness: 15,
  floor: 'grating',        // 'grating' | 'decking' | 'slab'
  gratingColor: '#161618', // near-black grating (satin, not metal)
  gratingPitch: 3,         // cm, load-bar centre spacing (typical 30 mm bar grating; not measured)
  deckColor: '#2e2e30',    // charcoal composite boards
  boardWidth: 14.5,        // cm, one board's face (typical composite; not measured)
  boardGap: 0.6,           // cm, the gap between boards (typical; not measured)
  railingThickness: 5,     // top rail / post section, cm
  railing: 'bars',         // 'bars' | 'glass'
  barSpacing: 11,          // centre spacing; the clear gap is held <= 10
  leftSide: 'railing',     // 'railing' | 'solid' | 'none'
  rightSide: 'railing',
  slabColor: '#bdbab3',
  railColor: '#1c1c1e',    // metal finish
  solidColor: '#d9d6cf',
  glassColor: '#cfe3e8'
});

const CM = 0.01;
const MAX_GAP = 10;        // cm, the largest clear gap between vertical members
const BAR = 1.6;           // bar section, cm
const TOP_RAIL_H = 5;      // cm
const BOTTOM_RAIL_H = 3;   // cm
const BOTTOM_RAIL_UP = 6;  // cm above the slab top
const GLASS_T = 1.2;       // glass panel thickness, cm
const GLASS_PANEL_MAX = 120; // cm, the widest glass panel before another post
const BOARD_T = 2.5;       // cm, decking board thickness (typical composite)
const TRIM_T = 1;          // cm, the metal edge trim's thickness
const DECK_UNDER = '#141416'; // the structure under the boards: dark, so the gaps read dark
const GROOVES = 9;         // fine grooves across one board's face
const GRATE_T = 3;         // cm, the grating's bar depth (typical; not measured)
const CROSS_PITCH = 10;    // cm, cross-bar centre spacing (typical 30 x 100 grating; not measured)
const FRAME_W = 4;         // cm, the perimeter frame's section
// The grating tile: one load-bar pitch across (u, along x) by one cross-bar
// pitch along (v, along z). Power-of-two so it can repeat and mip.
const TILE_U = 16, TILE_V = 32;
const LOAD_BAR_PX = 3;     // ~0.56 cm of a 3 cm pitch
const CROSS_BAR_PX = 2;    // ~0.63 cm of a 10 cm pitch
export const GRATING_ALPHA_TEST = 0.5;

/**
 * The grating's alpha-cutout tile as RGBA bytes, TILE_U x TILE_V, plus its
 * mip chain. RGB is white everywhere (the colour comes from gratingColor);
 * alpha is 255 on a bar and 0 in a hole. Columns 0 .. LOAD_BAR_PX-1 are the
 * load bar (running along v = z), rows 0 .. CROSS_BAR_PX-1 the cross bar.
 *
 * THE MIPS ARE MAX-ALPHA, not averaged: an averaged mip of a ~75 % open
 * grating drops below the alpha test within a level or two, and the floor
 * would VANISH at a distance. Max-alpha instead closes the holes as the
 * grating shrinks on screen, so from far away it reads as a dark plate --
 * which is what a real grating looks like from across the street.
 *
 * @returns {{levels: Array<{data: Uint8Array, width: number, height: number}>}}
 */
export function gratingTile() {
  const level0 = new Uint8Array(TILE_U * TILE_V * 4);
  for (let v = 0; v < TILE_V; v++) {
    for (let u = 0; u < TILE_U; u++) {
      const i = (v * TILE_U + u) * 4;
      const bar = u < LOAD_BAR_PX || v < CROSS_BAR_PX;
      level0[i] = level0[i + 1] = level0[i + 2] = 255;
      level0[i + 3] = bar ? 255 : 0;
    }
  }
  const levels = [{ data: level0, width: TILE_U, height: TILE_V }];
  let prev = levels[0];
  while (prev.width > 1 || prev.height > 1) {
    const w = Math.max(1, prev.width >> 1), h = Math.max(1, prev.height >> 1);
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let a = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(prev.width - 1, x * 2 + dx), sy = Math.min(prev.height - 1, y * 2 + dy);
            a = Math.max(a, prev.data[(sy * prev.width + sx) * 4 + 3]);
          }
        }
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = a;
      }
    }
    prev = { data: d, width: w, height: h };
    levels.push(prev);
  }
  return { levels };
}

/**
 * The grating's alpha-cutout map: a DataTexture of gratingTile(), repeating,
 * with the max-alpha mips supplied by hand (generateMipmaps off). No DOM, so
 * it exists under Node too.
 * @param {Object} THREE
 * @returns {THREE.DataTexture}
 */
function makeGratingMap(THREE) {
  const { levels } = gratingTile();
  const tex = new THREE.DataTexture(levels[0].data, levels[0].width, levels[0].height, THREE.RGBAFormat);
  tex.mipmaps = levels;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The grating's two horizontal planes (top at yTop, bottom at yBot) over
 * x0..x1, z0..z1 (metres), in ONE indexed geometry (4 triangles). uv is in
 * TILES: u = x / pitch, v = z / CROSS_PITCH, so the repeating map puts a
 * load bar every `pitchCm` along x (each running along z) and a cross bar
 * every CROSS_PITCH cm along z. Both planes share the uvs, so looking
 * straight down the holes line up and you see through.
 */
function gratingGeometry(THREE, x0, x1, z0, z1, yTop, yBot, pitchCm) {
  const u0 = x0 / (pitchCm * CM), u1 = x1 / (pitchCm * CM);
  const v0 = z0 / (CROSS_PITCH * CM), v1 = z1 / (CROSS_PITCH * CM);
  const pos = [], nor = [], uv = [], idx = [];
  const quad = (y, ny) => {
    const base = pos.length / 3;
    for (const [x, z, u, v] of [[x0, z0, u0, v0], [x0, z1, u0, v1], [x1, z1, u1, v1], [x1, z0, u1, v0]]) {
      pos.push(x, y, z); nor.push(0, ny, 0); uv.push(u, v);
    }
    // CCW seen from +y for the top plane, from -y for the bottom one
    if (ny > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  quad(yTop, 1);
  quad(yBot, -1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * The decking boards' groove map: a tiny canvas, near-white with GROOVES
 * darker lines, multiplied onto deckColor. On a board's top face u runs
 * along x (the board's length) and v across it, so the lines are ROWS of the
 * canvas and the grooves run the length of the board.
 *
 * NODE / NO-DOM BUILDS: returns null (no `document`), and the boards are
 * plain deckColor -- the same fallback as wall-panels.js's grain map. The
 * mesh is marked `keep` either way, so a finish-bucket merge never strips
 * the map.
 *
 * @param {Object} THREE
 * @returns {?THREE.CanvasTexture}
 */
function makeGrooveMap(THREE) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const w = 4, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#8a8a8a';
  for (let i = 0; i < GROOVES; i++) ctx.fillRect(0, Math.round((i + 0.5) * h / GROOVES), w, 2);
  const tex = new THREE.CanvasTexture(c);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Board z-intervals (cm) across [z0, z1]: as many boards of about `bw` with
 * `gap` between them as fit, widened evenly so the first starts at z0 and
 * the last ends at z1. At least one board.
 */
function boardSpans(z0, z1, bw, gap) {
  const L = z1 - z0;
  const n = Math.max(1, Math.round((L + gap) / (bw + gap)));
  const b = (L - (n - 1) * gap) / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push([z0 + i * (b + gap), z0 + i * (b + gap) + b]);
  return out;
}

function resolveParams(params) {
  return Object.assign({}, DEFAULTS, params || {});
}
const num = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sideMode = v => (v === 'solid' || v === 'none' ? v : 'railing');

/**
 * Many axis-aligned boxes in ONE indexed BufferGeometry (position, normal, uv).
 * `boxes` are [cx, cy, cz, sx, sy, sz] in metres. `open` drops the top and
 * bottom faces (8 triangles per box instead of 12).
 */
function boxesGeometry(THREE, boxes, open) {
  const pos = [], nor = [], uv = [], idx = [];
  // each face: normal, then its four corners as sign triples (CCW from outside)
  const FACES = [
    [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
    [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]]
  ];
  for (const [cx, cy, cz, sx, sy, sz] of boxes) {
    for (const [n, corners] of FACES) {
      if (open && n[1] !== 0) continue;
      const base = pos.length / 3;
      corners.forEach(([a, b, c], i) => {
        pos.push(cx + a * sx / 2, cy + b * sy / 2, cz + c * sz / 2);
        nor.push(n[0], n[1], n[2]);
        uv.push(i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0);
      });
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Bar centres along a clear span [a, b] (cm) so no clear gap between
 * neighbours -- or between the span's ends and the first/last bar -- exceeds
 * `gap`, spread evenly.
 */
function barCentres(a, b, bar, gap) {
  const L = b - a;
  if (L <= gap) return [];
  const k = Math.max(0, Math.ceil((L - gap) / (gap + bar)));
  const g = (L - k * bar) / (k + 1);
  const out = [];
  for (let i = 0; i < k; i++) out.push(a + g * (i + 1) + bar * i + bar / 2);
  return out;
}

/**
 * Build the balcony.
 * @param {Object} THREE
 * @param {Object} [params]  overrides for DEFAULTS
 * @param {{detail?: 'full'|'low'}} [opts]  'low' keeps every second bar,
 *   without end caps
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const p = resolveParams(params);
  const full = !(opts && opts.detail === 'low');

  const W = Math.max(10, num(p.width, DEFAULTS.width));
  const D = Math.max(10, num(p.depth, DEFAULTS.depth));
  const H = Math.max(10, num(p.height, DEFAULTS.height));
  const slabT = clamp(num(p.slabThickness, DEFAULTS.slabThickness), 1, H * 0.5);
  const rt = clamp(num(p.railingThickness, DEFAULTS.railingThickness), 1, Math.min(W, D) / 4);
  const bar = Math.min(BAR, rt);
  const railH = Math.min(TOP_RAIL_H, (H - slabT) * 0.2);
  const barTop = H - railH;
  const botY = slabT + Math.min(BOTTOM_RAIL_UP, (H - slabT) * 0.1);
  const botH = Math.min(BOTTOM_RAIL_H, (H - slabT) * 0.08);
  // clear gap: never above MAX_GAP, never below 1 cm
  const gap = clamp(num(p.barSpacing, DEFAULTS.barSpacing) - bar, 1, MAX_GAP);
  const glass = p.railing === 'glass';
  const left = sideMode(p.leftSide), right = sideMode(p.rightSide);
  const floor = p.floor === 'slab' || p.floor === 'decking' ? p.floor : 'grating';
  const decking = floor === 'decking';
  const grating = floor === 'grating';

  const group = new THREE.Group();
  group.name = 'furniture:balcony';

  const mats = {
    slab: grating ? makeFinish(THREE, 'satin', p.gratingColor)
      : makeFinish(THREE, 'matte', decking ? (full ? DECK_UNDER : p.deckColor) : p.slabColor),
    rail: makeFinish(THREE, 'metal', p.railColor),
    solid: makeFinish(THREE, 'matte', p.solidColor),
    glass: makeFinish(THREE, 'glass', p.glassColor)
  };

  function add(geo, mat, name, data) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = mat.userData.finish !== 'glass';
    mesh.receiveShadow = true;
    Object.assign(mesh.userData, data || {});
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
    return mesh;
  }
  // [cx, cy, cz, sx, sy, sz] in metres from cm extents
  const box = (x0, x1, y0, y1, z0, z1) =>
    [(x0 + x1) / 2 * CM, (y0 + y1) / 2 * CM, (z0 + z1) / 2 * CM, (x1 - x0) * CM, (y1 - y0) * CM, (z1 - z0) * CM];
  const addBoxes = (boxes, mat, name, data, open) => {
    if (boxes.length) add(boxesGeometry(THREE, boxes, !!open), mat, name, data);
  };

  // ---- slab / deck ---------------------------------------------------------
  if (grating && full) {
    // perimeter frame round all four edges, slab bottom to deck top; the
    // grating fills the inside, its top flush with the frame top (they meet
    // edge to edge, never overlap, so no two top faces coincide)
    const fw = Math.min(FRAME_W, rt, D / 4, W / 4);
    const gt = Math.min(GRATE_T, slabT * 0.5);
    addBoxes([
      box(-W / 2, W / 2, 0, slabT, D - fw, D),            // front
      box(-W / 2, W / 2, 0, slabT, 0, fw),                // back, at the building face
      box(-W / 2, -W / 2 + fw, 0, slabT, fw, D - fw),     // left end
      box(W / 2 - fw, W / 2, 0, slabT, fw, D - fw),       // right end
      // one support beam along x at mid-depth, just under the bars
      box(-W / 2 + fw, W / 2 - fw, 0, slabT - gt - 0.5, D / 2 - fw / 2, D / 2 + fw / 2)
    ], mats.rail, 'grating-frame', { part: 'frame' });
    const pitch = clamp(num(p.gratingPitch, DEFAULTS.gratingPitch), 1, 10);
    const gm = makeFinish(THREE, 'satin', p.gratingColor);
    gm.map = makeGratingMap(THREE);
    gm.alphaTest = GRATING_ALPHA_TEST;
    gm.side = THREE.DoubleSide;
    const geo = gratingGeometry(THREE, (-W / 2 + fw) * CM, (W / 2 - fw) * CM, fw * CM, (D - fw) * CM,
      slabT * CM, (slabT - gt) * CM, pitch);
    const gr = add(geo, gm, 'grating', { part: 'grating', pitch, crossPitch: CROSS_PITCH });
    gr.userData.keep = true; // the cutout map must survive any finish-bucket merge
  } else if (decking && full) {
    // structure under the boards, full footprint; the boards sit on it, inset
    // from the front and the ends by the trim so no two top faces coincide
    const bt = Math.min(BOARD_T, slabT * 0.5);
    const trim = Math.min(TRIM_T, rt);
    addBoxes([box(-W / 2, W / 2, 0, slabT - bt, 0, D)], mats.slab, 'slab', { part: 'slab' });
    const bw = clamp(num(p.boardWidth, DEFAULTS.boardWidth), 2, 60);
    const bgap = clamp(num(p.boardGap, DEFAULTS.boardGap), 0, 5);
    const boards = boardSpans(0, D - trim, bw, bgap)
      .map(([z0, z1]) => box(-W / 2 + trim, W / 2 - trim, slabT - bt, slabT, z0, z1));
    const deckMat = makeFinish(THREE, 'matte', p.deckColor);
    const map = makeGrooveMap(THREE);
    if (map) deckMat.map = map;
    const deck = add(boxesGeometry(THREE, boards, false), deckMat, 'deck-boards', { part: 'deck', boards: boards.length });
    deck.userData.keep = true; // the groove map must survive any finish-bucket merge
    // dark metal edge trim: front, then the two ends, slab bottom to deck top
    addBoxes([
      box(-W / 2, W / 2, 0, slabT, D - trim, D),
      box(-W / 2, -W / 2 + trim, 0, slabT, 0, D - trim),
      box(W / 2 - trim, W / 2, 0, slabT, 0, D - trim)
    ], mats.rail, 'edge-trim', { part: 'trim' });
  } else {
    addBoxes([box(-W / 2, W / 2, 0, slabT, 0, D)], mats.slab, 'slab', { part: 'slab' });
  }

  // ---- one balustrade run ------------------------------------------------
  // `along` 'x' (the front, at z = D) or 'z' (a side, at x = xc). The span
  // [a, b] is the CLEAR span between whatever bounds it (posts, the
  // building face, a solid side).
  function run(runName, along, a, b, fixed) {
    const data = { run: runName };
    const onRun = (s0, s1, y0, y1, t) => along === 'x'
      ? box(s0, s1, y0, y1, fixed - t / 2, fixed + t / 2)
      : box(fixed - t / 2, fixed + t / 2, y0, y1, s0, s1);
    const rails = [onRun(a, b, barTop, H, rt)];
    if (!glass) rails.push(onRun(a, b, botY, botY + botH, rt * 0.6));
    addBoxes(rails, mats.rail, runName + '-rails', Object.assign({ role: 'rail' }, data));
    if (glass) {
      // low: one pane per run and no intermediate posts
      const n = full ? Math.max(1, Math.ceil((b - a) / GLASS_PANEL_MAX)) : 1;
      const post = Math.min(4, rt);
      const step = (b - a) / n;
      const posts = [], panes = [];
      for (let i = 1; i < n; i++) {
        const c = a + step * i;
        posts.push(onRun(c - post / 2, c + post / 2, slabT, barTop, post));
      }
      for (let i = 0; i < n; i++) {
        const s0 = a + step * i + (i > 0 ? post / 2 + 1 : 1);
        const s1 = a + step * (i + 1) - (i < n - 1 ? post / 2 + 1 : 1);
        if (s1 > s0) panes.push(onRun(s0, s1, slabT + 3, barTop - 1, Math.min(GLASS_T, rt)));
      }
      addBoxes(posts, mats.rail, runName + '-posts', Object.assign({ role: 'post', vertical: true }, data));
      addBoxes(panes, mats.glass, runName + '-glass', Object.assign({ role: 'glass' }, data));
    } else {
      let cs = barCentres(a, b, bar, gap);
      if (!full) cs = cs.filter((_, i) => i % 2 === 0);
      const bars = cs.map(c => onRun(c - bar / 2, c + bar / 2, slabT, barTop, bar));
      addBoxes(bars, mats.rail, runName + '-bars', Object.assign({ role: 'bar', vertical: true }, data), !full);
    }
  }

  // ---- sides ---------------------------------------------------------------
  // Each side occupies x in [edge - rt, edge] (or its mirror) from the
  // building face back to the front railing.
  const sides = { left: { mode: left, sign: -1 }, right: { mode: right, sign: 1 } };
  for (const [name, s] of Object.entries(sides)) {
    const outer = s.sign * W / 2, inner = s.sign * (W / 2 - rt);
    const x0 = Math.min(outer, inner), x1 = Math.max(outer, inner);
    if (s.mode === 'solid') {
      addBoxes([box(x0, x1, slabT, H, 0, D)], mats.solid, name + '-solid', { run: name, role: 'solid', side: name });
    } else if (s.mode === 'railing') {
      run(name, 'z', 0, D - rt, (x0 + x1) / 2);
      // tag the side's meshes for callers/tests
      group.children.forEach(m => { if (m.userData.run === name) m.userData.side = name; });
    }
  }

  // ---- front run -----------------------------------------------------------
  // Corner posts at each end (inside a solid side there is none: the panel
  // is the end). The front top rail stops at a solid panel's inner face.
  const lEnd = left === 'solid' ? -W / 2 + rt : -W / 2;
  const rEnd = right === 'solid' ? W / 2 - rt : W / 2;
  const corners = [];
  if (left !== 'solid') corners.push(box(-W / 2, -W / 2 + rt, slabT, H, D - rt, D));
  if (right !== 'solid') corners.push(box(W / 2 - rt, W / 2, slabT, H, D - rt, D));
  addBoxes(corners, mats.rail, 'front-corner-posts', { run: 'front', role: 'post', vertical: true });
  const a = left === 'solid' ? lEnd : -W / 2 + rt;
  const b = right === 'solid' ? rEnd : W / 2 - rt;
  run('front', 'x', a, b, D - rt / 2);

  group.userData = { type: TYPE, params: p, detail: full ? 'full' : 'low' };
  return group;
}

export const buildBalcony = build;

/** Only the params that differ from DEFAULTS -- the furniture JSON shape. */
export function toFurnitureJSON(params) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (params && params[k] !== undefined && params[k] !== DEFAULTS[k]) out[k] = params[k];
  }
  return { type: TYPE, params: out };
}

// ---- edit-mode controls ---------------------------------------------------------
// Ranges, steps, options and labels are copied from the spec page (see controls.js).
export const CONTROLS = [
  range('width', 'Width (along facade)', 120, 800, 1, 'cm'),
  range('depth', 'Depth', 60, 300, 1, 'cm'),
  range('height', 'Height (slab + railing)', 60, 150, 1, 'cm'),
  range('slabThickness', 'Slab thickness', 5, 30, 1, 'cm'),
  select('floor', 'Floor', ['grating', 'decking', 'slab']),
  range('gratingPitch', 'Grating pitch', 1, 10, 0.5, 'cm'),
  range('boardWidth', 'Board width', 8, 30, 0.5, 'cm'),
  range('boardGap', 'Board gap', 0, 2, 0.1, 'cm'),
  select('railing', 'Railing', ['bars', 'glass']),
  range('railingThickness', 'Rail thickness', 2, 10, 0.5, 'cm'),
  range('barSpacing', 'Bar spacing', 5, 20, 0.5, 'cm'),
  select('leftSide', 'Left end', ['railing', 'solid', 'none']),
  select('rightSide', 'Right end', ['railing', 'solid', 'none']),
  color('gratingColor', 'Grating'),
  color('deckColor', 'Decking boards'),
  color('slabColor', 'Slab (plain floor)'),
  color('railColor', 'Rails and bars (metal)'),
  color('solidColor', 'Solid end panel'),
  color('glassColor', 'Glass'),
];
