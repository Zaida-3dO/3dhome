/**
 * balcony.js - single-type module: `balcony`.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0, and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js). No lights, no
 *     textures.
 *   - bbox == params.width/depth/height within 0.5 cm for ANY params.
 * See docs/house-profile.md, "Furniture".
 *
 * A cantilevered balcony: a concrete slab and a balustrade. The BACK (z = 0)
 * is the building face; `width` runs along the facade and the front railing
 * runs along z = depth. `height` is slab bottom to rail top.
 *
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

export const TYPE = 'balcony';

/** Defaults, in cm. */
export const DEFAULTS = Object.freeze({
  width: 547,              // along the facade
  depth: 155,              // building face to the front of the railing
  height: 110,             // slab bottom to rail top
  slabThickness: 15,
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

  const group = new THREE.Group();
  group.name = 'furniture:balcony';

  const mats = {
    slab: makeFinish(THREE, 'matte', p.slabColor),
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

  // ---- slab --------------------------------------------------------------
  addBoxes([box(-W / 2, W / 2, 0, slabT, 0, D)], mats.slab, 'slab', { part: 'slab' });

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
