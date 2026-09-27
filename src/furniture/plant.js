/**
 * plant.js - procedural potted and wall-mounted plants.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0 and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 *   - bbox == params.width/depth/height within 0.5 cm (see
 *     scripts/test-furniture-core.mjs's checkContract()).
 * See docs/house-profile.md, "Furniture".
 *
 * KINDS (params.kind):
 *   'corn-plant'   Dracaena fragrans: an egg-shaped ribbed vase, three bare
 *                  canes of very different heights, each crowned by a TUFT
 *                  of long lanceolate leaves spiralling up its top ~35 cm
 *                  (upper leaves near-upright, lower ones arching and
 *                  drooping). DEFAULT.
 *   'wall-planter' a geometric wall planter: the ceramic is only the LOWER
 *                  half -- an inverted half-diamond with a flat back on the
 *                  wall, two front facets meeting at a vertical ridge and a
 *                  triangular open top -- and a thin brass wire traces every
 *                  edge and carries on upward as the open mirror image, so
 *                  the outline is a full diamond hung from its top apex.
 *                  `contents`: 'spiky' | 'succulent' | 'snake-plant'.
 *   'peace-lily'   broad glossy lance leaves on long arching stalks and one
 *                  white spathe, grown in WATER in a clear glass bubble vase
 *                  with the roots visible through the glass.
 *   'snake-plant'  a few stiff near-upright sword leaves with a pale margin.
 *   'pothos'       heart-shaped leaves. habit 'upright': on arching stems
 *                  above the pot. habit 'trailing': vines spill over the rim
 *                  and hang `trail` cm BELOW the pot base (see TRAIL below).
 *   'ficus'        a small tree: a short thick trunk splitting into a few
 *                  branches, each carrying clusters of small oval leaves.
 *   'jade'         a succulent: fleshy oval pads on short branching stems.
 *
 * POTS (params.potStyle) for every free-standing kind: 'egg' (tall, finely
 * ribbed), 'tapered', 'ribbed-footed' (fluted, on a foot), 'bowl' (squat,
 * on a saucer), 'cylinder', 'glass-bubble' (clear; glass finish, kept).
 *
 * LEAVES are two-sided by DUPLICATED, REVERSED faces rather than a
 * DoubleSide material: the renderer's merge keys buckets by material side,
 * so a DoubleSide leaf would cost every room with a plant an extra draw,
 * and draws -- not triangles -- are the scarce resource.
 *
 * TRAIL. A trailing pothos's vines hang below its own pot, but the contract
 * puts the item's bottom at y = 0. So the pot stands at y = trail and the
 * vine tips reach y = 0; a placement puts `elevation` at the surface height
 * minus `trail` (e.g. a 90 cm speaker and trail 50 -> elevation 40).
 *
 * FITTING THE ENVELOPE EXACTLY: each kind is built once in a natural frame,
 * its raw bbox is measured, and one per-axis scale + translate lands the
 * result on exactly width x depth x height with the back at z = 0 and the
 * bottom at y = 0, whatever the seed. See fitToEnvelope(). Every part is
 * built with its transform BAKED into its geometry (no rotated children),
 * so that per-axis scale is exact.
 *
 * PROCEDURAL LAYOUT is driven by `seed` via mulberry32 -- the same seed
 * always lays out the same plant; no Math.random anywhere.
 *
 * Triangle caps (perf audit): corn-plant 800 / 300, wall-planter 400 / 150,
 * every other kind 600 / 200; 'low' <= 0.6 x 'full' whenever full > 300.
 */
import { makeFinish } from './finishes.js';

export const TYPE = 'plant';

export const KINDS = Object.freeze(['corn-plant', 'wall-planter', 'peace-lily', 'snake-plant', 'pothos', 'ficus', 'jade']);
export const POT_STYLES = Object.freeze(['egg', 'tapered', 'ribbed-footed', 'bowl', 'cylinder', 'glass-bubble']);
export const WALL_CONTENTS = Object.freeze(['spiky', 'succulent', 'snake-plant']);

// width/depth/height are the frozen DEFAULTS' bounding envelope, cm: the
// corn plant's crown spread (60) and its total height, pot included
// (potHeight + plantHeight = 56 + 110 = 166). A caller resizes the whole
// plant by overriding width/depth/height -- fitToEnvelope() makes that exact.
export const DEFAULTS = Object.freeze({
  kind: 'corn-plant',
  width: 60,
  depth: 60,
  height: 166,
  // pot (every free-standing kind)
  potStyle: 'egg',
  potHeight: 56,
  potTopDiameter: 30,
  potColor: '#a67c4e',
  // foliage proportioning (the envelope above still wins)
  plantHeight: 110,
  stemCount: 3,
  spread: 60,
  leafLength: 45,
  leafWidth: 6,
  leafCount: 5,
  leafColor: '#1f3a1c',
  accentColor: '#d8d3a8',
  habit: 'upright',
  trail: 0,
  // glass vase / wall planter
  glassColor: '#dcecef',
  frameColor: '#b8945a',
  contents: 'spiky',
  seed: 1,
});

const CM = 0.01;

/** mulberry32 -- tiny deterministic PRNG. Same seed -> same sequence, always. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rescale + translate every direct child of `group` so the group's bbox
 * becomes EXACTLY [x: -width/2..width/2, y: 0..height, z: 0..depth]
 * (metres). x is centred, y and z are pinned to their raw minimum, then a
 * per-axis scale corrects each dimension independently. Degenerate axes
 * (raw span ~0) keep scale 1. Children must carry no rotation (every part
 * here bakes its transform into its geometry), so scaling a child's
 * position + scale is the same as scaling its world geometry.
 */
