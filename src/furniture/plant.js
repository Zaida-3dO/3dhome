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
/** Parts that keep a single horizontal scale in the envelope fit (see
 * fitToEnvelope). Each is built with position 0 and its shape baked about
 * the raw origin: the plant's axis for pots, a point on the wall for the
 * wall planter's soil. */
const RIGID_PARTS = new Set(['pot', 'soil', 'saucer', 'nurseryRim', 'water']);

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
  const children = group.children.slice();
  children.forEach(c => wrapper.add(c));
  const orig = children.map(c => ({ p: c.position.clone(), s: c.scale.clone() }));
  // Place every child with the per-axis fit; RIGID parts (the pot and what
  // sits in it) instead take ONE horizontal scale `sr` (when given), so a
  // pot stays round whatever the foliage does to the fit -- e.g. at low
  // detail, where fewer leaves change the raw footprint.
  const place = sr => {
    children.forEach((child, i) => {
      const o = orig[i];
      child.position.set((o.p.x - ax) * sx, (o.p.y - ay) * sy, (o.p.z - az) * sz);
      // A rigid part's raw position is 0 and its shape is baked about the
      // raw origin (the plant's axis; for the wall planter's soil, a point
      // on the wall), so scaling it by sr is about where the fit maps that
      // origin.
      const rigid = sr !== undefined && RIGID_PARTS.has(child.name);
      child.scale.set(o.s.x * (rigid ? sr : sx), o.s.y * sy, o.s.z * (rigid ? sr : sz));
    });
    wrapper.updateMatrixWorld(true);
  };
  // The envelope must come out EXACT: try the rigid scales in order of
  // preference -- sy (the "whole plant got bigger/smaller" factor, ~1 for
  // a preset, so a pot keeps its true diameter), then min/max of sx, sz --
  // and keep the first whose built bbox is still exactly the envelope on
  // all six sides. A pot that sets one side of the footprint fails that
  // check for any sr other than that axis's own scale. If none holds, fall
  // back to the plain per-axis fit (always exact, pot possibly oval).
  const TOL = 1e-4;
  const exact = () => {
    const b = new THREE.Box3().setFromObject(wrapper);
    return Math.abs(b.min.x + widthM / 2) < TOL && Math.abs(b.max.x - widthM / 2) < TOL &&
      Math.abs(b.min.y) < TOL && Math.abs(b.max.y - heightM) < TOL &&
      Math.abs(b.min.z) < TOL && Math.abs(b.max.z - depthM) < TOL;
  };
  const hasRigid = children.some(c => RIGID_PARTS.has(c.name));
  const cands = hasRigid ? [sy, Math.min(sx, sz), Math.max(sx, sz)] : [];
  for (const sr of cands) {
    place(sr);
    if (exact()) { wrapper.userData.rigidScale = sr; return wrapper; }
  }
  place(undefined);
  wrapper.userData.rigidScale = null;
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
  const fitted = fitToEnvelope(THREE, raw, p.width * CM, p.depth * CM, p.height * CM);
  if (kind === 'pothos' && p.habit === 'trailing' && p.trail > 0) pinTrail(THREE, fitted, p);
  return fitted;
}

/**
 * Make `trail` EXACT after the envelope fit. The fit scales y uniformly, so
 * the pot base would land at trail x (height / raw height), not at `trail`,
 * and the placement rule `elevation = surface - trail` would be off by
 * centimetres. Bake every part's transform into its geometry, then remap y
 * piecewise-linearly so the pot base goes to exactly `trail` while y = 0
 * (the vine tips) and y = height (the crown) stay put. Both pieces are
 * monotone, so nothing folds or crosses.
 */
