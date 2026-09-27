#!/usr/bin/env node
/**
 * wall-panels.js: geometry decisions a contract-gate screenshot cannot pin.
 * No framework, no install: `node scripts/test-wall-panels.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract (bbox, finish tags, no-three, low<=full triangles) for every
 * registered type including these two. This file checks the type-specific
 * decisions that contract does not know to ask about:
 *
 *   1. slat-panel: slats fit the whole width (first and last slat flush with
 *      the panel's edges), and the requested colours/finish actually land on
 *      the slat vs. the backing mesh (not swapped); the opt-in grainMap
 *      stamps a roughness map on the slat material and flags the mesh keep.
 *   2. hex-panel-cluster: the living-room preset (side 18, columns
 *      3,4,5,4,4,4,3,2 left to right) produces exactly 29 hex meshes; a hex
 *      is flat-top (a flat edge left/right, not a vertex); columns are
 *      centred by default except column 5 shifted down half a hex
 *      (columnOffsets [0,0,0,0,1,0,0,0]); the cluster is 29 meshes sharing
 *      one geometry + one material (cheap, per the plan); the DEFAULTS bbox
 *      this module freezes at load time is internally consistent with the live layout
 *      maths, not a hand-typed guess that could drift from the code that
 *      draws it; and the honeycomb has no overlaps and no gaps between
 *      neighbouring columns.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const WP = await imp('src/furniture/wall-panels.js');
const Fin = await imp('src/furniture/finishes.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- TYPES export shape -----------------------------------------------------
{
  check('TYPES has slat-panel and hex-panel-cluster', !!WP.TYPES['slat-panel'] && !!WP.TYPES['hex-panel-cluster']);
  check('slat-panel: DEFAULTS frozen with width/depth/height numeric',
    Object.isFrozen(WP.TYPES['slat-panel'].DEFAULTS) &&
    ['width', 'depth', 'height'].every(k => typeof WP.TYPES['slat-panel'].DEFAULTS[k] === 'number'));
  check('hex-panel-cluster: DEFAULTS frozen with width/depth/height numeric',
    Object.isFrozen(WP.TYPES['hex-panel-cluster'].DEFAULTS) &&
    ['width', 'depth', 'height'].every(k => typeof WP.TYPES['hex-panel-cluster'].DEFAULTS[k] === 'number'));
}

// ---- slat-panel: fit, colours, presets --------------------------------------
{
  const build = WP.TYPES['slat-panel'].build;
  const D = WP.TYPES['slat-panel'].DEFAULTS;

  function meshesByFinishColor(group, hex) {
    const out = [];
    group.traverse(o => {
      if (!o.isMesh) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (mat && mat.color && mat.color.getHex() === hex) out.push(o);
    });
    return out;
  }

  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  const slatColorInt = parseInt(D.slatColor.slice(1), 16);
  const backingColorInt = parseInt(D.backingColor.slice(1), 16);
  const slats = meshesByFinishColor(g, slatColorInt);
  const backing = meshesByFinishColor(g, backingColorInt);
  check('slat-panel: at least one slat mesh in the slat colour', slats.length > 0, slats.length);
  check('slat-panel: exactly one backing mesh in the backing colour', backing.length === 1, backing.length);
  check('slat-panel: colours are not swapped (slat != backing colour)', slatColorInt !== backingColorInt);

  // First and last slat flush with the panel edges (within half a slat width
  // of exactly 0 and width, i.e. no wasted margin on either side).
  g.updateMatrixWorld(true);
  const xs = slats.map(m => {
    const b = new THREE.Box3().setFromObject(m);
    return { min: b.min.x, max: b.max.x };
  }).sort((a, b) => a.min - b.min);
  const widthM = D.width / 100, slatWidthM = D.slatWidth / 100;
  check('slat-panel: first slat flush with the left edge', near(xs[0].min, -widthM / 2, 0.002), xs[0]);
  check('slat-panel: last slat flush with the right edge', near(xs[xs.length - 1].max, widthM / 2, 0.002), xs[xs.length - 1]);
  check('slat-panel: slat count matches the nominal pitch fit',
    xs.length === Math.max(1, Math.round(widthM / ((D.slatWidth + (D.pitch - D.slatWidth)) / 100))), xs.length);

  // Depth: backing back at z=0, slats protrude beyond the backing's outer face.
  const backB = new THREE.Box3().setFromObject(backing[0]);
  const slatB = new THREE.Box3().setFromObject(slats[0]);
  check('slat-panel: backing back at z=0', near(backB.min.z, 0, 0.002), backB);
  check('slat-panel: backing depth matches params', near(backB.max.z - backB.min.z, D.backingDepth / 100, 0.002), backB);
  check('slat-panel: slats start where the backing ends', near(slatB.min.z, backB.max.z, 0.002), { slatB, backB });
  check('slat-panel: overall depth == backingDepth + slatDepth (== DEFAULTS.depth)',
    near(slatB.max.z, D.depth / 100, 0.002), { slatMaxZ: slatB.max.z, depth: D.depth });

  // A second size: still fits and colours still resolve (not a fluke of the
  // exact default numbers).
  const g2 = build(THREE, Object.assign({}, D, { width: 137, slatWidth: 4, pitch: 6 }), { detail: 'full' });
  const slats2 = [];
  g2.traverse(o => { if (o.isMesh && o.geometry !== null && o !== g2) slats2.push(o); });
  check('slat-panel: a non-default width still builds meshes', slats2.length > 1, slats2.length);

  // Every finish + keep tag is well-formed (belt-and-braces on top of the
  // shared contract test, using the explicit "glass" case to exercise keep).
  const gGlass = build(THREE, Object.assign({}, D, { finish: 'glass' }), { detail: 'full' });
  let sawKeptGlass = false;
  gGlass.traverse(o => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.userData && mat.userData.finish === 'glass') {
      sawKeptGlass = sawKeptGlass || o.userData.keep === true;
    }
  });
  check('slat-panel: a glass-finish slat is flagged keep', sawKeptGlass);

  // grainMap (oak preset, criterion 9): off by default, opt-in flags every
  // slat mesh keep even under plain Node where makeOakGrainRoughnessMap
  // returns null (no DOM canvas) -- the keep flag and params are still
  // real effects worth checking independent of whether a texture landed.
  check('slat-panel: DEFAULTS.grainMap is false', D.grainMap === false);
  const gPlain = build(THREE, Object.assign({}, D), { detail: 'full' });
  let anyKeptPlain = false;
  gPlain.traverse(o => { if (o.isMesh && o.userData.keep === true) anyKeptPlain = true; });
  check('slat-panel: default (no grainMap) has no kept meshes', !anyKeptPlain);
  const gGrain = build(THREE, Object.assign({}, D, { grainMap: true }), { detail: 'full' });
  let slatCount = 0, keptCount = 0;
  gGrain.traverse(o => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.color && mat.color.getHex() === slatColorInt) {
      slatCount++;
      if (o.userData.keep === true) keptCount++;
    }
  });
  check('slat-panel: grainMap:true flags every slat mesh keep', slatCount > 0 && keptCount === slatCount, { slatCount, keptCount });
  check('slat-panel: real Acupanel geometry defaults (2.7/4.0/1.0/0.9cm)',
    D.slatWidth === 2.7 && D.pitch === 4.0 && D.slatDepth === 1.0 && D.backingDepth === 0.9 && near(D.depth, 1.9),
    { slatWidth: D.slatWidth, pitch: D.pitch, slatDepth: D.slatDepth, backingDepth: D.backingDepth, depth: D.depth });

  // finish: satin on the slats (roughness parity with the bedroom's
  // hard-coded panel, roughness 0.55 -- satin's 0.6 is the closest palette
  // match, added by fix/chair-leather-satin, merged v0.20.0/PR #42), matte
  // on the backing ALWAYS -- the backing colour is hard-coded to 'matte' in
  // buildSlatPanel and is never driven by the `finish` param, so this is a
  // real behavioural check (actual material.roughness), not just an echo
  // of the params object back at itself.
  check('slat-panel: DEFAULTS.finish is satin', D.finish === 'satin', D.finish);
  const gFinish = build(THREE, Object.assign({}, D), { detail: 'full' });
  const slatMatsFinish = meshesByFinishColor(gFinish, slatColorInt).map(m => Array.isArray(m.material) ? m.material[0] : m.material);
  const backingMatsFinish = meshesByFinishColor(gFinish, backingColorInt).map(m => Array.isArray(m.material) ? m.material[0] : m.material);
  check('slat-panel: slat material roughness is satin (0.6)',
    slatMatsFinish.length > 0 && slatMatsFinish.every(m => near(m.roughness, Fin.FINISH_PARAMS.satin.roughness)),
    slatMatsFinish.map(m => m.roughness));
  check('slat-panel: backing material roughness stays matte (0.8) regardless of the finish param',
    backingMatsFinish.length > 0 && backingMatsFinish.every(m => near(m.roughness, Fin.FINISH_PARAMS.matte.roughness)),
    backingMatsFinish.map(m => m.roughness));
  // Even when a caller overrides `finish` to something else entirely, the
  // backing is unaffected -- proves the hard-coding, not just today's default.
  const gFinishOverride = build(THREE, Object.assign({}, D, { finish: 'gloss' }), { detail: 'full' });
  const backingMatsOverride = meshesByFinishColor(gFinishOverride, backingColorInt).map(m => Array.isArray(m.material) ? m.material[0] : m.material);
  check('slat-panel: backing stays matte even when finish is overridden to gloss',
    backingMatsOverride.length > 0 && backingMatsOverride.every(m => near(m.roughness, Fin.FINISH_PARAMS.matte.roughness)),
    backingMatsOverride.map(m => m.roughness));
}

// ---- hex-panel-cluster: the living-room preset ------------------------------
{
  const build = WP.TYPES['hex-panel-cluster'].build;
  const D = WP.TYPES['hex-panel-cluster'].DEFAULTS;

  check('hex-panel-cluster: DEFAULTS.columns is the living-room preset',
    JSON.stringify(D.columns) === JSON.stringify([3, 4, 5, 4, 4, 4, 3, 2]), D.columns);
  check('hex-panel-cluster: DEFAULTS.columnOffsets shifts only column 5 (index 4) down half a hex',
    JSON.stringify(D.columnOffsets) === JSON.stringify([0, 0, 0, 0, 1, 0, 0, 0]), D.columnOffsets);
  check('hex-panel-cluster: DEFAULTS.side is 18cm', D.side === 18);
  check('hex-panel-cluster: DEFAULTS.color is the dark green felt', D.color === '#5a828c', D.color);

  const g = build(THREE, Object.assign({}, D), { detail: 'full' });
  const hexMeshes = [];
  g.traverse(o => { if (o.isMesh) hexMeshes.push(o); });
  check('hex-panel-cluster: exactly 29 hex meshes at the living-room preset', hexMeshes.length === 29, hexMeshes.length);

  // 29 meshes sharing one geometry: every hex mesh shares the SAME
  // BufferGeometry instance (cheap in memory -- the plan's "one merged
  // geometry" requirement, read as "one shared geometry resource" rather
  // than a single merged BufferGeometry / one draw call, since three.js has
  // no single "merged multi-instance" primitive short of InstancedMesh).
  const geoSet = new Set(hexMeshes.map(m => m.geometry));
  check('hex-panel-cluster: all hexes share one geometry instance', geoSet.size === 1, geoSet.size);
  const matSet = new Set(hexMeshes.map(m => Array.isArray(m.material) ? m.material[0] : m.material));
  check('hex-panel-cluster: all hexes share one material instance', matSet.size === 1, matSet.size);

  // Flat-top: the shared hex geometry's own local bbox is WIDER (x) than it
  // is tall (y) -- width = 2*side, height = sqrt(3)*side -> width/height =
  // 2/sqrt(3) ~= 1.1547, the inverse of the pointy-top ratio.
  const hexGeo = hexMeshes[0].geometry;
  hexGeo.computeBoundingBox();
  const bb = hexGeo.boundingBox;
  const wLocal = bb.max.x - bb.min.x, hLocal = bb.max.y - bb.min.y;
  check('hex-panel-cluster: flat-top (local width > local height)', wLocal > hLocal, { wLocal, hLocal });
  check('hex-panel-cluster: flat-top ratio width/height ~= 2/sqrt(3)',
    near(wLocal / hLocal, 2 / Math.sqrt(3), 0.01), wLocal / hLocal);

  // ---- chamfered bevel (review round 3) ------------------------------------
  // The 'full' geometry's own local bbox must match the flat (no-bevel)
  // hex's bbox exactly -- the footprint and layout pitch (both keyed to
  // `side` alone) must be UNAFFECTED by bevelWidth/bevelDepth. Read
  // straight off geometry.attributes.position rather than trusting
  // computeBoundingBox() to catch a mistake in the geometry itself.
  {
    check('hex-panel-cluster: DEFAULTS.bevelWidth is 0.9cm', D.bevelWidth === 0.9, D.bevelWidth);
    check('hex-panel-cluster: DEFAULTS.bevelDepth is 0.5cm (half the 1cm thickness)', D.bevelDepth === 0.5, D.bevelDepth);

    const sideM = D.side / 100, thicknessM = D.thickness / 100;
    const pos = hexGeo.attributes.position;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minX = Math.min(minX, pos.getX(i)); maxX = Math.max(maxX, pos.getX(i));
      minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i));
      minZ = Math.min(minZ, pos.getZ(i)); maxZ = Math.max(maxZ, pos.getZ(i));
    }
    // Flat-top hex's own outer half-extents: x = side, y = side*sqrt(3)/2.
    check('hex-panel-cluster: beveled hex footprint (x) matches the plain flat hex exactly',
      near(maxX - minX, 2 * sideM, 1e-6) && near(minX, -sideM, 1e-6) && near(maxX, sideM, 1e-6),
      { minX, maxX, expectedHalf: sideM });
    check('hex-panel-cluster: beveled hex footprint (y) matches the plain flat hex exactly',
      near(maxY - minY, Math.sqrt(3) * sideM, 1e-6), { minY, maxY, expected: Math.sqrt(3) * sideM });
    check('hex-panel-cluster: beveled hex overall depth (z) still equals thickness',
      near(minZ, 0, 1e-6) && near(maxZ, thicknessM, 1e-6), { minZ, maxZ, thicknessM });

    // The front face (z == thickness) must be inset from the outer edge by
    // bevelWidth: its own vertices' extent in x should be
    // 2*(side - bevelWidth/(sqrt(3)/2)) -- narrower than the full footprint.
    const bevelWidthM = D.bevelWidth / 100, bevelDepthM = D.bevelDepth / 100;
    const innerSideM = sideM - bevelWidthM / (Math.sqrt(3) / 2);
    let frontMinX = Infinity, frontMaxX = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (near(pos.getZ(i), thicknessM, 1e-6)) {
        frontMinX = Math.min(frontMinX, pos.getX(i));
        frontMaxX = Math.max(frontMaxX, pos.getX(i));
      }
    }
    check('hex-panel-cluster: front plateau face is inset by bevelWidth (narrower than the outer footprint)',
      (frontMaxX - frontMinX) < (maxX - minX) - 1e-6, { frontWidth: frontMaxX - frontMinX, outerWidth: maxX - minX });
    check('hex-panel-cluster: front plateau face width matches the computed inner hex exactly',
      near(frontMaxX - frontMinX, 2 * innerSideM, 1e-6), { frontMinX, frontMaxX, innerSideM });

    // The rim (front plateau edge) is thinner than the centre: the straight
    // side wall (full outer radius) only runs from z=0 to
    // z=(thickness-bevelDepth), i.e. no vertex at the OUTER radius exists
    // past that z -- so the material thickness at the very outer edge is
    // (thickness - bevelDepth), strictly less than the full `thickness`.
    let maxZAtOuterRadius = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (near(Math.abs(pos.getX(i)), sideM, 1e-6) || near(Math.abs(pos.getY(i)), Math.sqrt(3) / 2 * sideM, 1e-6)) {
        maxZAtOuterRadius = Math.max(maxZAtOuterRadius, pos.getZ(i));
      }
    }
    check('hex-panel-cluster: the rim (at the outer edge) is thinner than the centre thickness',
      near(maxZAtOuterRadius, thicknessM - bevelDepthM, 1e-6) && maxZAtOuterRadius < thicknessM - 1e-6,
      { maxZAtOuterRadius, thicknessM, bevelDepthM });

    // Vertex/triangle count stays modest for a 29-hex cluster. The geometry
    // is non-indexed (flat-shading fix, round 4 review: chamfer facets must
    // not share vertices/normals with their neighbours), so vertex count is
    // 3x triangle count by construction -- the triangle count is the number
    // that actually matters for "modest", and stays exactly what it was
    // with the old shared-vertex version (36: 6 back + 12 side + 12 bevel +
    // 6 front), well under the old flat ExtrudeGeometry's 58.
    check('hex-panel-cluster: beveled hex geometry has a modest triangle count (<= 40)',
      pos.count / 3 <= 40, pos.count / 3);
    check('hex-panel-cluster: beveled hex geometry is non-indexed (flat-shaded, no shared vertices)',
      hexGeo.index === null, hexGeo.index);

    // Winding: every triangle's face normal (from its own 3 vertex
    // positions via cross product, independent of whatever
    // computeVertexNormals() stored) must point OUTWARD/FORWARD, never
    // into the panel. Two families, checked differently since "outward"
    // means something different for each:
    //   - fan triangles (back face, all-z-equal at 0; front plateau, all-z-
    //     equal at thickness): normal.z must be negative (back) or positive
    //     (front).
    //   - ring triangles (side wall + bevel, z varies across the 3 verts):
    //     the normal's xy component must point away from the hex's own
    //     centre axis (dot product with the facet's own centroid-xy > 0).
    // This is a REAL round-4 regression check: the geometry shipped in this
    // review round had every one of its 24 ring triangles wound inward
    // (caught and fixed only by writing this exact probe) while its 12 fan
    // triangles were already correct -- so a test that only checked ONE
    // family would have missed exactly the bug that shipped. Mutation-tested
    // by hand: reverting the ring-facet winding fix trips the ring check
    // (24 bad); separately flipping the back-fan's winding trips the fan
    // check (6 bad) -- both confirmed failing, then restored.
    {
      const geoPos = hexGeo.attributes.position;
      const triCount = geoPos.count / 3;
      const vAt = i => new THREE.Vector3(geoPos.getX(i), geoPos.getY(i), geoPos.getZ(i));
      let fanBad = 0, ringBad = 0;
      for (let t = 0; t < triCount; t++) {
        const i0 = t * 3, i1 = t * 3 + 1, i2 = t * 3 + 2;
        const p0 = vAt(i0), p1 = vAt(i1), p2 = vAt(i2);
        const faceNormal = p1.clone().sub(p0).cross(p2.clone().sub(p0)).normalize();
        const zs = [p0.z, p1.z, p2.z];
        const isFan = near(zs[0], zs[1], 1e-6) && near(zs[1], zs[2], 1e-6);
        if (isFan) {
          const expectSign = near(zs[0], 0, 1e-6) ? -1 : 1;
          if (Math.sign(faceNormal.z) !== expectSign) fanBad++;
        } else {
          const cx = (p0.x + p1.x + p2.x) / 3, cy = (p0.y + p1.y + p2.y) / 3;
          const radialDotNormal = cx * faceNormal.x + cy * faceNormal.y;
          if (radialDotNormal <= 0) ringBad++;
        }
      }
      check('hex-panel-cluster: fan triangles (back/front faces) wind outward', fanBad === 0, fanBad);
      check('hex-panel-cluster: ring triangles (side wall + bevel chamfer) wind outward', ringBad === 0, ringBad);
    }

    // 'low' detail drops the bevel entirely: its geometry is the plain flat
    // extrusion (60 vertices at curveSegments:1, no separate front-plateau
    // ring), and its front face is flush with the outer footprint, NOT
    // inset -- i.e. genuinely bevel-free, not just a relabelled full mesh.
    const gLow = build(THREE, Object.assign({}, D), { detail: 'low' });
    const lowMeshes = [];
    gLow.traverse(o => { if (o.isMesh) lowMeshes.push(o); });
    const lowGeo = lowMeshes[0].geometry;
    const lowPos = lowGeo.attributes.position;
    let lowFrontMinX = Infinity, lowFrontMaxX = -Infinity;
    for (let i = 0; i < lowPos.count; i++) {
      if (near(lowPos.getZ(i), thicknessM, 1e-4)) {
        lowFrontMinX = Math.min(lowFrontMinX, lowPos.getX(i));
        lowFrontMaxX = Math.max(lowFrontMaxX, lowPos.getX(i));
      }
    }
    check('hex-panel-cluster: low-detail front face is flush with the outer footprint (bevel dropped)',
      near(lowFrontMaxX - lowFrontMinX, 2 * sideM, 1e-4), { lowFrontMinX, lowFrontMaxX, expected: 2 * sideM });
    check('hex-panel-cluster: low-detail geometry is a different (bevel-free) instance from full',
      lowGeo !== hexGeo);
  }

  // Overall bbox: back at z=0 (contract test already checks this for the
  // full group at DEFAULTS; re-derive it independently here from the raw
  // layout maths so a change to the layout function is caught even if the
  // frozen DEFAULTS bbox were hand-edited to match a bug).
  g.updateMatrixWorld(true);
  const gb = new THREE.Box3().setFromObject(g);
  const gWidthCm = (gb.max.x - gb.min.x) * 100, gHeightCm = (gb.max.y - gb.min.y) * 100;
  check('hex-panel-cluster: live bbox width matches frozen DEFAULTS.width', near(gWidthCm, D.width, 0.05), { gWidthCm, D: D.width });
  check('hex-panel-cluster: live bbox height matches frozen DEFAULTS.height', near(gHeightCm, D.height, 0.05), { gHeightCm, D: D.height });
  check('hex-panel-cluster: back at z=0', near(gb.min.z, 0, 0.002), gb);
  check('hex-panel-cluster: depth == thickness', near((gb.max.z - gb.min.z) * 100, D.thickness, 0.05), gb);

  // A different cluster shape still lays out correctly: column counts summed.
  const g2 = build(THREE, Object.assign({}, D, { columns: [1, 2, 1], side: 10 }), { detail: 'full' });
  let n2 = 0;
  g2.traverse(o => { if (o.isMesh) n2++; });
  check('hex-panel-cluster: a custom columns array produces the summed hex count', n2 === 4, n2);

  // Explicit columnOffsets shift a column without changing the hex count.
  const g3 = build(THREE, Object.assign({}, D, { columns: [2, 2], columnOffsets: [0, 1], side: 10 }), { detail: 'full' });
  let n3 = 0;
  g3.traverse(o => { if (o.isMesh) n3++; });
  check('hex-panel-cluster: columnOffsets do not change the hex count', n3 === 4, n3);
  g3.updateMatrixWorld(true);
  g2.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(g2), b3 = new THREE.Box3().setFromObject(g3);
  check('hex-panel-cluster: a shifted column heightens the bbox vs. the unshifted layout',
    (b3.max.y - b3.min.y) > (b2.max.y - b2.min.y) - 1e-6, { shifted: b3, plain: b2 });

  // Palette/keep sanity, same style as the slat-panel section above.
  const gGlass = build(THREE, Object.assign({}, D, { finish: 'mirror' }), { detail: 'full' });
  let mirrorKept = false;
  gGlass.traverse(o => {
    if (!o.isMesh) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    if (mat && mat.userData && mat.userData.finish === 'mirror') mirrorKept = mirrorKept || o.userData.keep === true;
  });
  check('hex-panel-cluster: a mirror-finish cluster is flagged keep', mirrorKept);

  // ---- no overlaps, no gaps: adjacent columns must interlock -------------
  // NOT a re-derivation of layoutHexes's own formula (that was hollow: a
  // sign flip on the offset term, or dropping columnOffsets entirely, still
  // passed every check because the test and the code shared the same bug --
  // review-flagged 2026-09-26 round 2). Instead this reads the BUILT
  // group's actual mesh.position values -- the thing a wrong sign or a
  // dropped offset would visibly change -- and buckets them into columns by
  // their own x coordinate (layoutHexes places every hex in column c at the
  // same x = c*colPitch, so grouping by x is a property of the honeycomb
  // shape itself, not a copy of the layout code). Mutation-tested by hand:
  // both `y0 -= off*halfHex` -> `y0 +=` and hard-coding `off = 0` in
  // wall-panels.js's layoutHexes make this block fail (5 of its checks trip
  // on the ignore-offsets mutation; the "lowest column"/"half a hex below"
  // checks specifically trip on both).
  {
    g.updateMatrixWorld(true);
    const sideCm = D.side;
    const rowPitch = Math.sqrt(3) * sideCm, colPitch = 1.5 * sideCm, halfHex = rowPitch / 2;
    // neighbourDist: centre-to-centre distance between two hexes that share
    // an edge (one column apart, offset by half a row-pitch) -- derived from
    // the honeycomb geometry itself (colPitch horizontally, halfHex
    // vertically), not hand-typed, so a side-length change cannot desync it.
    const neighbourDist = Math.sqrt(colPitch * colPitch + halfHex * halfHex);

    // Read every hex mesh's world-space (x, y) centre from the built group.
    const worldCentres = hexMeshes.map(m => {
      const v = new THREE.Vector3();
      m.getWorldPosition(v);
      return [v.x * 100, v.y * 100]; // m -> cm, matching D.side's units
    });

    // Bucket by x (column): sort distinct x values, group hexes whose x is
    // within a small tolerance of each bucket's representative x.
    const xs = [...new Set(worldCentres.map(([x]) => Math.round(x * 100) / 100))].sort((a, b) => a - b);
    const columnsByX = xs.map(x => worldCentres.filter(([cx]) => near(cx, x, 0.01)).map(([, y]) => y).sort((a, b) => a - b));
    check('hex-panel-cluster: built mesh positions form 8 distinct columns (by x)', columnsByX.length === 8, xs.length);
    check('hex-panel-cluster: column x-spacing matches colPitch (1.5*side)',
      xs.every((x, i) => i === 0 || near(x - xs[i - 1], colPitch, 0.01)), xs);

    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

    // 1. No overlap: every pair of distinct built meshes is at least
    // neighbourDist apart (same-column neighbours are rowPitch apart, which
    // is larger).
    let minPairDist = Infinity;
    for (let i = 0; i < worldCentres.length; i++) {
      for (let j = i + 1; j < worldCentres.length; j++) {
        minPairDist = Math.min(minPairDist, dist(worldCentres[i], worldCentres[j]));
      }
    }
    check('hex-panel-cluster: no two built hexes overlap (min centre distance >= neighbour distance)',
      minPairDist >= neighbourDist - 1e-2, { minPairDist, neighbourDist });

    // 2. No gaps: every hex in columns 1-7 (index 0-6) has at least one
    // neighbour in the next column at exactly neighbourDist, read from the
    // built positions.
    const centresByColXY = xs.map((x, c) => worldCentres.filter(([cx]) => near(cx, x, 0.01)));
    let gapFound = null;
    for (let c = 0; c < centresByColXY.length - 1; c++) {
      for (const centre of centresByColXY[c]) {
        const hasNeighbour = centresByColXY[c + 1].some(other => near(dist(centre, other), neighbourDist, 1e-2));
        if (!hasNeighbour) { gapFound = { column: c, centre }; break; }
      }
      if (gapFound) break;
    }
    check('hex-panel-cluster: every built hex in columns 1-7 shares an edge with the next column (no gaps)',
      gapFound === null, gapFound);

    // 3. The specific claim the review asked for directly: column 5 (index
    // 4, the one with a non-zero columnOffset) has its LOWEST hex sitting
    // half a hex (halfHex = rowPitch/2) BELOW column 4's lowest (and
    // column 6's lowest) -- not level with them, and not shifted up. This
    // is the one assertion a sign-flipped or ignored offset cannot survive:
    // flipping the sign moves column 5's lowest hex ABOVE its neighbours
    // instead of below, and dropping the offset entirely leaves it level
    // (delta 0), both of which fail the `near(..., halfHex)` check below.
    const col4Lowest = Math.min(...columnsByX[3]);
    const col5Lowest = Math.min(...columnsByX[4]);
    const col6Lowest = Math.min(...columnsByX[5]);
    // Lower in scene-Y means a SMALLER y value (layoutHexes's y decreases
    // downward before the builder's own re-centring re-expresses it in the
    // group's own y-up-from-floor frame; either way "lower" is min y here
    // since the whole group is built bottom-up from y=0).
    check('hex-panel-cluster: column 5 (index 4) is the lowest-reaching column',
      col5Lowest < col4Lowest && col5Lowest < col6Lowest, { col4Lowest, col5Lowest, col6Lowest });
    check('hex-panel-cluster: column 5\'s lowest hex sits half a hex below column 4\'s lowest',
      near(col4Lowest - col5Lowest, halfHex, 0.01), { delta: col4Lowest - col5Lowest, halfHex });
    check('hex-panel-cluster: column 5\'s lowest hex sits half a hex below column 6\'s lowest',
      near(col6Lowest - col5Lowest, halfHex, 0.01), { delta: col6Lowest - col5Lowest, halfHex });
  }
}

// ---- registry wiring (this module's own entries, not the whole registry) ---
{
  const { REGISTRY } = await imp('src/furniture/registry.js');
  check('registry: slat-panel points at wall-panels.js with key slat-panel',
    REGISTRY['slat-panel'].path === 'wall-panels.js' && REGISTRY['slat-panel'].key === 'slat-panel', REGISTRY['slat-panel']);
  check('registry: hex-panel-cluster points at wall-panels.js with key hex-panel-cluster',
    REGISTRY['hex-panel-cluster'].path === 'wall-panels.js' && REGISTRY['hex-panel-cluster'].key === 'hex-panel-cluster', REGISTRY['hex-panel-cluster']);
  check('registry: both point at the WallPanelSpec page',
    REGISTRY['slat-panel'].spec === 'WallPanelSpec' && REGISTRY['hex-panel-cluster'].spec === 'WallPanelSpec');
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
