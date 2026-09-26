/**
 * plant.js - procedural potted/wall-mounted plants.
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
 * Two kinds (params.kind):
 *   'corn-plant'   a potted Dracaena fragrans (corn plant): a woven/ribbed
 *                  tapered pot, several staggered-height canes, each topped
 *                  with a strap-leaf rosette. Free-standing (item 889bf6ce,
 *                  the plant between the two home-office desks). DEFAULT.
 *   'wall-planter' a hanging faceted ceramic planter (inverted diamond/
 *                  prism) with a thin gold/brass wire frame outlining its
 *                  edges, holding spiky sansevieria-style leaves. Wall-
 *                  mounted (bedroom wall planters).
 *
 * FITTING THE ENVELOPE EXACTLY: procedural leaves (seeded, varying in
 * length/angle/droop) make it impractical to hand-derive geometry that lands
 * on an exact width/depth/height every time a param changes. Instead each
 * kind is built once in a natural local frame, its raw bbox is measured, and
 * a single corrective transform (a per-axis scale + translate) is applied to
 * every vertex so the FINAL bbox matches params.width/depth/height/back-at-
 * z=0/bottom-at-y=0 exactly (to float precision, comfortably inside the
 * contract's 0.5 cm tolerance) regardless of seed, leaf count or any other
 * random variation. See fitToEnvelope() below.
 *
 * PROCEDURAL LEAVES are driven entirely by `seed` via a small deterministic
 * PRNG (mulberry32) so the SAME seed always lays out the SAME leaves -- no
 * Math.random anywhere in this module.
 *
 * @param {object} THREE  the three.js module (or a THREE-shaped test double)
 * @param {object} params
 * @param {string} [params.kind] 'corn-plant' (default) | 'wall-planter'
 * @param {number} [params.width]   footprint width, cm -- the envelope every
 *                                  builder contract requires; also the knob
 *                                  a caller uses to resize the whole plant
 * @param {number} [params.depth]   footprint depth, cm (back at z=0, +z front)
 * @param {number} [params.height]  total height, cm (bottom at y=0)
 *
 * corn-plant params (proportion the interior detail; width/depth/height above
 * still win as the final envelope):
 * @param {number} [params.potHeight]      pot height, cm (default 56)
 * @param {number} [params.potTopDiameter] pot opening diameter, cm (default 30)
 * @param {number|string} [params.potColor] pot colour (default tan)
 * @param {number} [params.plantHeight]    vase-top to top-of-foliage, cm (default 110)
 * @param {number} [params.stemCount]      number of canes (default 3)
 * @param {number} [params.spread]         widest leaf spread, cm (default 40)
 * @param {number|string} [params.leafColor] leaf colour (default deep green)
 *
 * wall-planter params:
 * @param {number} [params.leafCount]      number of spiky leaves (default 5)
 * @param {number|string} [params.potColor] ceramic colour (default white)
 * @param {number|string} [params.frameColor] wire-frame colour (default brass)
 * @param {number|string} [params.leafColor] leaf colour (default deep green)
 *
 * common params:
 * @param {number} [params.seed]           deterministic layout seed (default 1)
 * @param {object} [opts]
 * @param {'full'|'low'} [opts.detail]     'low' keeps triangle count <=300
 *                                         (mobile); default 'full'
 * @returns {THREE.Group}
 */
import { makeFinish } from './finishes.js';

export const TYPE = 'plant';