function fitToEnvelope(THREE, group, widthM, depthM, heightM) {
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const rawW = box.max.x - box.min.x;
  const rawD = box.max.z - box.min.z;
  const rawH = box.max.y - box.min.y;
  const EPS = 1e-9;
  const sx = rawW > EPS ? widthM / rawW : 1;
  const sy = rawH > EPS ? heightM / rawH : 1;
  const sz = rawD > EPS ? depthM / rawD : 1;
  const ax = (box.min.x + box.max.x) / 2;
  const ay = box.min.y;
  const az = box.min.z;

  const wrapper = new THREE.Group();
  wrapper.name = group.name;
  wrapper.userData = group.userData;
  wrapper.userData.fitScale = { x: sx, y: sy, z: sz };
  for (const child of group.children.slice()) {
    child.position.x = (child.position.x - ax) * sx;
    child.position.y = (child.position.y - ay) * sy;
    child.position.z = (child.position.z - az) * sz;
    child.scale.x *= sx;
    child.scale.y *= sy;
    child.scale.z *= sz;
    wrapper.add(child);
  }
  return wrapper;
}

export function build(THREE, params, opts) {
  const p = Object.assign({}, DEFAULTS, params || {});
  const o = opts || {};
  const detail = o.detail === 'low' ? 'low' : 'full';
  const kind = KINDS.indexOf(p.kind) !== -1 ? p.kind : 'corn-plant';
  const raw = new THREE.Group();
  raw.name = 'furniture:plant';
  raw.userData.type = TYPE;
  raw.userData.kind = kind;
  const ctx = makeCtx(THREE, raw, p, detail);
  BUILDERS[kind](ctx);
  return fitToEnvelope(THREE, raw, p.width * CM, p.depth * CM, p.height * CM);
}

// Convenience alias matching the sibling builders' naming.
export function buildPlant(THREE, params, opts) {
  return build(THREE, params, opts);
}

/** Only the keys that differ from DEFAULTS -- a placement's `params`. */
export function toFurnitureJSON(params) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (params && params[k] !== undefined && params[k] !== DEFAULTS[k]) out[k] = params[k];
  }
  return { type: TYPE, params: out };
}

// =====================================================================
// Shared construction context: materials, mesh helper, PRNG.
// =====================================================================
function makeCtx(THREE, group, p, detail) {
  const mats = {};
  const mat = (finish, color) => {
    const key = finish + '|' + color;
    if (!mats[key]) mats[key] = makeFinish(THREE, finish, color);
    return mats[key];
  };
  const add = (geo, finish, color, name) => {
    const m = new THREE.Mesh(geo, mat(finish, color));
    m.name = name;
    m.userData.finish = finish;
    if (finish === 'glass' || finish === 'emissive' || finish === 'mirror') m.userData.keep = true;
    m.castShadow = finish !== 'glass';
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  return { THREE, group, p, detail, low: detail === 'low', rand: mulberry32((p.seed | 0) || 1), add };
}

const V = (THREE, x, y, z) => new THREE.Vector3(x, y, z);

/** A tapered tube from a to b (metres), transform baked into the geometry. */
function tube(THREE, a, b, r0, r1, radial, openEnded) {
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(r1, r0, Math.max(len, 1e-5), radial, 1, !!openEnded);
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  geo.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  geo.translate(mid.x, mid.y, mid.z);
  return geo;
}

/** A lathe from a [radius, y] profile (metres), centred on (cx, cz). */
function lathe(THREE, profile, radial, cx, cz) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y));
  const geo = new THREE.LatheGeometry(pts, radial);
  geo.translate(cx || 0, 0, cz || 0);
  return geo;
}

// ---------------------------------------------------------------------
// LEAVES. A leaf is a ribbon along a curved spine: it leaves `base`
// heading along azimuth `ang` (0 = +z, the front) at pitch `pitch0`
// (radians above horizontal) and bends toward `pitch1` at the tip. Its
// half-width follows a SHAPE profile of t (0 = base, 1 = tip). A 3-vertex
// row (edge, raised midrib, edge) gives a shallow V-fold; the tip is a
// single point. Faces are emitted twice (front, then reversed on their own
// duplicated vertices) so the leaf reads from both sides.
// Triangles per leaf: 2 x ((segs - 1) x 4 + 2).
// ---------------------------------------------------------------------
const LEAF_SHAPES = {
  // corn / peace-lily: narrow stalk-ish base, widest just past mid, pointed
  lance: t => (t < 0.08 ? 0.18 : Math.pow(Math.sin(Math.PI * Math.min(1, (t - 0.02) / 1.0)), 0.75)),
  // pothos: wide lobed base, widest in the lower third, long point
  heart: t => (t < 0.02 ? 0.55 : Math.pow(Math.sin(Math.PI * (0.32 + 0.68 * t)), 0.8)),
  // ficus / succulent pad: round-ended oval
  oval: t => Math.pow(Math.sin(Math.PI * Math.min(0.999, 0.06 + 0.94 * t)), 0.6),
  // snake plant / spiky: near-parallel sides, tapering over the last third
  sword: t => (t < 0.66 ? 0.8 + 0.3 * t : Math.max(0, 1 - (t - 0.66) / 0.34)),
  // a petiole-then-blade leaf (peace lily on its long stalk): stalk for the
  // first 40 % of the length, then a lance blade
  stalked: t => (t < 0.4 ? 0.07 : Math.pow(Math.sin(Math.PI * Math.min(1, (t - 0.4) / 0.6)), 0.7)),
};