function pinTrail(THREE, group, p) {
  const H = p.height * CM;
  const T = Math.min(p.trail * CM, H * 0.95);
  group.updateMatrixWorld(true);
  const pot = group.children.find(o => o.name === 'pot');
  if (!pot) return;
  const pb = new THREE.Box3().setFromObject(pot).min.y;          // fitted pot base
  if (!(pb > 1e-6 && pb < H - 1e-6)) return;
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  for (const o of group.children) {
    if (!o.isMesh) continue;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    o.geometry.applyMatrix4(m);
    o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
    const a = o.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const y = a.getY(i);
      a.setY(i, y <= pb ? y * (T / pb) : T + (y - pb) * ((H - T) / (H - pb)));
    }
    a.needsUpdate = true;
    o.geometry.computeVertexNormals();
    o.geometry.computeBoundingBox(); o.geometry.computeBoundingSphere();
  }
  group.userData.trailPinned = T;
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
  // `rand` lays out STRUCTURE (canes, stems, branches); `leafRand` lays out
  // the leaves. Two streams, so a low-detail build (fewer leaves) keeps the
  // same branches as the full one -- and so the same footprint and fit.
  return {
    THREE, group, p, detail, low: detail === 'low', add,
    rand: mulberry32((p.seed | 0) || 1),
    leafRand: mulberry32((((p.seed | 0) || 1) * 7919 + 13) >>> 0),
  };
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
export const LEAF_SHAPES = {
  // corn / peace-lily: narrow stalk-ish base, widest just past mid, pointed
  lance: t => (t < 0.08 ? 0.18 : Math.pow(Math.sin(Math.PI * Math.min(1, (t - 0.02) / 1.0)), 0.75)),
  // pothos: wide lobed base, widest in the lower third, long point
  heart: t => (t < 0.02 ? 0.55 : Math.pow(Math.sin(Math.PI * (0.32 + 0.68 * t)), 0.8)),
  // ficus / succulent pad: round-ended oval
  oval: t => Math.pow(Math.sin(Math.PI * Math.min(0.999, 0.06 + 0.94 * t)), 0.6),
  // snake plant / spiky: near-parallel sides, tapering over the last third
  sword: t => (t < 0.66 ? 0.8 + 0.3 * t : Math.max(0, 1 - (t - 0.66) / 0.34)),
  // corn / dracaena strap: a short narrowing into the cane, then parallel
  // sides for most of the length, tapering over the last ~30 % to a point
  strap: t => (t < 0.06 ? 0.55 + 7 * t : t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3)),
  // a petiole-then-blade leaf (peace lily on its long stalk): stalk for the
  // first 40 % of the length, then a lance blade
  stalked: t => (t < 0.4 ? 0.07 : Math.pow(Math.sin(Math.PI * Math.min(1, (t - 0.4) / 0.6)), 0.7)),
};

