/**
 * dog-crate.js - single-type module: `dog-crate`.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0, and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js). No lights.
 *     ONE exception to "no textures": the wire mesh's alpha-cutout map
 *     (makeWireMap, a DataTexture, so it exists under Node too and is
 *     unit-tested) on a `keep` mesh -- the same technique as the balcony
 *     grating (balcony.js).
 *   - bbox == params.width/depth/height within 0.5 cm for ANY params.
 * See docs/house-profile.md, "Furniture".
 *
 * A folding two-door wire dog crate: `width` is the crate's LENGTH (the long
 * side runs along x), `depth` its width front to back, `height` floor to the
 * top. The defaults are a common 42-inch two-door crate.
 *
 *   wire      black epoxy-coated wire mesh on every side and the top: vertical
 *             wires every `wirePitch` cm along each panel, horizontal wires
 *             every `rowPitch` cm up it. Each panel is ONE textured plane
 *             with an alpha-cutout map (two triangles), not a cylinder per
 *             wire, so the whole cage is a handful of triangles. The four top
 *             edges are rounded (radius TOP_R) like a real crate's bent wire
 *             frame, as quarter-cylinder strips that meet mitred at the
 *             corners, carrying the same mesh. The vertical wires run on
 *             over the rounded long edges and across the top.
 *   frame     heavier wire rods (FRAME_T) round the panel edges: four corner
 *             posts, a bottom and a top rail round the sides, and a rail
 *             round the flat top, in wireColor.
 *   doors     `sideDoor` on the FRONT long side, placed toward the 'left' or
 *             'right' end (or 'none'); `endDoor` on the 'left' (-x) or
 *             'right' (+x) end (or 'none'). A door is its own rod frame on
 *             the panel, with two slide-bolt latches on its free edge (the
 *             side door's latches face the crate's middle; the end door's
 *             face the front).
 *   pan       a black plastic tray the full footprint, PAN_H tall: its rim is
 *             the black band round the base, and its top is the crate's floor.
 *   handle    one carry handle on the front, near the top, over the longest
 *             stretch of the front the side door leaves free.
 *   cover     OPTIONAL, off by default: a fabric crate cover over the top,
 *             back and both ends, down to the floor, with the front flap
 *             rolled up above the side door (or the middle, with no side
 *             door). With the cover on it IS the envelope and the pan sits
 *             inside the wire.
 *
 * The cage is inset CAGE_INSET from the envelope on every side, so the
 * latches and the handle (which stand proud of the wire) and the pan rim stay
 * inside width x depth. Low detail: the pan, the five flat mesh planes (no
 * rounded edges) and no rods, latches or handle; the cover, if on, as the
 * same few boxes.
 */
import { makeFinish } from './finishes.js';
import { range, color, select, toggle } from './controls.js';

export const TYPE = 'dog-crate';

/** Defaults, in cm. */
export const DEFAULTS = Object.freeze({
  width: 109,              // the crate's length, along x (a 42-inch crate with its latches)
  depth: 72,
  height: 76,
  wirePitch: 2.5,          // cm, vertical-wire centre spacing along a panel
  rowPitch: 5,             // cm, horizontal-wire centre spacing up a panel
  sideDoor: 'right',       // 'left' | 'right' | 'none' -- on the front long side
  endDoor: 'left',         // 'left' | 'right' | 'none' -- on that end (-x / +x)
  cover: false,            // an optional fabric cover (off: the bare wire crate)
  wireColor: '#1b1b1d',    // black epoxy-coated wire
  panColor: '#141415',     // black plastic tray
  handleColor: '#1f1f21',  // black plastic handle
  coverColor: '#2a2a2d'    // the optional cover's fabric
});