function leafGeometry(THREE, spec) {
  const {
    base, ang, len, width, pitch0, pitch1, segs, shape, fold = 0.18, bendPow = 1.4, pitches, roll = 0,
  } = spec;
  // `pitches` (optional) gives each segment's pitch explicitly; otherwise
  // the pitch eases from pitch0 to pitch1.
  const segPitch = (i, n) => (pitches ? pitches[Math.min(i, pitches.length - 1)]
    : pitch0 + (pitch1 - pitch0) * Math.pow((i + 0.5) / n, bendPow));
  const rowPitch = (i, n) => (pitches ? (i === 0 ? pitches[0] : (pitches[i - 1] + pitches[Math.min(i, pitches.length - 1)]) / 2)
    : pitch0 + (pitch1 - pitch0) * Math.pow(i / n, bendPow));
  const prof = LEAF_SHAPES[shape] || LEAF_SHAPES.lance;
  const dh = [Math.sin(ang), Math.cos(ang)];          // horizontal heading (x, z)
  const side = [Math.cos(ang), -Math.sin(ang)];       // horizontal perpendicular
  const n = Math.max(1, segs);
  // spine by integration so the leaf keeps its length as it bends
  const spine = [base.clone()];
  const step = len / n;
  let p = base.clone();
  for (let i = 1; i <= n; i++) {
    const pitch = segPitch(i - 1, n);
    p = p.clone().add(new THREE.Vector3(dh[0] * Math.cos(pitch) * step, Math.sin(pitch) * step, dh[1] * Math.cos(pitch) * step));
    spine.push(p);
  }
  const pos = [];
  for (let i = 0; i < n; i++) {                       // rows 0..n-1: edge, midrib, edge
    const t = i / n;
    const hw = (width / 2) * prof(t);
    const c = spine[i];
    const pitch = rowPitch(i, n);
    const lift = hw * fold;                            // midrib raised along the leaf normal-ish
    const up = [-dh[0] * Math.sin(pitch), Math.cos(pitch), -dh[1] * Math.sin(pitch)];
    // `roll` twists the blade about its spine, so a leaf heading straight
    // across the view is not seen exactly edge-on (real strap leaves twist)
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const wv = [side[0] * cr + up[0] * sr, up[1] * sr, side[1] * cr + up[2] * sr];
    const nv = [up[0] * cr - side[0] * sr, up[1] * cr, up[2] * cr - side[1] * sr];
    pos.push(c.x - wv[0] * hw, c.y - wv[1] * hw, c.z - wv[2] * hw);
    pos.push(c.x + nv[0] * lift, c.y + nv[1] * lift, c.z + nv[2] * lift);
    pos.push(c.x + wv[0] * hw, c.y + wv[1] * hw, c.z + wv[2] * hw);
  }
  const tip = spine[n];
  pos.push(tip.x, tip.y, tip.z);
  // the two edge polylines (base to tip), for margin strips
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    left.push(new THREE.Vector3(pos[i * 9], pos[i * 9 + 1], pos[i * 9 + 2]));
    right.push(new THREE.Vector3(pos[i * 9 + 6], pos[i * 9 + 7], pos[i * 9 + 8]));
  }
  left.push(tip.clone()); right.push(tip.clone());
  const tipIdx = n * 3;
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 3, b = (i + 1) * 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const l = (n - 1) * 3;
  idx.push(l, tipIdx, l + 1, l + 1, tipIdx, l + 2);
  // back side: duplicate the vertices, reverse the winding
  const vcount = pos.length / 3;
  const all = pos.concat(pos);
  const back = idx.map(i => i + vcount);
  for (let i = 0; i < back.length; i += 3) { const t = back[i + 1]; back[i + 1] = back[i + 2]; back[i + 2] = t; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(all, 3));
  geo.setIndex(idx.concat(back));
  geo.computeVertexNormals();
  geo.userData.tip = tip;
  // (margin strips assume an untwisted blade: roll 0)
  geo.userData.edges = { left, right, side: new THREE.Vector3(side[0], 0, side[1]) };
  return geo;
}

/** A pale margin along both edges of a leaf built by leafGeometry(): two
 * thin two-sided strips lying IN the leaf's plane, straddling each edge --
 * visible from both faces and never coplanar with the blade (no z-fight). */
function marginStrips(THREE, leafGeo, width) {
  const { left, right, side } = leafGeo.userData.edges;
  const strip = (pts, sgn) => {
    const pos = [];
    pts.forEach((q, i) => {
      const t = i / (pts.length - 1);
      const w = width * (1 - 0.7 * t);
      pos.push(q.x - side.x * w * 0.35 * sgn, q.y, q.z - side.z * w * 0.35 * sgn,
        q.x + side.x * w * 0.65 * sgn, q.y, q.z + side.z * w * 0.65 * sgn);
    });
    return pos;
  };
  const one = (pos) => {
    const n = pos.length / 6, idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    return idx;
  };
  const L = strip(left, -1), R = strip(right, 1);
  const idxL = one(L), idxR = one(R).map(i => i + L.length / 3);
  const pos = L.concat(R);
  const front = idxL.concat(idxR);
  const vc = pos.length / 3;
  const back = front.map(i => i + vc);
  for (let i = 0; i < back.length; i += 3) { const t = back[i + 1]; back[i + 1] = back[i + 2]; back[i + 2] = t; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos.concat(pos), 3));
  geo.setIndex(front.concat(back));
  geo.computeVertexNormals();
  return geo;
}

/** A thin flat two-sided ribbon along a list of points (vines, roots). */
function ribbon(THREE, pts, width) {
  const pos = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const d = b.clone().sub(a);
    let s = new THREE.Vector3(-d.z, 0, d.x);
    if (s.lengthSq() < 1e-12) s = new THREE.Vector3(1, 0, 0);
    s.normalize().multiplyScalar(width / 2);
    pos.push(pts[i].x - s.x, pts[i].y - s.y, pts[i].z - s.z, pts[i].x + s.x, pts[i].y + s.y, pts[i].z + s.z);
  }
  const idx = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const vc = pos.length / 3;
  const back = idx.map(i => i + vc);
  for (let i = 0; i < back.length; i += 3) { const t = back[i + 1]; back[i + 1] = back[i + 2]; back[i + 2] = t; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos.concat(pos), 3));
  geo.setIndex(idx.concat(back));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------