export function leafGeometry(THREE, spec) {
  const {
    base, ang, len, width, pitch0, pitch1, segs, shape, fold = 0.18, bendPow = 1.4, pitches, roll = 0, rowT,
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
  // Row placement. With n >= 2 segments the rows sit at t = i/n (row 0 at
  // the base). With ONE segment that would leave only the base row and
  // the tip -- a needle whose widest point is the narrow base. So a
  // one-segment leaf is a DIAMOND instead: a single base point, one row at
  // the profile's widest t, and the tip (4 faces a side instead of 2).
  // `rowT` (optional, one t per segment) places the rows explicitly along
  // the spine instead of at t = i/n -- e.g. a strap leaf puts its two rows
  // just past the base and ~2/3 along, so it is wide for most of its length.
  const diamond = n === 1 && !rowT;
  const spineAt = t => {
    const f = Math.min(n - 1e-9, Math.max(0, t * n)), k = Math.floor(f);
    return spine[k].clone().lerp(spine[k + 1], f - k);
  };
  let tw = 0.5;
  if (diamond) {
    let best = -1;
    for (let k = 1; k < 20; k++) { const w = prof(k / 20); if (w > best) { best = w; tw = k / 20; } }
  }
  const pos = [];
  if (diamond) pos.push(base.x, base.y, base.z);
  for (let i = 0; i < n; i++) {                       // rows 0..n-1: edge, midrib, edge
    const t = diamond ? tw : (rowT ? rowT[i] : i / n);
    const hw = (width / 2) * prof(t);
    const c = diamond ? spine[0].clone().lerp(spine[1], tw) : (rowT ? spineAt(t) : spine[i]);
    const pitch = diamond ? rowPitch(0, 1) : rowPitch(i, n);
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
  const o = diamond ? 1 : 0;                           // offset past the base point
  // the two edge polylines (base to tip), for margin strips
  const left = [], right = [];
  if (diamond) { left.push(base.clone()); right.push(base.clone()); }
  for (let i = 0; i < n; i++) {
    const r = o * 3 + i * 9;
    left.push(new THREE.Vector3(pos[r], pos[r + 1], pos[r + 2]));
    right.push(new THREE.Vector3(pos[r + 6], pos[r + 7], pos[r + 8]));
  }
  left.push(tip.clone()); right.push(tip.clone());
  const tipIdx = o + n * 3;
  const idx = [];
  if (diamond) idx.push(0, 1, 2, 0, 2, 3);             // base point -> the widest row
  for (let i = 0; i < n - 1; i++) {
    const a = i * 3, b = (i + 1) * 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const l = o + (n - 1) * 3;
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
  geo.userData.spine = spine.map(v => v.clone());   // the leaf's midline, base to tip
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
    case 'bowl':                                    // squat glazed bowl on a foot ring
      prof = low ? [[0, 0], [0.8, 0], [0.72, 0.1], [1.0, 0.6], [0.98, 1]]
        : [[0, 0], [1.08, 0], [1.1, 0.06], [0.72, 0.1], [0.95, 0.5], [1.02, 0.85], [0.98, 1]];
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
  if (low && prof.length > 5 && (style === 'egg' || style === 'glass-bubble')) {
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
      const f = 1 + 0.08 * Math.cos(a * radial / 2);    // +/- on alternate columns: visible ribs
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
  const { THREE, p, low, rand, leafRand, add } = ctx;
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
    const foot = V(THREE, bx, rimY - 0.05, bz);
    add(tube(THREE, foot, top, caneR * 1.1, caneR, 5, true), 'matte', '#4a3622', 'cane');
    // a point ON the cane's axis at height y (the cane leans), where a leaf attaches
    const onCane = y => foot.clone().lerp(top, (y - foot.y) / (top.y - foot.y));
    if (!low) {
      // pale ring scars banding the bare cane below its tuft (full detail
      // only): short, slightly proud rings in a pale tan
      const bare = plantH * fr * 0.8 - 0.35;
      const rings = bare > 0.1 ? Math.min(2, Math.floor(bare / 0.12)) : 0;
      for (let r = 1; r <= rings; r++) {
        const t = r / (rings + 1) * Math.max(0, bare) / (plantH * fr + 0.05);
        const c = V(THREE, bx, rimY - 0.05, bz).lerp(top, t);
        add(tube(THREE, c.clone().add(V(THREE, 0, -0.004, 0)), c.clone().add(V(THREE, 0, 0.004, 0)), caneR * 1.25, caneR * 1.25, 5, true), 'matte', '#b9a98a', 'caneBand');
      }
    }
    // TUFT: leaves spiral up the top ~35 cm of the cane (less on short canes)
    const n = LEAVES[s] !== undefined ? LEAVES[s] : LEAVES[LEAVES.length - 1];
    const tuftH = Math.min(0.35, plantH * fr * 0.8);
    const lenScale = s === 0 ? 1 : (s === 1 ? 0.95 : 0.85);
    // the crown radius this cane's leaves aim for: the top tuft spreads to
    // about twice the rim (~60 cm, as photographed; the 1.3 makes up for
    // the arch reaching less far than its aim), the mid/short tufts less
    const reach = s === 0 ? spreadR * 1.3 : spreadR * 0.75;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 1 : i / (n - 1);             // 0 = lowest, 1 = crown
      const y = topY - tuftH * (1 - t);
      const a = i * 2.39996 + leafRand() * 0.5;             // golden-angle spiral
      const up = t > 0.6;                               // upper leaves stand up
      const len = leafLen * lenScale * (0.9 + 0.2 * leafRand());
      // Every leaf ARCHES in two segments: it rises at pitch `a`, then its
      // outer half droops at a - bend. Its horizontal reach is then
      // len/2 * (cos a + cos(a - bend)) = len cos(bend/2) cos(a - bend/2),
      // so `a` is solved in closed form for a target reach inside the crown:
      // the leaf keeps its full photographed length and only its angle
      // changes. Upper leaves: short reach, gentle bend (they stand up);
      // lower leaves: long reach, strong bend (they splay out and droop).
      const at = onCane(y);
      const baseOff = Math.hypot(at.x, at.z);
      const want = Math.max(0.02, (reach - baseOff - leafW / 2) * (up ? 0.75 + 0.25 * leafRand() : 0.85 + 0.15 * leafRand()));
      // lower/middle leaves bend hard enough that their tips droop BELOW
      // horizontal (the photographed fountain); crown leaves arch gently
      const bend = up ? 0.8 + 0.5 * leafRand() : 1.7 + 0.5 * leafRand();
      const maxReach = len * Math.cos(bend / 2);
      const aRise = bend / 2 + Math.acos(Math.min(1, want / maxReach));
      const pitches = [Math.min(1.55, aRise), Math.min(1.55, aRise) - bend];
      // low detail is one straight segment: aim it so it reaches as far out
      // as the arched full-detail leaf does (same footprint at both details)
      const m = (pitches[0] + pitches[1]) / 2;
      const lowPitch = Math.sign(m || 1) * Math.acos(Math.min(1, Math.cos((pitches[0] - pitches[1]) / 2) * Math.cos(m)));
      const segs = low ? 1 : 2;
      add(leafGeometry(THREE, {
        base: at, ang: a, len, width: leafW,
        pitch0: pitches[0], pitch1: pitches[1], pitches: low ? [lowPitch] : pitches, segs, shape: 'strap', fold: 0.2,
        rowT: low ? undefined : [0, 0.66],   // row 0 AT the base: attached to the cane
        roll: (leafRand() - 0.5) * 1.6,
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
  // Kept at BOTH details (3-sided at low): the wire carries the top apex
  // that sets the envelope's height, so dropping it would make the fit
  // stretch the ceramic and move its rim at low detail.
  {
    const r = Math.max(0.0015, W * 0.007);
    const edges = [[B, BL], [B, BR], [B, F], [BL, BR], [BR, F], [F, BL], [U, BL], [U, BR], [U, F]];
    edges.forEach(([a, b]) => add(tube(THREE, a, b, r, r, low ? 3 : 4, true), 'metal', p.frameColor, 'wire'));
  }
  // Contents, rising from the opening's centroid.
  const cx = 0, cz = D / 3, cy = hTop - H * 0.02;
  const room = H - cy;                                  // never above the top apex
  const contents = WALL_CONTENTS.indexOf(p.contents) !== -1 ? p.contents : 'spiky';
  let n, shape, lenR, wid, margin = false;
  if (contents === 'spiky') { n = low ? 3 : 20; shape = 'sword'; lenR = [0.55, 0.95]; wid = 0.02; }
  // the small planter's succulent stands ~6-8 cm tall (a tuft of fleshy
  // leaves reaching almost to the top of the room above the opening)
  else if (contents === 'succulent') { n = low ? 3 : 8; shape = 'oval'; lenR = [0.8, 1.0]; wid = W * 0.16; }
  else { n = low ? 3 : 4; shape = 'sword'; lenR = [0.8, 0.98]; wid = 0.04; margin = !low; }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.6;
    const len = room * (lenR[0] + (lenR[1] - lenR[0]) * rand());
    const pitch0 = contents === 'succulent' ? 1.05 + 0.3 * rand() : 1.35 + 0.15 * rand();
    const pitch1 = contents === 'succulent' ? 0.95 + 0.4 * rand() : 1.2 + 0.25 * rand();
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
  const nFull = Math.max(4, Math.round(p.leafCount));
  const n = low ? Math.min(7, nFull) : nFull;
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
  const { THREE, p, low, rand, leafRand, add } = ctx;
  const trailing = p.habit === 'trailing';
  const trail = trailing ? Math.max(0, p.trail) * CM : 0;
  const pot = buildPot(ctx, p.potStyle, trail);
  const R = (p.potTopDiameter * CM) / 2;
  const leafL = p.leafLength * CM, leafW = p.leafWidth * CM;
  const nLeaves = low ? Math.min(trailing ? 14 : 9, Math.round(p.leafCount * 0.4) + 3) : Math.max(3, Math.round(p.leafCount));
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
      // a gently curved stem: a quadratic from the rim through `mid` to `end`
      const curve = [];
      for (let q = 0; q <= 5; q++) {
        const u = q / 5, w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u;
        curve.push(V(THREE, b.x * w0 + mid.x * w1 + end.x * w2, b.y * w0 + mid.y * w1 + end.y * w2, b.z * w0 + mid.z * w1 + end.z * w2));
      }
      // stems at BOTH details (a 2-segment ribbon at low), so no leaf floats
      add(ribbon(THREE, low ? [curve[0], curve[2], curve[5]] : curve, 0.004), 'matte', '#5f7d3a', 'stem');
      const per = Math.ceil((nLeaves - placed) / (stems - s));
      for (let k = 0; k < per && placed < nLeaves; k++, placed++) {
        const t = per === 1 ? 1 : 0.45 + 0.55 * (k / (per - 1));
        const at = curve[Math.min(5, Math.round(t * 5))];
        const la = a + (k % 2 ? 0.9 : -0.9) * leafRand();
        add(leafGeometry(THREE, {
          base: at, ang: la, len: leafL * (0.8 + 0.3 * leafRand()), width: leafW,
          pitch0: 0.2, pitch1: -0.5 - 0.4 * leafRand(), segs: low ? 1 : 3, shape: 'heart', fold: 0.15,
          roll: (leafRand() - 0.5) * 1.2,   // tilt: leaves face every which way, not all flat
        }), 'matte', p.leafColor, 'leaf');
      }
    }
    return;
  }
  // TRAILING: a crown of leaves on the pot plus vines hanging to y = 0
  const vines = low ? 3 : Math.max(2, Math.round(p.stemCount));
  // a full crown on the pot: ~40 % of the leaves; the rest along the vines
  const perVine = Math.max(2, Math.round(nLeaves * 0.4));
  let placed = 0;
  for (let i = 0; i < perVine; i++, placed++) {                 // crown
    add(leafGeometry(THREE, {
      base: V(THREE, (leafRand() - 0.5) * R * 1.4, pot.rimY, (leafRand() - 0.5) * R * 1.4), ang: (i / perVine) * Math.PI * 2 + leafRand() * 0.6,
      len: leafL, width: leafW, pitch0: 0.9 + 0.4 * leafRand(), pitch1: -0.1 - 0.4 * leafRand(), segs: low ? 1 : 2, shape: 'heart',
      roll: (leafRand() - 0.5) * 1.0,
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
        base: at, ang: a + (k % 2 ? 1.2 : -1.2), len: leafL * (0.75 + 0.25 * leafRand()), width: leafW,
        pitch0: -0.2, pitch1: -1.1, segs: 1, shape: 'heart', fold: 0.12,   // diamonds: dense vines within the cap
      }), 'matte', p.leafColor, 'leaf');
    }
  }
}

// =====================================================================
// FICUS (small thick-trunk tree)
// =====================================================================
function buildFicus(ctx) {
  const { THREE, p, low, rand, leafRand, add } = ctx;
  const pot = buildPot(ctx, p.potStyle, 0);
  const R = (p.potTopDiameter * CM) / 2;
  if (p.potStyle === 'bowl') {                                   // saucer (both details: it sets the footprint)
    const sc = low
      ? lathe(THREE, [[R * 1.22, 0], [R * 1.28, 0.012], [R * 1.1, 0.012]], 8, 0, 0)   // bottom-to-top: faces point outward, plus a top ledge
      : new THREE.CylinderGeometry(R * 1.28, R * 1.22, 0.012, 12, 1, false);
    if (!low) sc.translate(0, 0.006, 0);
    add(sc, 'gloss', p.potColor, 'saucer');
  }
  const top = pot.rimY + p.plantHeight * CM;
  const trunkTop = V(THREE, 0, pot.rimY + p.plantHeight * CM * 0.28, 0);
  add(tube(THREE, V(THREE, 0, pot.rimY - 0.02, 0), trunkTop, 0.022, 0.012, low ? 4 : 7, true), 'matte', '#6b5a44', 'trunk');
  const branches = Math.max(2, Math.round(p.stemCount));
  const nLeaves = low ? 10 : Math.max(branches * 3, Math.round(p.leafCount));
  const reach = (p.spread * CM) / 2;
  let placed = 0;
  for (let b = 0; b < branches; b++) {
    const a = (b / branches) * Math.PI * 2 + rand() * 0.7;
    const end = V(THREE, Math.sin(a) * reach * (0.35 + 0.3 * rand()), top - p.plantHeight * CM * (0.1 + 0.3 * rand()), Math.cos(a) * reach * (0.35 + 0.3 * rand()));
    add(tube(THREE, trunkTop, end, 0.008, 0.004, low ? 3 : 5, true), 'matte', '#6b5a44', 'branch');
    if (low) {
      // low detail: two BIG leaves at the branch tip, pointing outward --
      // standing in for the tip cluster (so it reads as foliage, not a bare
      // twig) and sitting where the full build's outermost leaves are, so
      // the footprint and the fit match the full build
      for (const side of [-0.5, 0.5]) {
        add(leafGeometry(THREE, {
          base: end, ang: a + side, len: p.leafLength * CM * 1.0, width: p.leafWidth * CM * 1.8,
          pitch0: 0.5, pitch1: -0.2, segs: 1, shape: 'oval', fold: 0.1,
        }), 'gloss', p.leafColor, 'leaf');
      }
      continue;
    }
    const each = Math.ceil((nLeaves - placed) / (branches - b));
    for (let k = 0; k < each && placed < nLeaves; k++, placed++) {
      // leaves cluster toward the branch tips
      const t = 0.6 + 0.4 * Math.sqrt(leafRand());
      const at = trunkTop.clone().lerp(end, t);
      add(leafGeometry(THREE, {
        base: at, ang: leafRand() * Math.PI * 2, len: p.leafLength * CM * (0.8 + 0.4 * leafRand()), width: p.leafWidth * CM,
        pitch0: 0.5 + 0.4 * leafRand(), pitch1: -0.2, segs: 1, shape: 'oval', fold: 0.1,
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
  const { THREE, p, low, rand, leafRand, add } = ctx;
  const pot = buildPot(ctx, p.potStyle, 0);
  const stems = Math.max(1, Math.round(p.stemCount));
  const nPads = low ? 8 : Math.max(stems * 2, Math.round(p.leafCount));
  const h = p.plantHeight * CM, reach = (p.spread * CM) / 2;
  let placed = 0;
  for (let s = 0; s < stems; s++) {
    // short stems leaning out a little; each ends in a compact ROSETTE of
    // fleshy pads spiralling round its tip, cupped upward
    const a = (s / stems) * Math.PI * 2 + rand() * 0.8;
    const b = V(THREE, (rand() - 0.5) * pot.innerR * 0.6, pot.rimY - 0.01, (rand() - 0.5) * pot.innerR * 0.6);
    const e = V(THREE, Math.sin(a) * reach * 0.35, pot.rimY + h * (0.35 + 0.25 * rand()), Math.cos(a) * reach * 0.35);
    add(tube(THREE, b, e, 0.006, 0.004, low ? 4 : 5, true), 'matte', '#6f6a3e', 'stem');
    const each = Math.ceil((nPads - placed) / (stems - s));
    for (let k = 0; k < each && placed < nPads; k++, placed++) {
      const at = b.clone().lerp(e, 0.88 + 0.12 * (k / Math.max(1, each - 1)));
      const inner = k >= each / 2;                       // inner pads stand up, outer ones splay
      add(padGeometry(THREE, at, k * 2.39996 + leafRand() * 0.3, inner ? 1.0 + 0.3 * leafRand() : 0.45 + 0.3 * leafRand(),
        p.leafLength * CM * (inner ? 0.75 : 1) * (0.9 + 0.2 * leafRand()), p.leafWidth * CM, p.leafWidth * CM * 0.35, low), 'satin', p.leafColor, 'leaf');
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
 * against objects of known size (spec pages say so). Each preset's
 * width/depth is the footprint its own seeded layout naturally builds to,
 * so the envelope fit scales x and z by ~1 and the pot stays ROUND and true
 * to its diameter (a mismatched envelope would stretch it into an oval). */
export const PRESETS = Object.freeze({
  'corn-plant-tall': Object.freeze({
    kind: 'corn-plant', width: 60, depth: 59.5, height: 166,
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
    kind: 'peace-lily', width: 38.5, depth: 45.5, height: 55,
    potStyle: 'glass-bubble', potHeight: 16, potTopDiameter: 18, glassColor: '#dcecef',
    plantHeight: 41.3, leafCount: 10, leafLength: 24, leafWidth: 7, leafColor: '#1d3a1e', accentColor: '#9fae84', seed: 11,
  }),
  'snake-plant-small': Object.freeze({
    kind: 'snake-plant', width: 15.5, depth: 18, height: 38,
    potStyle: 'tapered', potHeight: 13, potTopDiameter: 15, potColor: '#c99a8e',
    plantHeight: 29.8, leafCount: 3, leafWidth: 4.5, leafColor: '#35502a', accentColor: '#c9c46a', seed: 12,
  }),
  'pothos-upright-ribbed-pot': Object.freeze({
    kind: 'pothos', habit: 'upright', width: 32, depth: 33, height: 30,
    potStyle: 'ribbed-footed', potHeight: 14, potTopDiameter: 11, potColor: '#f1efea',
    plantHeight: 33.2, stemCount: 4, spread: 34, leafCount: 8, leafLength: 9, leafWidth: 6, leafColor: '#2f5a24', seed: 13,
  }),
  'pothos-trailing': Object.freeze({
    kind: 'pothos', habit: 'trailing', trail: 50, width: 50.5, depth: 38.5, height: 70,
    potStyle: 'cylinder', potHeight: 14, potTopDiameter: 16, potColor: '#8d8f8c',
    plantHeight: 20, stemCount: 5, spread: 55, leafCount: 40, leafLength: 9, leafWidth: 7, leafColor: '#3f7a2a', seed: 14,
  }),
  'ficus-bowl-pot': Object.freeze({
    kind: 'ficus', width: 26.5, depth: 23.5, height: 42,
    potStyle: 'bowl', potHeight: 11, potTopDiameter: 18, potColor: '#d9cdb4',
    plantHeight: 35.7, stemCount: 4, spread: 30, leafCount: 36, leafLength: 5.5, leafWidth: 3.2, leafColor: '#3c6a2c', seed: 15,
  }),
  'jade-small': Object.freeze({
    kind: 'jade', width: 13, depth: 13.5, height: 28,
    potStyle: 'cylinder', potHeight: 11, potTopDiameter: 12, potColor: '#c8642e',
    plantHeight: 26.8, stemCount: 3, spread: 22, leafCount: 16, leafLength: 5, leafWidth: 2.8, leafColor: '#6f9a45', seed: 16,
  }),
});