const CM = 0.01;
const CAGE_INSET = 1;      // cm, the cage's inset from the envelope on every side
const PAN_H = 3.5;         // cm, the tray's rim height (typical; not measured)
const TOP_R = 3.5;         // cm, the rounded top edges' radius (typical; not measured)
const ARC_SEG = 3;         // segments per rounded edge at full detail
const FRAME_T = 0.6;       // cm, the frame rods' section
const LATCH_PROUD = 0.85;  // cm, how far a latch / the handle stands off the wire (< CAGE_INSET)
const COVER_T = 0.6;       // cm, the cover's thickness
const DOOR_W_FRAC = 0.55;  // side door width as a share of the cage length (capped)
const DOOR_W_MAX = 62;     // cm
const END_DOOR_FRAC = 0.7; // end door width as a share of the cage depth
const DOOR_H_FRAC = 0.8;   // door height as a share of the cage height above the pan
const DOOR_END_GAP = 8;    // cm, from the side door to its end of the crate
// The wire tile: one wirePitch across (u) by one rowPitch up (v).
// Power-of-two so it can repeat and mip.
const TILE_U = 16, TILE_V = 32;
const V_WIRE_PX = 2;       // ~0.31 cm of a 2.5 cm pitch
const H_WIRE_PX = 2;       // ~0.31 cm of a 5 cm pitch
export const WIRE_ALPHA_TEST = 0.5;

/**
 * The wire mesh's alpha-cutout tile as RGBA bytes, TILE_U x TILE_V, plus its
 * mip chain. RGB is white (the colour comes from wireColor); alpha is 255 on
 * a wire and 0 in a hole. Columns 0 .. V_WIRE_PX-1 are the vertical wire
 * (running along v), rows 0 .. H_WIRE_PX-1 the horizontal wire.
 *
 * MAX-ALPHA MIPS, as the balcony grating: an averaged mip of a ~80 % open
 * mesh drops below the alpha test within a level or two and the crate would
 * VANISH at a distance. Max-alpha closes the holes instead, so from far away
 * it reads as a dark box.
 *
 * @returns {{levels: Array<{data: Uint8Array, width: number, height: number}>}}
 */