// POTS. Centred on x = z = 0, standing on y = y0. Returns the rim height
// and inner radius so foliage knows where to grow from.
// ---------------------------------------------------------------------
function buildPot(ctx, style, y0) {
  const { THREE, p, low, add } = ctx;
  const h = p.potHeight * CM;
  const R = (p.potTopDiameter * CM) / 2;
  const color = p.potColor;
  let prof, finish = 'matte', radial = low ? 8 : (style === 'egg' ? 10 : 12);
  const at = pts => pts.map(([r, y]) => [r, y0 + y]);
  switch (style) {
    case 'egg': {                                   // widest at 65 % height, fine ribs
      const k = [[0.73, 0], [0.9, 0.2], [1.06, 0.45], [1.1, 0.65], [1.06, 0.82], [1.0, 1]];
      prof = low ? [[0, 0]].concat(k.filter((_, i) => i % 2 === 0 || i === k.length - 1)) : [[0, 0]].concat(k);
      if (!low) {                                   // shallow rib grooves on the belly
        prof = [[0, 0]];
        const n = 6;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const r = 0.73 + (1.1 - 0.73) * Math.sin(Math.PI * Math.min(1, t / 1.3)) - (t > 0.9 ? (t - 0.9) * 1.0 : 0);
          prof.push([r * (i % 2 ? 0.985 : 1), t]);
        }
      }
      finish = 'satin';
      break;
    }
    case 'tapered':
      prof = [[0, 0], [0.74, 0], [0.8, 0.08], [1.0, 0.92], [1.03, 1]];
      break;
    case 'ribbed-footed':                           // a fluted cup on a narrow foot
      prof = [[0, 0], [0.62, 0], [0.62, 0.08], [0.48, 0.16], [0.9, 0.3], [1.0, 1]];
      radial = low ? 8 : 20;
      finish = 'gloss';
      break;
    case 'bowl':                                    // squat glazed bowl on a saucer
      prof = [[0, 0], [1.08, 0], [1.1, 0.06], [0.72, 0.1], [0.95, 0.5], [1.02, 0.85], [0.98, 1]];
      finish = 'gloss';
      break;
    case 'cylinder':
      prof = [[0, 0], [0.92, 0], [0.97, 0.06], [1.0, 1]];
      finish = style === 'cylinder' && ctx.p.kind === 'jade' ? 'gloss' : 'matte';
      break;
    case 'glass-bubble': {                          // a bulb with a narrower neck
      const n = low ? 4 : 6;
      prof = [[0, 0]];
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 0.82;
        prof.push([Math.cos(a) * 1.0, (Math.sin(a) + 1) / 2 * 0.92]);
      }
      prof.push([0.62, 1]);
      radial = low ? 8 : 10;
      finish = 'glass';
      break;
    }
    default:
      prof = [[0, 0], [0.8, 0], [1, 1]];
  }
  if (low && prof.length > 5) {
    const keep = [0, Math.round(prof.length * 0.35), Math.round(prof.length * 0.6), prof.length - 2, prof.length - 1];
    prof = prof.filter((_, i) => keep.indexOf(i) !== -1);
  }
  const scaled = at(prof.map(([r, y]) => [r * R, y * h]));
  const geo = lathe(THREE, scaled, radial, 0, 0);
  if (style === 'ribbed-footed' && !low) {
    // flute the cup: push every other radial column out a little
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), y = pos.getY(i);
      if (y < y0 + h * 0.2) continue;
      const a = Math.atan2(z, x);
      const f = 1 + 0.045 * Math.cos(a * radial / 2 * 2);
      pos.setX(i, x * f); pos.setZ(i, z * f);
    }
    geo.computeVertexNormals();
  }
  add(geo, finish, style === 'glass-bubble' ? p.glassColor : color, 'pot');
  const rimY = y0 + h;
  if (style !== 'glass-bubble') {
    // soil disc just under the rim
    const soil = new THREE.CircleGeometry(R * 0.93, low ? 8 : 12);
    soil.rotateX(-Math.PI / 2);
    soil.translate(0, rimY - h * 0.04, 0);
    add(soil, 'matte', '#2e2319', 'soil');
  }
  return { rimY, innerR: R * (style === 'glass-bubble' ? 0.6 : 0.9), finish };
}

// =====================================================================
// CORN PLANT (Dracaena fragrans)
// =====================================================================
function buildCornPlant(ctx) {
  const { THREE, p, low, rand, add } = ctx;
  const pot = buildPot(ctx, p.potStyle || 'egg', 0);
  const rimY = pot.rimY;
  if (!low) {
    // the terracotta nursery pot's rim, visible ~3 cm below the vase rim
    const R = (p.potTopDiameter * CM) / 2;
    const ring = new THREE.CylinderGeometry(R * 0.9, R * 0.88, 0.02, 10, 1, true);
    ring.translate(0, rimY - 0.03, 0);
    add(ring, 'matte', '#b5532f', 'nurseryRim');
  }
  const plantH = p.plantHeight * CM;
  const leafLen = p.leafLength * CM;
  const leafW = p.leafWidth * CM;
  const stems = Math.max(1, Math.round(p.stemCount));
  // Cane heights above the rim, as fractions of plantHeight (measured on
  // the reference: ~105 / ~45 / ~20 of 110), jittered by seed. Extra canes
  // beyond three fill in between.
  const FR = [0.72, 0.30, 0.12];
  const LEAVES = low ? [8, 6, 4] : [22, 18, 8];
  const spreadR = (p.spread * CM) / 2;
  const caneR = 0.016;
  for (let s = 0; s < stems; s++) {
    const fr = (FR[s] !== undefined ? FR[s] : 0.2 + 0.3 * rand()) * (0.95 + 0.1 * rand());
    const ang = s === 0 ? 0 : (s % 2 ? 1 : -1) * (0.9 + 0.5 * rand());
    const off = s === 0 ? 0.02 : 0.05 + 0.03 * rand();
    const bx = Math.sin(ang) * off, bz = Math.cos(ang) * off;
    const topY = rimY + plantH * fr;
    const lean = 0.03 * (s === 0 ? 0.3 : 1);
    const top = V(THREE, bx + Math.sin(ang) * lean, topY, bz + Math.cos(ang) * lean);
    add(tube(THREE, V(THREE, bx, rimY - 0.05, bz), top, caneR * 1.1, caneR, 5, true), 'matte', '#4a3622', 'cane');
    // TUFT: leaves spiral up the top ~35 cm of the cane (less on short canes)
    const n = LEAVES[s] !== undefined ? LEAVES[s] : LEAVES[LEAVES.length - 1];
    const tuftH = Math.min(0.35, plantH * fr * 0.8);
    const lenScale = s === 0 ? 1 : (s === 1 ? 0.95 : 0.85);
    // the crown radius this cane's leaves aim for (the mid/short tufts are
    // narrower than the top crown)
    const reach = s === 0 ? spreadR : spreadR * 0.75;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 1 : i / (n - 1);             // 0 = lowest, 1 = crown
      const y = topY - tuftH * (1 - t);
      const a = i * 2.39996 + rand() * 0.5;             // golden-angle spiral
      const up = t > 0.6;                               // upper leaves stand up
      const len = leafLen * lenScale * (0.9 + 0.2 * rand());
      // Every leaf ARCHES in two segments: it rises at pitch `a`, then its
      // outer half droops at a - bend. Its horizontal reach is then
      // len/2 * (cos a + cos(a - bend)) = len cos(bend/2) cos(a - bend/2),
      // so `a` is solved in closed form for a target reach inside the crown:
      // the leaf keeps its full photographed length and only its angle
      // changes. Upper leaves: short reach, gentle bend (they stand up);
      // lower leaves: long reach, strong bend (they splay out and droop).
      const baseOff = Math.hypot(top.x, top.z);
      const want = Math.max(0.02, (reach - baseOff - leafW / 2) * (up ? 0.4 + 0.3 * rand() : 0.8 + 0.2 * rand()));
      const bend = up ? 0.5 + 0.5 * rand() : 1.2 + 0.5 * rand();
      const maxReach = len * Math.cos(bend / 2);
      const aRise = bend / 2 + Math.acos(Math.min(1, want / maxReach));
      const pitches = [Math.min(1.55, aRise), Math.min(1.55, aRise) - bend];
      const segs = low ? 1 : 2;
      add(leafGeometry(THREE, {
        base: V(THREE, top.x, y, top.z), ang: a, len, width: leafW,
        pitch0: pitches[0], pitch1: pitches[1], pitches: low ? [(pitches[0] + pitches[1]) / 2] : pitches, segs, shape: 'lance', fold: 0.2,
        roll: (rand() - 0.5) * 1.6,
      }), 'satin', p.leafColor, 'leaf');
    }
  }
}

