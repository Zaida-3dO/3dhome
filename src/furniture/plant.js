/**
 * plant.js - procedural potted/wall-mounted plants.
 *
 * Two kinds:
 *   'corn-plant'   a potted Dracaena fragrans (corn plant): a woven/ribbed
 *                  tapered pot, several staggered-height canes, each topped
 *                  with a strap-leaf rosette. Free-standing (item 889bf6ce,
 *                  the plant between the two home-office desks).
 *   'wall-planter' a hanging faceted ceramic planter (inverted diamond/
 *                  prism) with a thin gold/brass wire frame outlining its
 *                  edges, holding spiky sansevieria-style leaves. Wall-
 *                  mounted (bedroom wall planters, three of them).
 *
 * Pure builder, same convention as wall-fittings.js / standing-desk.js: THREE
 * is passed in rather than imported (no bare `import 'three'`), so this
 * module has no import-map dependency and can be loaded by a plain Node test
 * or a spec page.
 *
 * LOCAL FRAME (metres):
 *   corn-plant:   x across (centred on 0), y up (0 = pot bottom), z depth
 *                 with the pot's BACK edge at z=0 (free-standing, sits
 *                 against/near a wall, plant leans toward +z).
 *   wall-planter: x across (centred on 0), y up (0 = the planter's lowest
 *                 point), z depth with the planter's BACK (the wall-
 *                 mounted face) at z=0, facing +z into the room. Elevation
 *                 on the wall is applied by the placer, not this module.
 *
 * PROCEDURAL LEAVES are driven entirely by `seed` via a small deterministic
 * PRNG (mulberry32) so the SAME seed always lays out the SAME leaves -- no
 * Math.random anywhere in this module.
 *
 * MERGE FIDELITY (the live renderer merges meshes by finish): every mesh
 * this module creates carries `userData.finish`, one of 'matte' | 'gloss' |
 * 'metal' | 'glass' | 'mirror' | 'emissive' -- flat colours only, no
 * textures. Per-leaf colour variation (where used) rides vertex colours
 * instead of separate materials, since vertex colours survive a merge and
 * separate materials would defeat it. Neither kind built here uses glass or
 * emissive meshes, so nothing needs `userData.keep = true` yet -- but any
 * future kind that adds one (a glazed pot, a grow-light) MUST set it, since
 * those two finishes are excluded from the merge.
 *
 * @param {object} THREE  the three.js module (or a THREE-shaped test double)
 * @param {object} params
 * @param {string} [params.kind] 'corn-plant' (default) | 'wall-planter'
 *
 * corn-plant params:
 * @param {number} [params.potHeight]      pot height, cm (default 56)
 * @param {number} [params.potTopDiameter] pot opening diameter, cm (default 30)
 * @param {number|string} [params.potColor] pot colour (default tan 0x9c7c4a)
 * @param {number} [params.plantHeight]    vase-top to top-of-foliage, cm (default 110)
 * @param {number} [params.stemCount]      number of canes (default 3)
 * @param {number} [params.spread]         widest leaf spread, cm (default 40)
 * @param {number|string} [params.leafColor] leaf colour (default deep green 0x3a5a2e)
 *
 * wall-planter params:
 * @param {number} [params.width]          planter width, cm (default 25 = large)
 * @param {number} [params.depth]          planter projection off the wall, cm (default ~0.7*width)
 * @param {number} [params.plantHeight]    tallest leaf tip above the rim, cm (default 30)
 * @param {number} [params.leafCount]      number of spiky leaves (default 5)
 * @param {number|string} [params.potColor] ceramic colour (default white 0xf2efe8)
 * @param {number|string} [params.frameColor] wire-frame colour (default brass 0xb8945a)
 * @param {number|string} [params.leafColor] leaf colour (default deep green 0x2f4a28)
 *
 * common params:
 * @param {number} [params.seed]           deterministic layout seed (default 1)
 * @param {object} [opts]
 * @param {'full'|'low'} [opts.detail]     'low' keeps triangle count <=300
 *                                         (mobile); default 'full'
 * @returns {THREE.Group}
 */
export const TYPE = 'plant';