export function wireTile() {
  const level0 = new Uint8Array(TILE_U * TILE_V * 4);
  for (let v = 0; v < TILE_V; v++) {
    for (let u = 0; u < TILE_U; u++) {
      const i = (v * TILE_U + u) * 4;
      const wire = u < V_WIRE_PX || v < H_WIRE_PX;
      level0[i] = level0[i + 1] = level0[i + 2] = 255;
      level0[i + 3] = wire ? 255 : 0;
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

/** The wire mesh's alpha-cutout map: a repeating DataTexture of wireTile() with its max-alpha mips. */
function makeWireMap(THREE) {
  const { levels } = wireTile();
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

function resolveParams(params) {
  return Object.assign({}, DEFAULTS, params || {});
}
const num = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sideOf = (v, fb) => (v === 'left' || v === 'right' || v === 'none' ? v : fb);

/**
 * Many axis-aligned boxes in ONE indexed BufferGeometry (position, normal,
 * uv). `boxes` are [x0, x1, y0, y1, z0, z1] in cm.
 */
function boxesGeometry(THREE, boxes) {
  const pos = [], nor = [], uv = [], idx = [];
  const FACES = [
    [[1, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]]
  ];
  for (const [x0, x1, y0, y1, z0, z1] of boxes) {
    for (const [n, corners] of FACES) {
      const base = pos.length / 3;
      corners.forEach(([a, b, c], i) => {
        pos.push((a ? x1 : x0) * CM, (b ? y1 : y0) * CM, (c ? z1 : z0) * CM);
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
 * The layout every part is placed from, in cm: the cage box, the doors, the
 * handle. Exported for the tests and the spec page's numbers.
 */
export function layout(params) {
  const p = resolveParams(params);
  const W = Math.max(30, num(p.width, DEFAULTS.width));
  const D = Math.max(25, num(p.depth, DEFAULTS.depth));
  const H = Math.max(25, num(p.height, DEFAULTS.height));
  const cover = p.cover === true;
  const xl = -W / 2 + CAGE_INSET, xr = W / 2 - CAGE_INSET;
  const zb = CAGE_INSET, zf = D - CAGE_INSET;
  const yb = 0.5;                              // the cage's bottom wires, inside the pan
  const yt = cover ? H - COVER_T - 0.2 : H;    // the cage top (under the cover's top)
  const r = Math.min(TOP_R, (yt - PAN_H) / 4, (zf - zb) / 4, (xr - xl) / 4);
  const L = xr - xl, Dc = zf - zb;
  const doorH = (yt - r - PAN_H) * DOOR_H_FRAC;
  const doorY0 = PAN_H + 0.3, doorY1 = doorY0 + doorH;
  const sideDoor = sideOf(p.sideDoor, DEFAULTS.sideDoor);
  const endDoor = sideOf(p.endDoor, DEFAULTS.endDoor);
  let side = null;
  if (sideDoor !== 'none') {
    const w = Math.min(DOOR_W_MAX, L * DOOR_W_FRAC);
    const gap = Math.min(DOOR_END_GAP, (L - w) / 2);
    const x0 = sideDoor === 'right' ? xr - gap - w : xl + gap;
    // hinged at its end-of-crate edge; the latches are on the edge toward the middle
    side = { x0, x1: x0 + w, y0: doorY0, y1: doorY1, latchX: sideDoor === 'right' ? x0 : x0 + w };
  }
  let end = null;
  if (endDoor !== 'none') {
    const w = Dc * END_DOOR_FRAC;
    const z0 = zb + (Dc - w) / 2;
    end = { x: endDoor === 'left' ? xl : xr, sign: endDoor === 'left' ? -1 : 1, z0, z1: z0 + w, y0: doorY0, y1: doorY1, latchZ: z0 + w };
  }
  // the handle: centred on the longest stretch of the front the side door leaves free
  const spans = side ? [[xl, side.x0], [side.x1, xr]] : [[xl, xr]];
  const best = spans.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  const hw = Math.min(14, (best[1] - best[0]) * 0.6);
  const handle = hw >= 4 ? { x0: (best[0] + best[1]) / 2 - hw / 2, x1: (best[0] + best[1]) / 2 + hw / 2, y: yt - r - 5 } : null;
  return { W, D, H, cover, xl, xr, zb, zf, yb, yt, r, side, end, handle, doorH };
}

/**
 * The wire mesh as ONE geometry (cm in, metres out): the four side panels up
 * to yt - r, the top inset by r, and (full detail) the four rounded top edges
 * as quarter-cylinder strips mitred at the corners. With `round` false (low
 * detail) the sides run to yt and the top is the full cage plan.
 *
 * UVs are in TILES: along a panel u = distance / wirePitch, up it v =
 * height / rowPitch, so a vertical wire every wirePitch and a horizontal one
 * every rowPitch. On a long-edge strip u keeps x / wirePitch (the vertical
 * wires run on over the edge) and v runs on up the arc.
 */
function wireGeometry(THREE, L, pitch, rowPitch, round) {
  const { xl, xr, zb, zf, yb, yt } = L;
  const r = round ? L.r : 0;
  const pos = [], nor = [], uv = [], idx = [];
  const vert = (x, y, z, n, u, v) => { pos.push(x * CM, y * CM, z * CM); nor.push(n[0], n[1], n[2]); uv.push(u, v); };
  const quad = (a, b, c, d) => {
    // a..d are [x, y, z, u, v, n]; CCW seen from the normal side
    const base = pos.length / 3;
    for (const q of [a, b, c, d]) vert(q[0], q[1], q[2], q[5], q[3], q[4]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const ys = yt - r;
  const U = s => s / pitch, V = s => s / rowPitch;
  // back (normal -z) and front (+z)
  quad([xr, yb, zb, U(xr), V(yb), [0, 0, -1]], [xl, yb, zb, U(xl), V(yb), [0, 0, -1]], [xl, ys, zb, U(xl), V(ys), [0, 0, -1]], [xr, ys, zb, U(xr), V(ys), [0, 0, -1]]);
  quad([xl, yb, zf, U(xl), V(yb), [0, 0, 1]], [xr, yb, zf, U(xr), V(yb), [0, 0, 1]], [xr, ys, zf, U(xr), V(ys), [0, 0, 1]], [xl, ys, zf, U(xl), V(ys), [0, 0, 1]]);
  // left (-x) and right (+x) ends
  quad([xl, yb, zb, U(zb), V(yb), [-1, 0, 0]], [xl, yb, zf, U(zf), V(yb), [-1, 0, 0]], [xl, ys, zf, U(zf), V(ys), [-1, 0, 0]], [xl, ys, zb, U(zb), V(ys), [-1, 0, 0]]);
  quad([xr, yb, zf, U(zf), V(yb), [1, 0, 0]], [xr, yb, zb, U(zb), V(yb), [1, 0, 0]], [xr, ys, zb, U(zb), V(ys), [1, 0, 0]], [xr, ys, zf, U(zf), V(ys), [1, 0, 0]]);
  // top (+y), inset by r
  quad([xl + r, yt, zf - r, U(xl + r), V(zf - r), [0, 1, 0]], [xr - r, yt, zf - r, U(xr - r), V(zf - r), [0, 1, 0]],
    [xr - r, yt, zb + r, U(xr - r), V(zb + r), [0, 1, 0]], [xl + r, yt, zb + r, U(xl + r), V(zb + r), [0, 1, 0]]);
  if (r > 0) {
    // Each strip at arc angle t (0 = on the side, PI/2 = on the top) is inset
    // d = r - r cos t from the side face and d along it at both ends, so two
    // strips meeting at a corner share the mitre line exactly.
    const arcV = t => V(ys + r * t);
    for (let s = 0; s < ARC_SEG; s++) {
      const t0 = (s / ARC_SEG) * Math.PI / 2, t1 = ((s + 1) / ARC_SEG) * Math.PI / 2;
      const d0 = r - r * Math.cos(t0), d1 = r - r * Math.cos(t1);
      const y0 = ys + r * Math.sin(t0), y1 = ys + r * Math.sin(t1);
      const tm = (t0 + t1) / 2, c = Math.cos(tm), sn = Math.sin(tm);
      // back edge: outward normal (0, sin, -cos)
      quad([xr - d0, y0, zb + d0, U(xr - d0), arcV(t0), [0, sn, -c]], [xl + d0, y0, zb + d0, U(xl + d0), arcV(t0), [0, sn, -c]],
        [xl + d1, y1, zb + d1, U(xl + d1), arcV(t1), [0, sn, -c]], [xr - d1, y1, zb + d1, U(xr - d1), arcV(t1), [0, sn, -c]]);
      // front edge
      quad([xl + d0, y0, zf - d0, U(xl + d0), arcV(t0), [0, sn, c]], [xr - d0, y0, zf - d0, U(xr - d0), arcV(t0), [0, sn, c]],
        [xr - d1, y1, zf - d1, U(xr - d1), arcV(t1), [0, sn, c]], [xl + d1, y1, zf - d1, U(xl + d1), arcV(t1), [0, sn, c]]);
      // left end
      quad([xl + d0, y0, zb + d0, U(zb + d0), arcV(t0), [-c, sn, 0]], [xl + d0, y0, zf - d0, U(zf - d0), arcV(t0), [-c, sn, 0]],
        [xl + d1, y1, zf - d1, U(zf - d1), arcV(t1), [-c, sn, 0]], [xl + d1, y1, zb + d1, U(zb + d1), arcV(t1), [-c, sn, 0]]);
      // right end
      quad([xr - d0, y0, zf - d0, U(zf - d0), arcV(t0), [c, sn, 0]], [xr - d0, y0, zb + d0, U(zb + d0), arcV(t0), [c, sn, 0]],
        [xr - d1, y1, zb + d1, U(zb + d1), arcV(t1), [c, sn, 0]], [xr - d1, y1, zf - d1, U(zf - d1), arcV(t1), [c, sn, 0]]);
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
 * Build the crate.
 * @param {Object} THREE
 * @param {Object} [params]  overrides for DEFAULTS
 * @param {{detail?: 'full'|'low'}} [opts]
 * @returns {THREE.Group}
 */
export function build(THREE, params, opts) {
  const p = resolveParams(params);
  const full = !(opts && opts.detail === 'low');
  const L = layout(p);
  const { W, D, H, xl, xr, zb, zf, yb, yt, r } = L;
  const pitch = clamp(num(p.wirePitch, DEFAULTS.wirePitch), 1, 10);
  const rowPitch = clamp(num(p.rowPitch, DEFAULTS.rowPitch), 1, 15);

  const group = new THREE.Group();
  group.name = 'furniture:dog-crate';

  function add(geo, mat, name, data) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    Object.assign(mesh.userData, data || {});
    group.add(mesh);
    return mesh;
  }
  const wireMat = makeFinish(THREE, 'satin', p.wireColor);

  // ---- pan -----------------------------------------------------------------
  // Full footprint (it is the envelope's base); inside the wire under a cover.
  const pi = L.cover ? CAGE_INSET + 0.2 : 0;
  add(boxesGeometry(THREE, [[-W / 2 + pi, W / 2 - pi, 0, PAN_H, pi, D - pi]]),
    makeFinish(THREE, 'matte', p.panColor), 'pan', { part: 'pan' });

  // ---- wire mesh -------------------------------------------------------------
  const mm = makeFinish(THREE, 'satin', p.wireColor);
  mm.map = makeWireMap(THREE);
  mm.alphaTest = WIRE_ALPHA_TEST;
  mm.side = THREE.DoubleSide;
  const mesh = add(wireGeometry(THREE, L, pitch, rowPitch, full), mm, 'wire-mesh', { part: 'wire', pitch, rowPitch });
  mesh.userData.keep = true; // the cutout map must survive any finish-bucket merge

  if (full) {
    // ---- frame rods ----------------------------------------------------------
    const t = FRAME_T, h = t / 2, ys = yt - r;
    const rods = [
      // corner posts
      [xl - h, xl + h, yb, ys, zb - h, zb + h], [xr - h, xr + h, yb, ys, zb - h, zb + h],
      [xl - h, xl + h, yb, ys, zf - h, zf + h], [xr - h, xr + h, yb, ys, zf - h, zf + h],
      // bottom rails (just above the pan rim) and top-of-side rails, round the four sides
      ...[PAN_H + 0.4, ys - t].flatMap(y => [
        [xl + h, xr - h, y, y + t, zb - h, zb + h], [xl + h, xr - h, y, y + t, zf - h, zf + h],
        [xl - h, xl + h, y, y + t, zb + h, zf - h], [xr - h, xr + h, y, y + t, zb + h, zf - h]
      ]),
      // the flat top's rail, just under the top plane (never sharing its plane)
      [xl + r, xr - r, yt - t - 0.1, yt - 0.1, zb + r - h, zb + r + h], [xl + r, xr - r, yt - t - 0.1, yt - 0.1, zf - r - h, zf - r + h],
      [xl + r - h, xl + r + h, yt - t - 0.1, yt - 0.1, zb + r + h, zf - r - h], [xr - r - h, xr - r + h, yt - t - 0.1, yt - 0.1, zb + r + h, zf - r - h]
    ];
    // door frames, standing just proud of the wire (outside it)
    const doors = [];
    if (L.side) {
      const s = L.side, z0 = zf, z1 = zf + t;
      doors.push([s.x0, s.x0 + t, s.y0, s.y1, z0, z1], [s.x1 - t, s.x1, s.y0, s.y1, z0, z1],
        [s.x0 + t, s.x1 - t, s.y0, s.y0 + t, z0, z1], [s.x0 + t, s.x1 - t, s.y1 - t, s.y1, z0, z1]);
    }
    if (L.end) {
      const e = L.end, x0 = e.sign < 0 ? xl - t : xr, x1 = x0 + t;
      doors.push([x0, x1, e.y0, e.y1, e.z0, e.z0 + t], [x0, x1, e.y0, e.y1, e.z1 - t, e.z1],
        [x0, x1, e.y0, e.y0 + t, e.z0 + t, e.z1 - t], [x0, x1, e.y1 - t, e.y1, e.z0 + t, e.z1 - t]);
    }
    add(boxesGeometry(THREE, rods), wireMat, 'frame', { part: 'frame', rods: rods.length });
    if (doors.length) add(boxesGeometry(THREE, doors), wireMat, 'door-frames', { part: 'doors', doors: doors.length / 4 });

    // ---- latches: two slide bolts on each door's free edge ---------------------
    const latches = [];
    const lh = 1.2, ll = 3.2, P = LATCH_PROUD;
    if (L.side) {
      const s = L.side;
      for (const f of [0.25, 0.75]) {
        const y = s.y0 + (s.y1 - s.y0) * f;
        latches.push([s.latchX - ll / 2, s.latchX + ll / 2, y - lh / 2, y + lh / 2, zf, zf + P]);
      }
    }
    if (L.end) {
      const e = L.end;
      const x0 = e.sign < 0 ? xl - P : xr, x1 = x0 + P;
      for (const f of [0.25, 0.75]) {
        const y = e.y0 + (e.y1 - e.y0) * f;
        latches.push([x0, x1, y - lh / 2, y + lh / 2, e.latchZ - ll / 2, e.latchZ + ll / 2]);
      }
    }
    if (latches.length) add(boxesGeometry(THREE, latches), makeFinish(THREE, 'metal', p.wireColor), 'latches', { part: 'latch', latches: latches.length });

    // ---- carry handle: a grip on two short stand-offs --------------------------
    if (L.handle) {
      const hd = L.handle, y = hd.y;
      add(boxesGeometry(THREE, [
        [hd.x0, hd.x1, y, y + 1.6, zf + 0.35, zf + P],
        [hd.x0, hd.x0 + 1.2, y, y + 1.6, zf, zf + 0.35],
        [hd.x1 - 1.2, hd.x1, y, y + 1.6, zf, zf + 0.35]
      ]), makeFinish(THREE, 'matte', p.handleColor), 'handle', { part: 'handle' });
    }
  }

  // ---- optional cover ----------------------------------------------------------
  if (L.cover) {
    const c = COVER_T;
    const op = L.side ? [L.side.x0, L.side.x1] : [-W / 6, W / 6];
    const opTop = L.side ? L.side.y1 : H * 0.7;
    const roll = Math.min(5, H - opTop - c - 1);
    const pieces = [
      [-W / 2, W / 2, H - c, H, 0, D],                  // top
      [-W / 2, W / 2, 0, H - c, 0, c],                  // back
      [-W / 2, -W / 2 + c, 0, H - c, c, D],             // left end
      [W / 2 - c, W / 2, 0, H - c, c, D],               // right end
      [-W / 2 + c, op[0], 0, H - c, D - c, D],          // front, left of the opening
      [op[1], W / 2 - c, 0, H - c, D - c, D],           // front, right of the opening
      [op[0], op[1], opTop + roll, H - c, D - c, D]     // front, above the rolled flap
    ];
    const cm = makeFinish(THREE, 'matte', p.coverColor);
    add(boxesGeometry(THREE, pieces), cm, 'cover', { part: 'cover' });
    // the rolled-up flap: a thicker roll across the top of the opening
    if (roll > 0) add(boxesGeometry(THREE, [[op[0], op[1], opTop, opTop + roll, D - Math.min(3.5, D / 4), D]]), cm, 'cover-roll', { part: 'cover' });
  }

  group.userData = { type: TYPE, params: p, detail: full ? 'full' : 'low' };
  return group;
}

export const buildDogCrate = build;

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
  range('width', 'Length (width)', 50, 130, 1, 'cm'),
  range('depth', 'Depth', 35, 90, 1, 'cm'),
  range('height', 'Height', 35, 100, 1, 'cm'),
  range('wirePitch', 'Vertical-wire pitch', 1.5, 6, 0.1, 'cm'),
  range('rowPitch', 'Horizontal-wire pitch', 2, 12, 0.5, 'cm'),
  select('sideDoor', 'Side door', ['left', 'right', 'none']),
  select('endDoor', 'End door', ['left', 'right', 'none']),
  toggle('cover', 'Fabric cover'),
  color('wireColor', 'Wire'),
  color('panColor', 'Tray'),
  color('handleColor', 'Handle'),
  color('coverColor', 'Cover'),
];