// =====================================================================
// WALL PLANTER
// =====================================================================
function buildWallPlanter(ctx) {
  const { THREE, p, low, rand, add } = ctx;
  const W = p.width * CM, D = p.depth * CM, H = p.height * CM;
  const hTop = H * 0.5;
  const BL = V(THREE, -W / 2, hTop, 0), BR = V(THREE, W / 2, hTop, 0), F = V(THREE, 0, hTop, D), B = V(THREE, 0, 0, 0);
  const U = V(THREE, 0, H, 0);
  // Ceramic: two front facets + the flat back, outward-facing windings.
  const tri = [];
  const push = (...vs) => vs.forEach(v => tri.push(v.x, v.y, v.z));
  push(B, F, BL);        // left front facet
  push(B, BR, F);        // right front facet
  push(B, BL, BR);       // flat back, on the wall (z = 0), facing -z
  const cer = new THREE.BufferGeometry();
  cer.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
  cer.computeVertexNormals();
  add(cer, 'matte', p.potColor, 'planterBody');
  // soil: the open triangular top, a little below the rim
  const s = 0.9, sy = hTop - H * 0.02;
  const soil = new THREE.BufferGeometry();
  soil.setAttribute('position', new THREE.Float32BufferAttribute([
    -W / 2 * s, sy, 0.002, 0, sy, D * s, W / 2 * s, sy, 0.002,
  ], 3));
  soil.computeVertexNormals();
  add(soil, 'matte', '#2e2319', 'soil');
  // Brass wire: every ceramic edge, then the open mirror image up to U.
  if (!low) {
    const r = Math.max(0.0015, W * 0.007);
    const edges = [[B, BL], [B, BR], [B, F], [BL, BR], [BR, F], [F, BL], [U, BL], [U, BR], [U, F]];
    edges.forEach(([a, b]) => add(tube(THREE, a, b, r, r, 4, true), 'metal', p.frameColor, 'wire'));
  }
  // Contents, rising from the opening's centroid.
  const cx = 0, cz = D / 3, cy = hTop - H * 0.02;
  const room = H - cy;                                  // never above the top apex
  const contents = WALL_CONTENTS.indexOf(p.contents) !== -1 ? p.contents : 'spiky';
  let n, shape, lenR, wid, margin = false;
  if (contents === 'spiky') { n = low ? 3 : 20; shape = 'sword'; lenR = [0.55, 0.95]; wid = 0.02; }
  else if (contents === 'succulent') { n = low ? 3 : 8; shape = 'oval'; lenR = [0.35, 0.6]; wid = W * 0.18; }
  else { n = low ? 3 : 4; shape = 'sword'; lenR = [0.8, 0.98]; wid = 0.04; margin = !low; }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.6;
    const len = room * (lenR[0] + (lenR[1] - lenR[0]) * rand());
    const pitch0 = contents === 'succulent' ? 0.7 + 0.5 * rand() : 1.35 + 0.15 * rand();
    const pitch1 = contents === 'succulent' ? 0.9 + 0.4 * rand() : 1.2 + 0.25 * rand();
    const base = V(THREE, cx + (rand() - 0.5) * W * 0.15, cy, cz + (rand() - 0.5) * D * 0.2);
    const spec = { base, ang: a, len, width: wid, pitch0, pitch1, segs: low ? 1 : 2, shape, fold: 0.15 };
    const g = leafGeometry(THREE, spec);
    add(g, 'matte', p.leafColor, 'leaf');
    if (margin) add(marginStrips(THREE, g, wid * 0.14), 'matte', p.accentColor, 'leafMargin');
  }
}