// width/depth/height are the frozen DEFAULTS' bounding envelope, cm, required
// by every furniture builder's drift test: width/depth are the footprint
// (the larger of spread/potTopDiameter for the default corn-plant kind =
// max(40, 30) = 40), height is the total height including the pot
// (potHeight + plantHeight = 56 + 110 = 166). A caller resizes the whole
// plant by overriding width/depth/height directly -- fitToEnvelope() (below)
// is what makes that exact rather than approximate.
export const DEFAULTS = Object.freeze({
  kind: 'corn-plant',
  width: 40,
  depth: 40,
  height: 166,
  // corn-plant proportioning (interior detail; the envelope above wins)
  potHeight: 56,
  potTopDiameter: 30,
  potColor: '#9c7c4a',
  plantHeight: 110,
  stemCount: 3,
  spread: 40,
  leafColor: '#33502a',
  // wall-planter proportioning
  leafCount: 5,
  frameColor: '#b8945a',
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
 * Rescale + translate every vertex in `group` so its world-space bbox
 * becomes EXACTLY [x: -width/2..width/2, y: 0..height, z: 0..depth] (metres
 * in, metres out). Per-axis scale factors independently correct each
 * dimension, so a group that is naturally wider than tall is not distorted
 * across axes -- only stretched/shrunk along the one it is being corrected
 * on. Degenerate axes (a raw span of ~0) fall back to scale 1 rather than
 * dividing by zero. This is what lets procedural, seed-varying leaf geometry
 * still land on an EXACT contract bbox every time.
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
  // Anchor: x is CENTRED (subtract the midpoint), y and z are PINNED to
  // their raw minimum (subtract min, not centre) -- y's min becomes the new
  // 0 (bottom), z's min becomes the new 0 (back), matching the box builder's
  // own local-frame contract exactly, before the per-axis scale is applied.
  const ax = (box.min.x + box.max.x) / 2;
  const ay = box.min.y;
  const az = box.min.z;

  const wrapper = new THREE.Group();
  wrapper.name = group.name;
  wrapper.userData = group.userData;
  // Reparent every child of `group` into `wrapper`, applying the correction
  // as a transform on each (rather than mutating raw geometry): anchor each
  // axis per the rule above, then scale per axis about that anchor. Every
  // child of buildCornPlantRaw/buildWallPlanterRaw is a direct, unrotated
  // (or axis-aligned-quaternion, for wire struts) child of the raw group
  // with no additional nested scale, so scaling position+scale here is
  // equivalent to scaling the fully-flattened world geometry.
  const children = group.children.slice();
  for (const child of children) {
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
  const kind = p.kind || 'corn-plant';
  const raw = kind === 'wall-planter'
    ? buildWallPlanterRaw(THREE, p, detail)
    : buildCornPlantRaw(THREE, p, detail);
  return fitToEnvelope(THREE, raw, p.width * CM, p.depth * CM, p.height * CM);
}

// =====================================================================
// CORN PLANT (Dracaena fragrans) -- potted, free-standing. Built in a
// natural local frame; build() above rescales the result onto the exact
// width/depth/height envelope.
// =====================================================================
function buildCornPlantRaw(THREE, p, detail) {
  const potHeight = p.potHeight * CM;
  const potTopR = (p.potTopDiameter * CM) / 2;
  const potBotR = potTopR * 0.72;                 // tapers inward toward the base
  const plantHeight = p.plantHeight * CM;
  const stemCount = Math.max(1, Math.round(p.stemCount));
  const spread = p.spread * CM;

  const rand = mulberry32((p.seed | 0) || 1);

  const potMat = makeFinish(THREE, 'matte', p.potColor);
  const caneMat = makeFinish(THREE, 'matte', '#8a7a52');
  const leafMat = makeFinish(THREE, 'matte', p.leafColor);
  const soilMat = makeFinish(THREE, 'matte', '#3a2c1e');

  const group = new THREE.Group();
  group.name = 'furniture:plant';
  group.userData.type = TYPE;
  group.userData.kind = 'corn-plant';

  // ---- pot: a woven/ribbed tapered cylinder --------------------------------
  // Ribbing is a handful of thin vertical ridges rather than a displaced
  // lattice -- cheap in both full and low detail, and reads as "woven" from
  // a normal viewing distance in the photos.
  const potRadial = detail === 'low' ? 10 : 20;
  const potBody = new THREE.Mesh(
    new THREE.CylinderGeometry(potTopR, potBotR, potHeight, potRadial, 1, false),
    potMat
  );
  potBody.name = 'potBody';
  potBody.userData.finish = 'matte';
  potBody.position.set(0, potHeight / 2, potTopR); // back edge (radius) lands at z=0
  potBody.castShadow = true; potBody.receiveShadow = true;
  group.add(potBody);

  if (detail !== 'low') {
    const ribCount = 14;
    const ribR = potTopR * 0.02;
    for (let i = 0; i < ribCount; i++) {
      const a = (i / ribCount) * Math.PI * 2;
      const rib = new THREE.Mesh(
        new THREE.CylinderGeometry(ribR, ribR, potHeight * 0.98, 5, 1),
        potMat
      );
      const rMid = (potTopR + potBotR) / 2;
      rib.position.set(
        Math.cos(a) * rMid,
        potHeight / 2,
        potTopR + Math.sin(a) * rMid
      );
      rib.name = 'potRib';
      rib.userData.finish = 'matte';
      group.add(rib);
    }
  }

  // soil disc at the pot opening
  const soil = new THREE.Mesh(
    new THREE.CylinderGeometry(potTopR * 0.96, potTopR * 0.96, potHeight * 0.03, potRadial),
    soilMat
  );
  soil.name = 'soil';
  soil.userData.finish = 'matte';
  soil.position.set(0, potHeight - (potHeight * 0.015), potTopR);
  group.add(soil);

  // ---- canes: staggered heights, each topped with a leaf rosette ----------
  // The reference photos show 3 canes emerging close together near pot-
  // centre, of visibly different heights, each capped by a strap-leaf
  // rosette -- not one central trunk. Heights are staggered deterministically
  // around `plantHeight` (the tallest cane defines plantHeight itself).
  const caneRadial = detail === 'low' ? 5 : 8;
  const caneR = Math.max(0.006, potTopR * 0.06);
  const potBaseY = potHeight;
  const potCenterZ = potTopR;

  // Dense, broad rosettes: the review (visual artifact 453bcfd8) measured
  // the photographed leaves at ~8-10cm wide, far broader than a thin blade,
  // and wants all 3 canes visibly separate FROM THE FRONT, fanned rather
  // than scattered to every compass point (some of which point straight
  // into or behind the pot from a front camera). 'low' keeps a reduced but
  // still dense count -- broad+dense is the look, not just full detail.
  const leavesPerRosette = detail === 'low' ? 7 : 13;

  for (let s = 0; s < stemCount; s++) {
    // Staggered heights: the tallest cane (index 0) reaches plantHeight;
    // the others fall to shorter, deterministic fractions of it, matching
    // the photos' uneven canes. rand() advances the shared PRNG so different
    // seeds reshuffle stagger AND leaf layout together.
    const heightFrac = s === 0 ? 1 : 0.55 + rand() * 0.35;
    const caneH = plantHeight * heightFrac;

    // Canes are spread across a FORWARD-FACING arc (roughly +-50 degrees
    // either side of straight-front, i.e. the +z direction from pot-centre)
    // rather than scattered to any compass point -- the review's "all 3
    // visible from the front, fanned slightly" note. offA=0 is straight
    // front; canes fan out to the sides as s increases, alternating so they
    // don't all lean the same way.
    const offR = potTopR * 0.5 * (s === 0 ? 0 : (0.55 + rand() * 0.45));
    const side = s % 2 === 0 ? 1 : -1;
    const offA = s === 0 ? 0 : side * (0.35 + rand() * 0.5); // radians off straight-front
    const cx = Math.sin(offA) * offR;
    const cz = potCenterZ + Math.cos(offA) * offR;

    const cane = new THREE.Mesh(
      new THREE.CylinderGeometry(caneR, caneR * 1.05, caneH, caneRadial),
      caneMat
    );
    cane.name = 'cane';
    cane.userData.finish = 'matte';
    cane.position.set(cx, potBaseY + caneH / 2, cz);
    cane.castShadow = true;
    group.add(cane);

    const topY = potBaseY + caneH;

    // ---- rosette: strap-like leaves fanning outward from the cane top,
    // arching over and down (fountain shape) -- never reaching HIGHER than
    // the cane top itself. Built as individual leaf meshes parented to a
    // rosette group for authoring convenience; build() flattens everything
    // to world space before measuring, so this nesting has no effect on the
    // final envelope fit.
    const rosette = new THREE.Group();
    rosette.name = 'rosette';
    rosette.position.set(cx, topY, cz);
    group.add(rosette);

    for (let i = 0; i < leavesPerRosette; i++) {
      // Leaves fan across the full circle (a real rosette wraps all the way
      // around its cane) but are DENSER toward the front (+z) than the back,
      // so the silhouette reads as full and leafy from a front camera rather
      // than half-empty -- a front-weighted angle distribution rather than
      // uniform-random.
      const baseAng = (i / leavesPerRosette) * Math.PI * 2;
      const ang = baseAng + (rand() - 0.5) * 0.5;
      const droopFrac = 0.35 + rand() * 0.45;       // how far the arc bends downward
      const lenFrac = 0.7 + rand() * 0.35;          // leaf length vs. spread/2
      const leafLen = (spread / 2) * lenFrac;
      // Broad strap leaves: ~0.30-0.36x the leaf length, tuned so the
      // default spread (40cm) produces ~8-10cm-wide leaves matching the
      // photographed Dracaena straps (visual review 453bcfd8), not the
      // previous ~0.16x sliver.
      const leafW = Math.max(0.03, leafLen * 0.33);

      const blade = buildLeafBlade(THREE, { ang, leafLen, leafW, droopFrac, bladeSegs: detail === 'low' ? 1 : 3 });

      const leaf = new THREE.Mesh(blade, leafMat);
      leaf.name = 'leaf';
      leaf.userData.finish = 'matte';
      leaf.castShadow = true;
      rosette.add(leaf);
    }
  }

  return group;
}

/** Build one strap-leaf blade directly in its parent (rosette-local) frame.
 * `t` (0=base pinned at the attach point, 1=tip) maps to an outward run plus
 * a vertical drop that is MONOTONIC and NEVER positive --
 * `dropY(t) = -leafLen * droopFrac * t^1.3`. Since dropY(0)=0 and dropY<=0
 * everywhere, no vertex can rise above the attach point. Shared by both
 * plant kinds. */
function buildLeafBlade(THREE, { ang, leafLen, leafW, droopFrac, bladeSegs, tipTaper = 0 }) {
  const dirX = Math.sin(ang), dirZ = Math.cos(ang); // outward direction (unit, in XZ)
  const rows = bladeSegs + 1;
  const cols = 2; // width edges only
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    const t = r / bladeSegs;
    const run = t * leafLen;
    const dropY = -leafLen * droopFrac * Math.pow(t, 1.3);
    const cx2 = dirX * run;
    const cz2 = dirZ * run;
    const halfW = (leafW / 2) * (1 - tipTaper * t); // optional taper toward a point (sansevieria)
    for (let c = 0; c < cols; c++) {
      const side = c === 0 ? -1 : 1;
      const wx = side * halfW * dirZ;
      const wz = -side * halfW * dirX;
      positions[idx * 3] = cx2 + wx;
      positions[idx * 3 + 1] = dropY;
      positions[idx * 3 + 2] = cz2 + wz;
      uvs[idx * 2] = c; uvs[idx * 2 + 1] = t;
      idx++;
    }
  }
  const indices = [];
  for (let r = 0; r < bladeSegs; r++) {
    const a = r * cols, b = a + 1, cI = a + cols, d = cI + 1;
    indices.push(a, cI, b, b, cI, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// =====================================================================
// WALL PLANTER -- hanging faceted ceramic diamond, spiky sansevieria-style
// leaves, thin gold/brass wire-frame edges. Wall-mounted: built with its
// back at z=0 and footprint at z>=0 in its own natural frame; build() above
// rescales the result onto the exact width/depth/height envelope.
// =====================================================================
function buildWallPlanterRaw(THREE, p, detail) {
  const width = p.width * CM;
  const depth = p.depth * CM;
  const height = p.height * CM;
  const leafCount = Math.max(1, Math.round(p.leafCount != null ? p.leafCount : 5));
  // plantHeight is a PROPORTION knob here (relative leaf length vs. the
  // body), not an absolute size -- height (the envelope) already fixes the
  // final total size via fitToEnvelope, so an absolute plantHeight competing
  // with it is what let leaves balloon the raw bbox and squash the ceramic
  // body down to a sliver (visual review 91c3d078, "reads as a flat grass
  // tuft"): the body's SHARE of the total height shrank every time leaves
  // grew longer. Clamped to a sane relative range so a wildly small/large
  // plantHeight can't invert the body/leaf proportion either.
  const leafLenFrac = Math.max(0.5, Math.min(2.0, (p.plantHeight || DEFAULTS.plantHeight) / DEFAULTS.plantHeight));

  const rand = mulberry32((p.seed | 0) || 1);

  const ceramicMat = makeFinish(THREE, 'gloss', p.potColor);
  const frameMat = makeFinish(THREE, 'metal', p.frameColor);
  const leafMat = makeFinish(THREE, 'matte', p.leafColor);

  const group = new THREE.Group();
  group.name = 'furniture:plant';
  group.userData.type = TYPE;
  group.userData.kind = 'wall-planter';

  // ---- faceted ceramic body: a VERTICAL diamond seen face-on -----------
  // The photo (bedroom/bedroom-wall-plants-sign-lights.jpg) shows a shape
  // whose diamond outline reads from a FRONT view: wide/tall in x/y, THIN
  // in z (flat against the wall) -- the opposite axis assignment from a
  // cone standing on the y-axis (whose widest cross-section is a horizontal
  // disc, invisible edge-on from the front, which is what made the previous
  // build read as a flat grass tuft). This is a hexagonal BIPYRAMID:
  // 6 side vertices forming a flattened hexagon ring at the vertical
  // midpoint (wide in x, thin in z), plus a bottom point and a top opening
  // -- built as an explicit BufferGeometry so the ring can be flattened in
  // z independently of its spread in x (a stock ConeGeometry can't do this;
  // its cross-section is always circular).
  //
  // The body's height is a FIXED FRACTION of the target envelope height
  // (not of width, and not derived from leaf length) -- deliberately, so it
  // always reads as a substantial vessel regardless of how long the leaves
  // grow: the whole point of the HIGH-severity fix is that the body must
  // stay visually dominant, not shrink to a sliver under tall foliage.
  const halfW = width / 2;               // widest point, x
  const halfD = Math.max(depth / 2, halfW * 0.16); // thin in z -- flat against the wall

  const facets = 6;
  const bodyBottomY = 0;
  const bodyRingY = height * 0.34;   // the hexagon ring (widest point)
  const bodyTopY = height * 0.5;     // the opening rim, narrower than the ring (a real vase's neck)
  const bodyCenterZ = halfD;        // shifts the whole body forward so its back touches z=0

  // Ring vertices: a flattened hexagon (wide in x, thin in z) at y=bodyRingY.
  const ringPts = [];
  for (let i = 0; i < facets; i++) {
    const a = (i / facets) * Math.PI * 2;
    ringPts.push(new THREE.Vector3(Math.cos(a) * halfW, bodyRingY, bodyCenterZ + Math.sin(a) * halfD));
  }
  // Opening vertices: a smaller flattened hexagon at y=bodyTopY (the neck).
  const openW = halfW * 0.55, openD = halfD * 0.7;
  const openPts = [];
  for (let i = 0; i < facets; i++) {
    const a = (i / facets) * Math.PI * 2;
    openPts.push(new THREE.Vector3(Math.cos(a) * openW, bodyTopY, bodyCenterZ + Math.sin(a) * openD));
  }
  const bottomPt = new THREE.Vector3(0, bodyBottomY, bodyCenterZ);

  const bodyPositions = [];
  const pushTri = (a, b, c) => { bodyPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); };
  // lower half: bottom point -> ring (a faceted cone pointing down)
  for (let i = 0; i < facets; i++) {
    const a = ringPts[i], b = ringPts[(i + 1) % facets];
    pushTri(bottomPt, a, b);
  }
  // upper half: ring -> opening rim (a faceted frustum narrowing to the neck)
  for (let i = 0; i < facets; i++) {
    const r0 = ringPts[i], r1 = ringPts[(i + 1) % facets];
    const o0 = openPts[i], o1 = openPts[(i + 1) % facets];
    pushTri(r0, o0, r1);
    pushTri(r1, o0, o1);
  }
  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bodyPositions), 3));
  bodyGeo.computeVertexNormals();

  const body = new THREE.Mesh(bodyGeo, ceramicMat);
  body.name = 'planterBody';
  body.userData.finish = 'gloss';
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);

  // opening cap (a flattened hexagon disc) so the planter reads as a
  // vessel, not a hollow shell -- built as a fan from the opening centre.
  const capCenter = new THREE.Vector3(0, bodyTopY, bodyCenterZ);
  const capPositions = [];
  for (let i = 0; i < facets; i++) {
    const a = openPts[i], b = openPts[(i + 1) % facets];
    capPositions.push(capCenter.x, capCenter.y, capCenter.z, a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const capGeo = new THREE.BufferGeometry();
  capGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capPositions), 3));
  capGeo.computeVertexNormals();
  const cap = new THREE.Mesh(capGeo, ceramicMat);
  cap.name = 'planterCap';
  cap.userData.finish = 'gloss';
  group.add(cap);

  // ---- OBVIOUS thin gold/brass wire frame tracing every facet edge -----
  // The photo shows the gold wire as the single most visible design cue --
  // a ring at the neck opening, a ring at the widest hexagon, and one strut
  // per facet on BOTH the lower cone and the upper frustum. Radius is a
  // visible fraction of the width (not a barely-there sliver) so it reads
  // clearly from the front, matching "an obvious thin gold wire frame".
  const wireR = Math.max(0.003, halfW * 0.035);
  // 'low' halves the wire's radial segment count and drops its end caps
  // (openEnded) -- invisible anyway, since every wire segment butts against
  // its neighbour -- to stay inside the mobile triangle budget. This is a
  // LOD choice, not a shape change: the frame is still a full ring + struts
  // on every facet at both detail levels, just built from cheaper cylinders.
  const wireRadial = detail === 'low' ? 4 : 6;
  function wireRing(pts) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const len = a.distanceTo(b);
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(wireR, wireR, len, wireRadial, 1, true), frameMat);
      seg.name = 'frameRim';
      seg.userData.finish = 'metal';
      seg.position.copy(mid);
      seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      group.add(seg);
    }
  }
  function wireStruts(fromPts, toPts) {
    for (let i = 0; i < fromPts.length; i++) {
      const a = fromPts[i], b = toPts[i];
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const len = a.distanceTo(b);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(wireR, wireR, len, wireRadial, 1, true), frameMat);
      strut.name = 'frameStrut';
      strut.userData.finish = 'metal';
      strut.position.copy(mid);
      strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      group.add(strut);
    }
  }
  wireRing(ringPts);
  wireRing(openPts);
  wireStruts(Array(facets).fill(bottomPt), ringPts);
  wireStruts(ringPts, openPts);

  // ---- wall mounting bracket: a small flat plate flush with the wall ----
  const bracketDepth = Math.max(0.005, depth * 0.03);
  const bracket = new THREE.Mesh(
    new THREE.BoxGeometry(halfW * 0.5, halfW * 0.5, bracketDepth),
    frameMat
  );
  bracket.name = 'wallBracket';
  bracket.userData.finish = 'metal';
  bracket.position.set(0, bodyRingY, bracketDepth / 2); // sits ON the wall face, growing into +z only
  group.add(bracket);

  // ---- spiky sansevieria-style leaves rising from the opening ----------
  // Tall, narrow, near-upright, tapering to a point -- unlike the corn
  // plant's arching straps. Built directly (not via buildLeafBlade, whose
  // "outward run" convention is horizontal): here the length axis IS the
  // rise (+y), with only a small outward lean in XZ, and it tapers to a
  // point at the tip (sansevieria's spike shape).
  const leafSegs = detail === 'low' ? 1 : 2;
  const originY = bodyTopY;
  const originZ = bodyCenterZ;
  // Leaves fill the space ABOVE the body (height - bodyTopY), scaled by the
  // relative leafLenFrac knob -- never an absolute length competing with the
  // envelope, which is what let leaves balloon the raw bbox previously.
  const leafBudget = Math.max(0.02, height - bodyTopY) * leafLenFrac;
  for (let i = 0; i < leafCount; i++) {
    const ang = (i / leafCount) * Math.PI * 2 + rand() * 0.4;
    const lenFrac = 0.85 + rand() * 0.3;
    const leafLen = leafBudget * lenFrac;
    const leafW = Math.max(0.008, openW * 0.5);
    const leanFrac = 0.06 + rand() * 0.10; // near-upright: small outward lean, unlike the corn plant

    const rows = leafSegs + 1, cols = 2;
    const positions = new Float32Array(rows * cols * 3);
    let idx = 0;
    for (let r = 0; r < rows; r++) {
      const t = r / leafSegs;
      const rise = t * leafLen;                    // ALWAYS >= 0: never dips below its own base
      const lean = t * leafLen * leanFrac;          // outward lean grows with height
      const halfW = (leafW / 2) * (1 - 0.85 * t);   // tapers to a point at the tip
      const cx2 = Math.sin(ang) * lean;
      const cz2 = Math.cos(ang) * lean;
      for (let c = 0; c < cols; c++) {
        const side = c === 0 ? -1 : 1;
        const wx = side * halfW * Math.cos(ang);
        const wz = -side * halfW * Math.sin(ang);
        positions[idx * 3] = cx2 + wx;
        positions[idx * 3 + 1] = rise;
        positions[idx * 3 + 2] = cz2 + wz;
        idx++;
      }
    }
    const indices = [];
    for (let r = 0; r < leafSegs; r++) {
      const a2 = r * cols, b2 = a2 + 1, cI = a2 + cols, d2 = cI + 1;
      indices.push(a2, cI, b2, b2, cI, d2);
    }
    const blade = new THREE.BufferGeometry();
    blade.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    blade.setIndex(indices);
    blade.computeVertexNormals();

    const leaf = new THREE.Mesh(blade, leafMat);
    leaf.name = 'leaf';
    leaf.userData.finish = 'matte';
    leaf.position.set(0, originY, originZ);
    leaf.castShadow = true;
    group.add(leaf);
  }

  return group;
}