// width/height/depth are the DEFAULT KIND's (corn-plant) bounding envelope,
// cm, required by every furniture builder's drift test (PR #30): width/depth
// are the footprint (the larger of spread/potTopDiameter -- spread wins for
// the corn-plant defaults), height is the total height, pot included
// (potHeight + plantHeight). A wall-planter build overrides `width` (its own
// footprint width) via its params/preset same as any other field -- these
// three keys are DEFAULTS' fallback for an unspecified param, not a kind
// switch, so there is no collision: PRESETS['wall-planter-*'] supplies its
// own `width` explicitly, same as it already did before this contract.
export const DEFAULTS = Object.freeze({
  kind: 'corn-plant',
  // corn-plant
  potHeight: 56,
  potTopDiameter: 30,
  potColor: 0x9c7c4a,
  plantHeight: 110,
  stemCount: 3,
  spread: 40,
  leafColor: 0x3a5a2e,
  // wall-planter (leafCount/frameColor only apply to this kind; plantHeight
  // and leafColor are shared but re-defaulted per kind in build())
  leafCount: 5,
  frameColor: 0xb8945a,
  seed: 1,
  // required drift-test envelope (see comment above) -- corn-plant defaults:
  // width/depth = max(spread, potTopDiameter) = max(40, 30) = 40;
  // height = potHeight + plantHeight = 56 + 110 = 166
  width: 40,
  depth: 40,
  height: 166,
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

/** Apply a single flat vertex colour to every vertex of a geometry (used
 * where per-leaf colour variation is wanted without a second material --
 * vertex colours survive the renderer's by-finish mesh merge). */
function paintVertexColors(THREE, geometry, hexColor) {
  const c = new THREE.Color(hexColor);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

export function build(THREE, params, opts) {
  const p = Object.assign({}, DEFAULTS, params || {});
  const o = opts || {};
  const detail = o.detail === 'low' ? 'low' : 'full';
  const kind = p.kind || 'corn-plant';
  if (kind === 'wall-planter') return buildWallPlanter(THREE, p, detail);
  return buildCornPlant(THREE, p, detail);
}

// =====================================================================
// CORN PLANT (Dracaena fragrans) -- potted, free-standing
// =====================================================================
function buildCornPlant(THREE, p, detail) {
  const potHeight = p.potHeight * CM;
  const potTopR = (p.potTopDiameter * CM) / 2;
  const potBotR = potTopR * 0.72;                 // tapers inward toward the base
  const plantHeight = p.plantHeight * CM;
  const stemCount = Math.max(1, Math.round(p.stemCount));
  const spread = p.spread * CM;

  const rand = mulberry32((p.seed | 0) || 1);

  const potMat = new THREE.MeshStandardMaterial({ color: p.potColor, roughness: 0.85 });
  const caneMat = new THREE.MeshStandardMaterial({ color: 0x8a7a52, roughness: 0.8 });
  // vertexColors multiplies against material.color -- leave color WHITE so
  // the per-leaf vertex tint (built from p.leafColor + jitter) is the only
  // thing that reaches the screen, not p.leafColor squared into near-black.
  const leafMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.55, side: THREE.DoubleSide, vertexColors: true,
  });
  const soilMat = new THREE.MeshStandardMaterial({ color: 0x3a2c1e, roughness: 1 });

  const group = new THREE.Group();
  group.name = 'plant';
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
  potBody.position.set(0, potHeight / 2, potTopR * 0.6); // back edge lands near z=0
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
        potTopR * 0.6 + Math.sin(a) * rMid
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
  soil.position.set(0, potHeight - (potHeight * 0.015), potTopR * 0.6);
  group.add(soil);

  // ---- canes: staggered heights, each topped with a leaf rosette ----------
  // The reference photos show 3 canes emerging close together near pot-
  // centre, of visibly different heights, each capped by a strap-leaf
  // rosette -- not one central trunk. Heights are staggered deterministically
  // around `plantHeight` (the tallest cane defines plantHeight itself).
  const caneRadial = detail === 'low' ? 5 : 8;
  const caneR = Math.max(0.006, potTopR * 0.06);
  const potBaseY = potHeight;
  const potCenterZ = potTopR * 0.6;

  const leavesPerRosette = detail === 'low' ? 5 : 9;
  let maxTopY = 0;

  for (let s = 0; s < stemCount; s++) {
    // Staggered heights: the tallest cane (index 0) reaches plantHeight;
    // the others fall to shorter, deterministic fractions of it, matching
    // the photos' uneven canes. rand() advances the shared PRNG so different
    // seeds reshuffle stagger AND leaf layout together.
    const heightFrac = s === 0 ? 1 : 0.55 + rand() * 0.35;
    const caneH = plantHeight * heightFrac;

    // Deterministic offset from pot-centre so multiple canes read as
    // visibly separate stems (the photos show 3 distinct canes, not one
    // trunk) while staying inside the pot's opening. 0.55*potTopR keeps
    // every cane comfortably within the rim even at the widest offset.
    const offR = potTopR * 0.55 * (s === 0 ? 0 : (0.5 + rand() * 0.5));
    const offA = s === 0 ? 0 : (s / stemCount) * Math.PI * 2 + rand() * 0.6;
    const cx = Math.cos(offA) * offR;
    const cz = potCenterZ + Math.sin(offA) * offR;

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
    maxTopY = Math.max(maxTopY, topY);

    // ---- rosette: strap-like leaves fanning outward from the cane top,
    // arching over and down (fountain shape) -- never reaching HIGHER than
    // the cane top itself, so the plant's total height stays potHeight +
    // plantHeight (the acceptance bound) regardless of leaf count/spread.
    const rosette = new THREE.Group();
    rosette.name = 'rosette';
    rosette.position.set(cx, topY, cz);
    group.add(rosette);

    for (let i = 0; i < leavesPerRosette; i++) {
      const ang = rand() * Math.PI * 2;             // which way it fans (around the cane)
      const droopFrac = 0.4 + rand() * 0.5;         // how far the arc bends downward
      const lenFrac = 0.65 + rand() * 0.35;         // leaf length vs. spread/2
      const leafLen = (spread / 2) * lenFrac;
      const leafW = Math.max(0.012, leafLen * 0.16);
      // subtle per-leaf tint via vertex colour, not a second material
      const tint = new THREE.Color(p.leafColor);
      tint.offsetHSL(0, 0, (rand() - 0.5) * 0.12);

      const blade = buildLeafBlade(THREE, { ang, leafLen, leafW, droopFrac, bladeSegs: detail === 'low' ? 1 : 3 });
      paintVertexColors(THREE, blade, tint.getHex());

      const leaf = new THREE.Mesh(blade, leafMat);
      leaf.name = 'leaf';
      leaf.userData.finish = 'matte';
      leaf.castShadow = true;
      rosette.add(leaf);
    }
  }

  group.userData.topY = maxTopY;
  return group;
}

/** Build one strap-leaf blade directly in its parent (rosette-local) frame.
 * `t` (0=base pinned at the attach point, 1=tip) maps to an outward run plus
 * a vertical drop that is MONOTONIC and NEVER positive --
 * `dropY(t) = -leafLen * droopFrac * t^1.3`. Since dropY(0)=0 and dropY<=0
 * everywhere, no vertex can rise above the attach point -- this is what
 * pins a rosette's (or wall-planter leaf cluster's) highest point exactly at
 * its attachment height, independent of leaf count/length/spread. Shared by
 * both plant kinds. */
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
// leaves, thin gold/brass wire-frame edges. Wall-mounted: back at z=0,
// the whole item's footprint kept at z>=0 (nothing behind the wall).
// =====================================================================
function buildWallPlanter(THREE, p, detail) {
  const width = (p.width != null ? p.width : 25) * CM;
  const depth = (p.depth != null ? p.depth : width * 0.7);
  const plantHeight = (p.plantHeight === DEFAULTS.plantHeight ? 30 : p.plantHeight) * CM;
  const leafCount = Math.max(1, Math.round(p.leafCount != null ? p.leafCount : 5));
  const potColor = p.potColor != null && p.potColor !== DEFAULTS.potColor ? p.potColor : 0xf2efe8;
  const frameColor = p.frameColor != null ? p.frameColor : 0xb8945a;
  const leafColor = p.leafColor != null && p.leafColor !== DEFAULTS.leafColor ? p.leafColor : 0x2f4a28;

  const rand = mulberry32((p.seed | 0) || 1);

  const ceramicMat = new THREE.MeshStandardMaterial({ color: potColor, roughness: 0.35 });
  const frameMat = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.3, metalness: 0.85 });
  // Same reasoning as buildCornPlant's leafMat: vertexColors multiplies
  // against material.color, so this stays white and the vertex tint alone
  // carries leafColor -- otherwise the colour would be squared into near-black.
  const leafMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.5, side: THREE.DoubleSide, vertexColors: true,
  });

  const group = new THREE.Group();
  group.name = 'plant';
  group.userData.type = TYPE;
  group.userData.kind = 'wall-planter';

  // ---- faceted ceramic body: an inverted (point-down) low-poly cone --
  // few radial segments gives flat triangular facets rather than a smooth
  // cone, matching "an inverted faceted prism / diamond" in the brief. Kept
  // perfectly UPRIGHT (axis along y, no tilt) so its footprint never crosses
  // behind the wall plane -- the cone's own radius (openR) is the only thing
  // that can extend in z, and the whole body is positioned at z=openR so its
  // BACK-most point (the -z side of the rim) sits exactly at z=0.
  const facets = 6;
  const openR = width / 2;
  const bodyH = depth;
  const bodyCenterZ = openR; // shifts the whole body forward so its back face touches z=0

  const body = new THREE.Mesh(
    new THREE.ConeGeometry(openR, bodyH, facets, 1, true),
    ceramicMat
  );
  body.name = 'planterBody';
  body.userData.finish = 'gloss';
  body.position.set(0, bodyH / 2, bodyCenterZ); // apex (point) at y=0, opening rim at y=bodyH
  body.castShadow = true; body.receiveShadow = true;
  group.add(body);

  // opening cap (disc) so the planter reads as a vessel, not a hollow shell
  const cap = new THREE.Mesh(new THREE.CircleGeometry(openR * 0.98, facets), ceramicMat);
  cap.name = 'planterCap';
  cap.userData.finish = 'gloss';
  cap.rotation.x = -Math.PI / 2; // face up
  cap.position.set(0, bodyH, bodyCenterZ);
  group.add(cap);

  // ---- thin gold/brass wire frame outlining the facet edges -- a ring at
  // the opening plus one strut per facet running down to the point. Cheap
  // (thin cylinders/torus), reads as "wire frame outline".
  const wireR = Math.max(0.0025, openR * 0.02);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(openR, wireR, 5, facets * 2), frameMat);
  rim.name = 'frameRim';
  rim.userData.finish = 'metal';
  rim.rotation.x = Math.PI / 2;
  rim.position.copy(cap.position);
  group.add(rim);

  const tipPos = new THREE.Vector3(0, 0, bodyCenterZ);
  for (let i = 0; i < facets; i++) {
    const a = (i / facets) * Math.PI * 2;
    const rimPt = new THREE.Vector3(Math.cos(a) * openR, bodyH, bodyCenterZ + Math.sin(a) * openR);
    const mid = rimPt.clone().add(tipPos).multiplyScalar(0.5);
    const strutLen = rimPt.distanceTo(tipPos);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(wireR, wireR, strutLen, 5), frameMat);
    strut.name = 'frameStrut';
    strut.userData.finish = 'metal';
    strut.position.copy(mid);
    strut.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      rimPt.clone().sub(tipPos).normalize()
    );
    group.add(strut);
  }

  // ---- wall mounting bracket: a small flat plate flush with the wall ----
  const bracketDepth = Math.max(0.005, depth * 0.03);
  const bracket = new THREE.Mesh(
    new THREE.BoxGeometry(openR * 0.5, openR * 0.5, bracketDepth),
    frameMat
  );
  bracket.name = 'wallBracket';
  bracket.userData.finish = 'metal';
  bracket.position.set(0, bodyH * 0.9, bracketDepth / 2); // sits ON the wall face, growing into +z only
  group.add(bracket);

  // ---- spiky sansevieria-style leaves rising from the opening ----------
  // Tall, narrow, near-upright, tapering to a point -- unlike the corn
  // plant's arching straps. Built directly (not via buildLeafBlade, whose
  // "outward run" convention is horizontal): here the length axis IS the
  // rise (+y), with only a small outward lean in XZ, and it tapers to a
  // point at the tip (sansevieria's spike shape).
  const leafSegs = detail === 'low' ? 1 : 2;
  const originY = cap.position.y;
  const originZ = cap.position.z;
  for (let i = 0; i < leafCount; i++) {
    const ang = (i / leafCount) * Math.PI * 2 + rand() * 0.4;
    const lenFrac = 0.75 + rand() * 0.35;
    const leafLen = plantHeight * lenFrac;
    const leafW = Math.max(0.008, openR * 0.22);
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

    const tint = new THREE.Color(leafColor);
    tint.offsetHSL(0, 0, (rand() - 0.5) * 0.15);
    paintVertexColors(THREE, blade, tint.getHex());

    const leaf = new THREE.Mesh(blade, leafMat);
    leaf.name = 'leaf';
    leaf.userData.finish = 'matte';
    leaf.position.set(0, originY, originZ);
    leaf.castShadow = true;
    group.add(leaf);
  }

  group.userData.topY = originY + plantHeight;
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
 * follow-up for the hanging planters). */
export const PRESETS = Object.freeze({
  'corn-plant-tall': Object.freeze({
    kind: 'corn-plant',
    potHeight: 56,
    potTopDiameter: 30,
    potColor: 0x9c7c4a,
    plantHeight: 110,
    stemCount: 3,
    spread: 40,
    leafColor: 0x33502a,
    seed: 7,
  }),
  'wall-planter-large': Object.freeze({
    kind: 'wall-planter',
    width: 25,
    plantHeight: 32,
    leafCount: 6,
    potColor: 0xf2efe8,
    frameColor: 0xb8945a,
    leafColor: 0x2f4a28,
    seed: 3,
  }),
  'wall-planter-small': Object.freeze({
    kind: 'wall-planter',
    width: 12,
    plantHeight: 16,
    leafCount: 4,
    potColor: 0xf2efe8,
    frameColor: 0xb8945a,
    leafColor: 0x35502e,
    seed: 4,
  }),
});