// =====================================================================
// PEACE LILY in a glass bubble vase (grown in water)
// =====================================================================
function buildPeaceLily(ctx) {
  const { THREE, p, low, rand, add } = ctx;
  const pot = buildPot(ctx, 'glass-bubble', 0);
  const R = (p.potTopDiameter * CM) / 2;
  const h = p.potHeight * CM;
  // water surface and a root tangle seen through the glass
  const water = new THREE.CircleGeometry(R * 0.93, low ? 8 : 14);
  water.rotateX(-Math.PI / 2);
  water.translate(0, h * 0.62, 0);
  add(water, 'glass', '#bfe3ea', 'water');
  const roots = low ? 0 : 4;
  for (let i = 0; i < roots; i++) {
    const a = (i / roots) * Math.PI * 2 + rand();
    const pts = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      const rr = R * (0.15 + 0.6 * Math.sin(Math.PI * t * 0.8)) * (0.6 + 0.4 * rand());
      pts.push(V(THREE, Math.sin(a + t) * rr, h * (0.9 - 0.8 * t), Math.cos(a + t) * rr));
    }
    add(ribbon(THREE, pts, 0.004), 'matte', '#c9b48a', 'root');
  }
  // root-ball cap sitting in the neck
  // the plant's crown sits in the neck: a small dark root ball
  const cap = lathe(THREE, [[0, h * 0.8], [pot.innerR * 0.8, h * 0.88], [pot.innerR * 0.55, h * 1.0], [0, h * 1.02]], low ? 5 : 7, 0, 0);
  add(cap, 'matte', '#3b2b1d', 'soil');
  // leaves on long arching stalks
  const n = low ? 7 : Math.max(4, Math.round(p.leafCount));
  const top = (p.plantHeight * CM);
  for (let i = 0; i < n; i++) {
    const a = i * 2.39996 + rand() * 0.4;
    const inner = i < n * 0.4;
    const len = top * (inner ? 0.95 : 0.8) * (0.85 + 0.2 * rand());
    const pitch0 = inner ? 1.35 : 1.05 + 0.25 * rand();
    const pitch1 = inner ? 0.5 : -0.4 - 0.5 * rand();
    const variegated = i % 3 === 1;
    add(leafGeometry(THREE, {
      base: V(THREE, (rand() - 0.5) * 0.02, h * 1.0, (rand() - 0.5) * 0.02), ang: a, len,
      width: p.leafWidth * CM, pitch0, pitch1, segs: low ? 1 : 4, shape: 'stalked', fold: 0.25, bendPow: 1.8, roll: (rand() - 0.5) * 1.2,
    }), 'gloss', variegated ? p.accentColor : p.leafColor, 'leaf');
  }
  // one white spathe on a tall stalk
  if (!low) {
    const sh = top * 0.95;
    add(tube(THREE, V(THREE, 0.005, h, 0.01), V(THREE, 0.01, h + sh * 0.75, 0.03), 0.0025, 0.002, 4, true), 'matte', '#4f6b3a', 'spatheStalk');
    add(leafGeometry(THREE, {
      base: V(THREE, 0.01, h + sh * 0.75, 0.03), ang: 0.3, len: sh * 0.25, width: p.leafWidth * CM * 0.8,
      pitch0: 1.3, pitch1: 1.4, segs: 2, shape: 'oval', fold: 0.6,
    }), 'matte', '#f5f4ec', 'spathe');
  }
}

// =====================================================================
// SNAKE PLANT
// =====================================================================
function buildSnakePlant(ctx) {
  const { THREE, p, low, rand, add } = ctx;
  const pot = buildPot(ctx, p.potStyle, 0);
  const n = Math.max(1, Math.round(p.leafCount));
  const len = p.plantHeight * CM;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.8;
    const l = len * (0.7 + 0.3 * rand()) * (i === 0 ? 1 / 0.85 : 1);
    const base = V(THREE, (rand() - 0.5) * pot.innerR, pot.rimY - 0.01, (rand() - 0.5) * pot.innerR);
    const spec = { base, ang: a, len: Math.min(l, len), width: p.leafWidth * CM, pitch0: 1.35 + 0.15 * rand(), pitch1: 1.1 + 0.3 * rand(), segs: low ? 1 : 3, shape: 'sword', fold: 0.12 };
    const g = leafGeometry(THREE, spec);
    add(g, 'matte', p.leafColor, 'leaf');
    if (!low) add(marginStrips(THREE, g, spec.width * 0.14), 'matte', p.accentColor, 'leafMargin');
  }
}