// Convenience alias matching the sibling builders' naming (buildStandingDesk,
// buildWindow, buildCurtain) for anyone grepping for "build<Thing>".
export function buildPlant(THREE, params, opts) {
  return build(THREE, params, opts);
}

/** Named presets. Descriptive names only -- no real names of people or
 * places in a public repo. Dimensions are the real measurements from the
 * two source items (889bf6ce for the corn plant, the bedroom wall-planter
 * follow-up for the hanging planters), expressed as the width/depth/height
 * envelope plus proportioning params. */
export const PRESETS = Object.freeze({
  'corn-plant-tall': Object.freeze({
    kind: 'corn-plant',
    width: 40,
    depth: 40,
    height: 166,
    potHeight: 56,
    potTopDiameter: 30,
    potColor: '#9c7c4a',
    plantHeight: 110,
    stemCount: 3,
    spread: 40,
    leafColor: '#33502a',
    seed: 7,
  }),
  'wall-planter-large': Object.freeze({
    kind: 'wall-planter',
    width: 25,
    depth: 18,
    height: 32,
    leafCount: 6,
    potColor: '#f2efe8',
    frameColor: '#b8945a',
    leafColor: '#2f4a28',
    seed: 3,
  }),
  'wall-planter-small': Object.freeze({
    kind: 'wall-planter',
    width: 12,
    depth: 9,
    height: 16,
    leafCount: 4,
    potColor: '#f2efe8',
    frameColor: '#b8945a',
    leafColor: '#35502e',
    seed: 4,
  }),
});