// =====================================================================
// POTHOS (heart-leaf), upright or trailing
// =====================================================================
function buildPothos(ctx) {
  const { THREE, p, low, rand, add } = ctx;
  const trailing = p.habit === 'trailing';
  const trail = trailing ? Math.max(0, p.trail) * CM : 0;
  const pot = buildPot(ctx, p.potStyle, trail);
  const R = (p.potTopDiameter * CM) / 2;
  const leafL = p.leafLength * CM, leafW = p.leafWidth * CM;
  const nLeaves = low ? Math.min(9, Math.round(p.leafCount * 0.4) + 3) : Math.max(3, Math.round(p.leafCount));
  if (!trailing) {
    // arching stems, a heart leaf at the end of each (plus side leaves)
    const stems = Math.max(2, Math.round(p.stemCount));
    let placed = 0;
    for (let s = 0; s < stems; s++) {
      const a = (s / stems) * Math.PI * 2 + rand() * 0.6;
      const h = p.plantHeight * CM * (0.55 + 0.4 * rand());
      const reach = (p.spread * CM) / 2 * (0.5 + 0.4 * rand());
      const b = V(THREE, 0, pot.rimY - 0.01, 0);
      const mid = V(THREE, Math.sin(a) * reach * 0.4, pot.rimY + h * 0.75, Math.cos(a) * reach * 0.4);
      const end = V(THREE, Math.sin(a) * reach, pot.rimY + h * 0.6, Math.cos(a) * reach);
      if (!low) add(ribbon(THREE, [b, mid, end], 0.004), 'matte', '#5f7d3a', 'stem');
      const per = Math.ceil((nLeaves - placed) / (stems - s));
      for (let k = 0; k < per && placed < nLeaves; k++, placed++) {
        const t = per === 1 ? 1 : 0.45 + 0.55 * (k / (per - 1));
        const at = t < 0.75 ? b.clone().lerp(mid, t / 0.75) : mid.clone().lerp(end, (t - 0.75) / 0.25);
        const la = a + (k % 2 ? 0.9 : -0.9) * rand();
        add(leafGeometry(THREE, {
          base: at, ang: la, len: leafL * (0.8 + 0.3 * rand()), width: leafW,
          pitch0: 0.2, pitch1: -0.5 - 0.4 * rand(), segs: low ? 1 : 3, shape: 'heart', fold: 0.15,
        }), 'matte', p.leafColor, 'leaf');
      }
    }
    return;
  }
  // TRAILING: a crown of leaves on the pot plus vines hanging to y = 0
  const vines = low ? 3 : Math.max(2, Math.round(p.stemCount));
  const perVine = Math.max(1, Math.floor(nLeaves / (vines + 1)));
  let placed = 0;
  for (let i = 0; i < perVine; i++, placed++) {                 // crown
    add(leafGeometry(THREE, {
      base: V(THREE, (rand() - 0.5) * R, pot.rimY, (rand() - 0.5) * R), ang: rand() * Math.PI * 2,
      len: leafL, width: leafW, pitch0: 1.2, pitch1: 0.2, segs: low ? 1 : 2, shape: 'heart',
    }), 'matte', p.leafColor, 'leaf');
  }
  for (let v = 0; v < vines; v++) {
    // vines leave the rim toward the front half and fall straight down
    const a = -0.9 + 1.8 * (vines === 1 ? 0.5 : v / (vines - 1)) + (rand() - 0.5) * 0.3;
    const rim = V(THREE, Math.sin(a) * R, pot.rimY, Math.cos(a) * R);
    const out = (p.spread * CM) / 2 - R;
    const drop = pot.rimY * (0.55 + 0.45 * (v % 2 ? rand() : 1));
    const pts = [rim];
    const segs = low ? 2 : 6;
    for (let k = 1; k <= segs; k++) {
      const t = k / segs;
      const o = R + out * Math.min(1, t * 2.5) * (0.6 + 0.4 * Math.sin(t * 3 + v));
      pts.push(V(THREE, Math.sin(a) * o, pot.rimY - drop * t, Math.cos(a) * o));
    }
    add(ribbon(THREE, pts, 0.004), 'matte', '#5f7d3a', 'vine');
    const each = Math.max(1, Math.floor((nLeaves - perVine) / vines));
    for (let k = 0; k < each; k++, placed++) {
      const t = (k + 1) / (each + 0.5);
      const at = pts[Math.min(pts.length - 1, Math.round(t * segs))];
      add(leafGeometry(THREE, {
        base: at, ang: a + (k % 2 ? 1.2 : -1.2), len: leafL * (0.75 + 0.25 * rand()), width: leafW,
        pitch0: -0.2, pitch1: -1.1, segs: low ? 1 : 2, shape: 'heart', fold: 0.12,
      }), 'matte', p.leafColor, 'leaf');
    }
  }
}

// =====================================================================
// FICUS (small thick-trunk tree)
// =====================================================================
function buildFicus(ctx) {
  const { THREE, p, low, rand, add } = ctx;
  const pot = buildPot(ctx, p.potStyle, 0);
  const R = (p.potTopDiameter * CM) / 2;
  if (p.potStyle === 'bowl' && !low) {                           // saucer
    const sc = new THREE.CylinderGeometry(R * 1.28, R * 1.22, 0.012, 12, 1, false);
    sc.translate(0, 0.006, 0);
    add(sc, 'gloss', p.potColor, 'saucer');
  }
  const top = pot.rimY + p.plantHeight * CM;
  const trunkTop = V(THREE, 0, pot.rimY + p.plantHeight * CM * 0.28, 0);
  add(tube(THREE, V(THREE, 0, pot.rimY - 0.02, 0), trunkTop, 0.022, 0.012, low ? 5 : 7, true), 'matte', '#6b5a44', 'trunk');
  const branches = Math.max(2, Math.round(p.stemCount));
  const nLeaves = low ? 10 : Math.max(branches * 3, Math.round(p.leafCount));
  const reach = (p.spread * CM) / 2;
  let placed = 0;
  for (let b = 0; b < branches; b++) {
    const a = (b / branches) * Math.PI * 2 + rand() * 0.7;
    const end = V(THREE, Math.sin(a) * reach * (0.35 + 0.3 * rand()), top - p.plantHeight * CM * (0.1 + 0.3 * rand()), Math.cos(a) * reach * (0.35 + 0.3 * rand()));
    add(tube(THREE, trunkTop, end, 0.008, 0.004, low ? 4 : 5, true), 'matte', '#6b5a44', 'branch');
    const each = Math.ceil((nLeaves - placed) / (branches - b));
    for (let k = 0; k < each && placed < nLeaves; k++, placed++) {
      // leaves cluster toward the branch tips
      const t = 0.6 + 0.4 * Math.sqrt(rand());
      const at = trunkTop.clone().lerp(end, t);
      add(leafGeometry(THREE, {
        base: at, ang: rand() * Math.PI * 2, len: p.leafLength * CM * (0.8 + 0.4 * rand()), width: p.leafWidth * CM,
        pitch0: 0.5 + 0.4 * rand(), pitch1: -0.2, segs: 1, shape: 'oval', fold: 0.1,
      }), 'gloss', p.leafColor, 'leaf');
    }
  }
}

// =====================================================================
// JADE (succulent)
// =====================================================================
function padGeometry(THREE, base, ang, pitch, len, wid, thick, low) {
  // A fleshy pad: a flattened ellipsoid (a 5 x 3 sphere, 20 tris) at full
  // detail, a flattened octahedron (8 tris) at low -- transform baked in.
  const geo = low ? new THREE.OctahedronGeometry(0.5, 0) : new THREE.SphereGeometry(0.5, 5, 3);
  geo.scale(wid, len, thick);                      // long axis = +y before rotation
  geo.translate(0, len / 2, 0);                    // stalk end at the origin
  const dh = [Math.sin(ang), Math.cos(ang)];
  const dir = new THREE.Vector3(dh[0] * Math.cos(pitch), Math.sin(pitch), dh[1] * Math.cos(pitch)).normalize();
  const side = new THREE.Vector3(Math.cos(ang), 0, -Math.sin(ang));
  const nrm = side.clone().cross(dir).normalize();
  const m = new THREE.Matrix4().makeBasis(side, dir, nrm);
  geo.applyMatrix4(m);
  geo.translate(base.x, base.y, base.z);
  geo.computeVertexNormals();
  return geo;
}

function buildJade(ctx) {
  const { THREE, p, low, rand, add } = ctx;
  const pot = buildPot(ctx, p.potStyle, 0);
  const stems = Math.max(1, Math.round(p.stemCount));
  const nPads = low ? 8 : Math.max(stems * 2, Math.round(p.leafCount));
  const h = p.plantHeight * CM, reach = (p.spread * CM) / 2;
  let placed = 0;
  for (let s = 0; s < stems; s++) {
    const a = (s / stems) * Math.PI * 2 + rand() * 0.8;
    const b = V(THREE, (rand() - 0.5) * pot.innerR * 0.6, pot.rimY - 0.01, (rand() - 0.5) * pot.innerR * 0.6);
    const e = V(THREE, Math.sin(a) * reach * 0.6, pot.rimY + h * (0.45 + 0.25 * rand()), Math.cos(a) * reach * 0.6);
    add(tube(THREE, b, e, 0.006, 0.004, low ? 4 : 5, true), 'matte', '#6f6a3e', 'stem');
    const each = Math.ceil((nPads - placed) / (stems - s));
    for (let k = 0; k < each && placed < nPads; k++, placed++) {
      const t = 0.7 + 0.3 * (k / Math.max(1, each - 1));
      const at = b.clone().lerp(e, t);
      add(padGeometry(THREE, at, a + (k - each / 2) * 1.1 + rand() * 0.5, 0.5 + 0.7 * rand(),
        p.leafLength * CM * (0.8 + 0.3 * rand()), p.leafWidth * CM, p.leafWidth * CM * 0.35, low), 'satin', p.leafColor, 'leaf');
    }
  }
}

const BUILDERS = {
  'corn-plant': buildCornPlant,
  'wall-planter': buildWallPlanter,
  'peace-lily': buildPeaceLily,
  'snake-plant': buildSnakePlant,
  'pothos': buildPothos,
  'ficus': buildFicus,
  'jade': buildJade,
};

/** Named presets. Descriptive names only -- no real names of people,
 * plants or places in a public repo. Sizes: the corn plant and the wall
 * planters are measured; the other kinds are estimated from photographs
 * against objects of known size (spec pages say so). */
export const PRESETS = Object.freeze({
  'corn-plant-tall': Object.freeze({
    kind: 'corn-plant', width: 60, depth: 60, height: 166,
    potStyle: 'egg', potHeight: 56, potTopDiameter: 30, potColor: '#a67c4e',
    plantHeight: 110, stemCount: 3, spread: 60, leafLength: 45, leafWidth: 6, leafColor: '#1f3a1c', seed: 7,
  }),
  'wall-planter-large': Object.freeze({
    kind: 'wall-planter', width: 22.9, depth: 9.5, height: 38.1, contents: 'spiky',
    potColor: '#f2f0ea', frameColor: '#b8945a', leafColor: '#5b6b33', seed: 3,
  }),
  'wall-planter-small': Object.freeze({
    kind: 'wall-planter', width: 11, depth: 9.8, height: 14.3, contents: 'succulent',
    potColor: '#f2f0ea', frameColor: '#b8945a', leafColor: '#6b8a4a', seed: 4,
  }),
  'wall-planter-large-snake': Object.freeze({
    kind: 'wall-planter', width: 22.9, depth: 9.5, height: 38.1, contents: 'snake-plant',
    potColor: '#f2f0ea', frameColor: '#b8945a', leafColor: '#2f4a28', accentColor: '#c9cf8a', seed: 5,
  }),
  'peace-lily-glass-vase': Object.freeze({
    kind: 'peace-lily', width: 50, depth: 45, height: 55,
    potStyle: 'glass-bubble', potHeight: 16, potTopDiameter: 18, glassColor: '#dcecef',
    plantHeight: 39, leafCount: 10, leafLength: 24, leafWidth: 7, leafColor: '#1d3a1e', accentColor: '#9fae84', seed: 11,
  }),
  'snake-plant-small': Object.freeze({
    kind: 'snake-plant', width: 18, depth: 16, height: 38,
    potStyle: 'tapered', potHeight: 13, potTopDiameter: 15, potColor: '#c99a8e',
    plantHeight: 25, leafCount: 3, leafWidth: 4.5, leafColor: '#35502a', accentColor: '#c9c46a', seed: 12,
  }),
  'pothos-upright-ribbed-pot': Object.freeze({
    kind: 'pothos', habit: 'upright', width: 34, depth: 26, height: 30,
    potStyle: 'ribbed-footed', potHeight: 14, potTopDiameter: 11, potColor: '#f1efea',
    plantHeight: 16, stemCount: 4, spread: 34, leafCount: 8, leafLength: 9, leafWidth: 6, leafColor: '#2f5a24', seed: 13,
  }),
  'pothos-trailing': Object.freeze({
    kind: 'pothos', habit: 'trailing', trail: 50, width: 55, depth: 45, height: 78,
    potStyle: 'cylinder', potHeight: 14, potTopDiameter: 16, potColor: '#8d8f8c',
    plantHeight: 20, stemCount: 5, spread: 55, leafCount: 26, leafLength: 9, leafWidth: 7, leafColor: '#3f7a2a', seed: 14,
  }),
  'ficus-bowl-pot': Object.freeze({
    kind: 'ficus', width: 30, depth: 28, height: 42,
    potStyle: 'bowl', potHeight: 11, potTopDiameter: 18, potColor: '#d9cdb4',
    plantHeight: 31, stemCount: 4, spread: 30, leafCount: 36, leafLength: 5.5, leafWidth: 3.2, leafColor: '#3c6a2c', seed: 15,
  }),
  'jade-small': Object.freeze({
    kind: 'jade', width: 22, depth: 20, height: 28,
    potStyle: 'cylinder', potHeight: 11, potTopDiameter: 12, potColor: '#c8642e',
    plantHeight: 17, stemCount: 3, spread: 22, leafCount: 16, leafLength: 5, leafWidth: 2.8, leafColor: '#6f9a45', seed: 16,
  }),
});
