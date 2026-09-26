/**
 * wall-panels.js - multi-type module: `slat-panel` and `hex-panel-cluster`.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0 and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 * See docs/house-profile.md, "Furniture".
 *
 * Both types here are wall decoration: thin, flat, low triangle-count panels
 * meant to be wall-anchored (though nothing stops a free placement). Look
 * ported from the read-only reference in src/home3d-scene.js
 * (buildAcousticPanelWall25 / buildAcousticPanelLivingRoomWall1Wall3) --
 * this module does not import or call that code, it only matches the same
 * visual recipe: vertical wood/black slats over a dark felt backing, spaced
 * by a fixed pitch, protruding a fixed depth off the backing.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

// ---------------------------------------------------------------------------
// slat-panel
// ---------------------------------------------------------------------------

// Real Acupanel Contemporary Oak product spec (mm: 27 wide x 10 deep, 13 gap
// [40 pitch], 9 felt backing -- src/home3d-scene.js's buildAcousticPanelWall25,
// the bedroom's hard-coded live panel), matched here 2026-09-26 (spec review,
// WallPanelSpec.md criterion 9) so this generic module and its spec page read
// the same as the actual house. slatWidth/pitch/slatDepth/backingDepth below
// are the cm equivalents (2.7/4.0/1.0/0.9); depth is their sum.
const SLAT_DEFAULTS = Object.freeze({
  width: 240,
  height: 250,
  // depth = backingDepth + slatDepth (the felt backing plus how far the
  // slats protrude off it) -- the builder contract requires DEFAULTS to
  // carry width/depth/height, so this is the panel's full physical depth,
  // not an independent input.
  depth: 1.9,
  slatWidth: 2.7,
  pitch: 4.0,
  slatDepth: 1.0,
  backingDepth: 0.9,
  slatColor: '#322e29',
  backingColor: '#0e0b09',
  // ROUGHNESS PARITY: the bedroom's hard-coded panel (buildAcousticPanelWall25)
  // uses roughness 0.55; the palette's `satin` finish (0.6, added by
  // fix/chair-leather-satin, PR #42, merged in v0.20.0) is the closest
  // match, so both slat presets use it here rather than `matte` (0.8),
  // which would sit visibly duller than the real panel. The backing stays
  // `matte` regardless -- it is hard-coded in buildSlatPanel below, not
  // driven by this `finish` param, which only ever reaches the slat mesh.
  finish: 'satin',
  // Subtle low-contrast vertical streaks on the slat faces, matching the
  // bedroom panel's procedural oak-grain roughness map (home3d-scene.js
  // makeOakGrainTexture, ~L736 -- that module already declares this
  // generator twice, so the duplicate here is deliberate rather than shared:
  // importing across the furniture/scene boundary either way conflicts with
  // feat/furniture-renderer's own use of the scene module. See
  // makeOakGrainRoughnessMap() below for the copy used here). Off by
  // default (only the oak preset wants it); a builder opting in departs
  // from "every material is exactly what makeFinish() returns" -- see the
  // note on grainMap below.
  grainMap: false
});

/**
 * Procedural oak-grain roughness map: subtle, low-contrast vertical streaks.
 * DUPLICATED from src/home3d-scene.js's makeOakGrainTexture (~L736, the
 * bedroom's hard-coded acoustic slat panel) rather than shared, on purpose:
 * that module already declares this generator twice internally, and an
 * import either direction across the furniture/scene boundary conflicts
 * with feat/furniture-renderer's own use of home3d-scene.js. If the two
 * generators ever need to diverge, they are independent copies; keep them
 * in step by eye until a real shared module exists for both sides.
 *
 * NODE / NO-DOM BUILDS: `document.createElement('canvas')` does not exist
 * under plain Node, which is where the builder-contract drift tests run
 * this module (bbox vs DEFAULTS, finish/keep tagging, low-detail triangle
 * count) -- same pattern as wall-sign.js's resolveCreateCanvas. With no
 * global `document`, this returns null and the caller simply does not get
 * a grain map (matte colour only) rather than throwing.
 *
 * This is deliberately NOT part of the closed finish palette in
 * finishes.js: a roughness map is a real, if narrow, exception to "every
 * material comes from makeFinish() unmodified" (see the file header above)
 * -- there is no grained finish key. A caller applies it on top of a
 * makeFinish() material and should mark that mesh `keep` so it opts out of
 * any future finish-bucket merge instead of silently losing the map to it.
 *
 * @param {Object} THREE
 * @returns {?THREE.CanvasTexture}  null if no DOM canvas is available
 */
function makeOakGrainRoughnessMap(THREE) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const w = 16, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d9d9d9';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    const x0 = Math.random() * w;
    const shade = 190 + Math.random() * 50; // subtle, low-contrast like wallRoughMap
    ctx.strokeStyle = `rgba(${shade},${shade},${shade},0.5)`;
    ctx.lineWidth = 0.4 + Math.random() * 0.6;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.bezierCurveTo(
      x0 + (Math.random() - 0.5) * 3, h * 0.33,
      x0 + (Math.random() - 0.5) * 3, h * 0.66,
      x0 + (Math.random() - 0.5) * 2, h
    );
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 5);
  return tex;
}

/**
 * Vertical slat panelling: a felt backing plane with evenly spaced slats
 * standing proud of it. Slats are fit to the whole width, redistributing any
 * remainder into the gap so the run always starts and ends on a slat (matches
 * the real acoustic-panel wall this is ported from).
 *
 * @param {Object} THREE
 * @param {Object} [params]  overrides for SLAT_DEFAULTS
 * @param {{detail?: 'full'|'low'}} [opts]  slats have no detail to drop --
 *   a slat panel is already cheap (a handful of boxes)
 * @returns {THREE.Group}
 */
function buildSlatPanel(THREE, params, opts) { // eslint-disable-line no-unused-vars
  const p = Object.assign({}, SLAT_DEFAULTS, params || {});
  const widthM = p.width / 100, heightM = p.height / 100;
  const slatWidthM = p.slatWidth / 100, slatDepthM = p.slatDepth / 100;
  const backingDepthM = p.backingDepth / 100;
  const nomPitchM = p.pitch / 100;

  // Fit whole slats across the width; spread the remainder into the gap so
  // a slat sits flush with both edges.
  const n = Math.max(1, Math.round(widthM / nomPitchM));
  const gap = n > 1 ? (widthM - n * slatWidthM) / (n - 1) : 0;
  const pitch = slatWidthM + gap;

  const group = new THREE.Group();
  group.name = 'furniture:slat-panel';

  const backingMat = makeFinish(THREE, 'matte', p.backingColor);
  const slatMat = makeFinish(THREE, p.finish, p.slatColor);
  // Opt-in oak-grain roughness map (matches the bedroom's hard-coded panel;
  // see makeOakGrainRoughnessMap() above for why it is a duplicate rather
  // than a shared import): stamped directly on the material makeFinish()
  // returned, which is a deliberate, narrow exception to "every material
  // comes from makeFinish() unmodified" -- the alternative is no grain at
  // all, since the palette has no grained finish. Marking the mesh `keep`
  // (below) means it opts out of the renderer's future finish-bucket merge
  // instead of silently losing the map to it. makeOakGrainRoughnessMap
  // returns null under plain Node (no DOM canvas) -- the drift/geometry
  // tests still exercise every other grainMap effect (keep flag, params).
  const grainTex = p.grainMap ? makeOakGrainRoughnessMap(THREE) : null;
  if (grainTex) slatMat.roughnessMap = grainTex;

  // Depth stack, back (z=0) toward front (+z): backing sits at z=0..backingDepth,
  // slats protrude beyond it to backingDepth..backingDepth+slatDepth.
  const backingGeo = new THREE.BoxGeometry(widthM, heightM, backingDepthM);
  backingGeo.translate(0, heightM / 2, backingDepthM / 2);
  const backing = new THREE.Mesh(backingGeo, backingMat);
  backing.receiveShadow = true;
  if (isKeptFinish(backingMat.userData.finish)) backing.userData.keep = true;
  group.add(backing);

  const slatGeo = new THREE.BoxGeometry(slatWidthM, heightM, slatDepthM);
  slatGeo.translate(0, heightM / 2, backingDepthM + slatDepthM / 2);
  const startX = -widthM / 2;
  for (let i = 0; i < n; i++) {
    const cx = startX + i * pitch + slatWidthM / 2;
    const slat = new THREE.Mesh(slatGeo, slatMat);
    slat.position.x = cx;
    slat.castShadow = true;
    slat.receiveShadow = true;
    if (isKeptFinish(slatMat.userData.finish) || p.grainMap) slat.userData.keep = true;
    group.add(slat);
  }

  return group;
}

// ---------------------------------------------------------------------------
// hex-panel-cluster
// ---------------------------------------------------------------------------

// Default cluster: the living-room hex wall. Flat-top hexes in vertical
// columns, left to right, matching the photo reference (spec review,
// 2026-09-26, WallPanelSpec.md): columns [3,4,5,4,4,4,3,2] = 29 hexes.
// Column 5 (1-based; index 4) is shifted DOWN half a hex so it interlocks
// with columns 4 and 6, which (like it) both have 4 hexes -- centring all
// three would leave them level with no honeycomb notch between them. Every
// other neighbouring pair differs by one hex and interlocks when centred.
const HEX_DEFAULT_COLUMNS = Object.freeze([3, 4, 5, 4, 4, 4, 3, 2]);
const HEX_DEFAULT_COLUMN_OFFSETS = Object.freeze([0, 0, 0, 0, 1, 0, 0, 0]);

const HEX_CLUSTER_DEFAULTS = Object.freeze({
  side: 18,
  columns: HEX_DEFAULT_COLUMNS,
  columnOffsets: HEX_DEFAULT_COLUMN_OFFSETS,
  thickness: 1,
  // #1e3228 (round-2 default) rendered too bright under the spec page's
  // lights (~rgb(51,63,55) lit) against the real panels' near-black green
  // (review round 3, 2026-09-26). Judged empirically on the spec page
  // under its own lights (sampled actual rendered pixels, not raw swatches):
  // the requested #14201a-#18251e range renders to ~rgb(50,62,52) -- almost
  // unchanged from round 2 -- because the scene's ambient light (intensity
  // 0.45, spec-three.jsx) adds a large near-flat floor to every channel
  // regardless of the base colour; a near-black base like #050a07 crushes
  // to ~rgb(38,38,35), which reads as plain black/neutral with no green at
  // all. #0a2515 (outside the literal suggested range, deliberately: R
  // pushed lower and G kept relatively high to fight the ambient floor's
  // greying effect) renders to ~rgb(41,53,42) -- meaningfully darker than
  // round 2 AND still clearly green (G noticeably above both R and B).
  color: '#0a2515',
  finish: 'matte',
  // Chamfered edge (review round 3, 2026-09-26): each real panel is
  // full thickness in the centre, sloping down to a thinner rim, so two
  // adjacent hexes form a visible V-groove where they meet. bevelWidth is
  // how far in from the hex's own outer edge the slope starts (the front
  // face is inset by this much on every side); bevelDepth is how much
  // thinner the rim is than the centre (must be < thickness). Modelled as a
  // custom inset-top prism, NOT THREE.ExtrudeGeometry's own bevelEnabled --
  // that bevel grows the shape OUTWARD from the base outline (verified:
  // bevelSize 0.9cm added 1cm to every side of the footprint in a probe),
  // which would silently change the layout pitch this module guarantees
  // stays fixed. See buildBeveledHexGeometry() below.
  bevelWidth: 0.9,
  bevelDepth: 0.5,
  // width/height/depth are DERIVED from side+columns (the cluster's bbox),
  // but the contract requires DEFAULTS to carry them so the drift test and
  // the schema `default`s can agree without running JS. Computed once below
  // and frozen in below the column/offset defaults are settled.
  width: 0,
  height: 0,
  depth: 0
});

// Flat-top hex geometry constant: sqrt(3) relates a flat-top hex's side to
// its own apothem (side*sqrt(3)/2) and, further below, relates the honeycomb
// column layout's vertical/horizontal pitch to `side`. Declared here (ahead
// of hexPoints/buildBeveledHexGeometry, which both use it) rather than only
// where layoutHexes needs it, since it is now a shared hex-geometry constant.
const SQRT3 = Math.sqrt(3);

/**
 * Flat-top regular hexagon centred at the origin, side length `s` (metres),
 * as an array of [x, y] outline points (6, no repeated first point) --
 * vertices point left/right, flat edges top/bottom.
 */
function hexPoints(s) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    // Flat-top: first vertex straight right (angle 0deg), 60deg apart.
    const a = (Math.PI / 180) * (60 * i);
    pts.push([s * Math.cos(a), s * Math.sin(a)]);
  }
  return pts;
}

/**
 * A flat-top hex panel with a chamfered front edge: full `thickness` in the
 * centre, sloping down over `bevelWidth` (measured inward from the outer
 * edge, in the same units as `side`) to a rim that is `bevelDepth` thinner
 * than the centre. The BACK face and the OUTER footprint are exactly the
 * plain flat hex's (hexPoints(side) at z=0) -- only the FRONT is affected,
 * so the layout pitch (which is keyed to `side`) is untouched.
 *
 * Built as a custom BufferGeometry rather than THREE.ExtrudeGeometry's own
 * bevelEnabled: that bevel grows the shape's footprint outward from the
 * base outline by `bevelSize` on every side (verified empirically), which
 * would silently widen the honeycomb's pitch. Four rings of vertices:
 *   1. back face (outer hex, z=0, facing -z)
 *   2. side wall: outer hex from z=0 to z=(thickness-bevelDepth), straight
 *      (this is the "full thickness in the centre" region)
 *   3. bevel ring: outer hex at z=(thickness-bevelDepth) sloping in to the
 *      inner hex (radius reduced so its flat-to-flat apothem is inset by
 *      bevelWidth) at z=thickness -- the visible chamfer
 *   4. front (plateau) face: inner hex, z=thickness, facing +z
 *
 * A flat-top hex's apothem (centre-to-edge-midpoint distance) is
 * `side*sqrt(3)/2`, so insetting the apothem by `bevelWidth` shrinks `side`
 * by `bevelWidth / (sqrt(3)/2)`; `innerSide` is clamped to a small positive
 * floor so a bevelWidth close to or exceeding `side` degrades to a thin
 * ridge rather than a degenerate/negative-radius hex.
 *
 * @param {Object} THREE
 * @param {number} side  hex side length (metres or cm; same unit as bevel params)
 * @param {number} thickness  overall panel depth
 * @param {number} bevelWidth  inward inset of the front plateau from the outer edge
 * @param {number} bevelDepth  how much thinner the rim is than the centre (< thickness)
 * @returns {THREE.BufferGeometry}
 */
function buildBeveledHexGeometry(THREE, side, thickness, bevelWidth, bevelDepth) {
  const apothem = (SQRT3 / 2) * side;
  const innerSide = Math.max(side - bevelWidth / (SQRT3 / 2), side * 0.05);
  const outerPts = hexPoints(side);
  const innerPts = hexPoints(innerSide);
  const zBack = 0;
  const zPlateauFront = Math.max(0, thickness - bevelDepth);
  const zFront = thickness;

  const positions = [];
  const indices = [];
  let vi = 0;

  function pushRingStrip(ringA, ringB, zA, zB) {
    const n = ringA.length;
    const base = vi;
    for (let i = 0; i < n; i++) {
      positions.push(ringA[i][0], ringA[i][1], zA);
      positions.push(ringB[i][0], ringB[i][1], zB);
    }
    vi += n * 2;
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      const a0 = base + i * 2, a1 = base + i * 2 + 1;
      const b0 = base + i2 * 2, b1 = base + i2 * 2 + 1;
      indices.push(a0, b0, a1);
      indices.push(a1, b0, b1);
    }
  }

  function pushFan(ring, z, flip) {
    const n = ring.length;
    const centreIdx = vi;
    positions.push(0, 0, z);
    vi++;
    const startIdx = vi;
    for (let i = 0; i < n; i++) positions.push(ring[i][0], ring[i][1], z);
    vi += n;
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      if (flip) indices.push(centreIdx, startIdx + i2, startIdx + i);
      else indices.push(centreIdx, startIdx + i, startIdx + i2);
    }
  }

  pushFan(outerPts, zBack, true);                            // back face
  pushRingStrip(outerPts, outerPts, zBack, zPlateauFront);    // straight side wall
  pushRingStrip(outerPts, innerPts, zPlateauFront, zFront);   // sloped bevel ring
  pushFan(innerPts, zFront, false);                           // front plateau face

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  void apothem; // kept for documentation of the inset maths above
  return geo;
}

// Honeycomb column layout: a flat-top hex is `2*s` tall corner-to-corner
// (vertical pitch between hex centres stacked in the same column) and
// `sqrt(3)*s` wide flat-to-flat, with columns spaced `1.5*s` apart
// horizontally (each column's points nest into the previous column's
// notch). SQRT3 itself is declared above, alongside hexPoints.

/**
 * Lay out a honeycomb cluster in vertical columns and return
 * { centres, minX, maxX, minY, maxY } in the same units as `side` (works in
 * cm or m; used in cm here since only the shape matters, not the unit).
 *
 * `columns` is a hex count per column, left to right. `columnOffsets`, if
 * given, is a per-column shift in HALF-HEX units (half the vertical pitch)
 * added on top of the automatic centring -- so `0` for every column still
 * centres each column, matching the DEFAULTS contract ("Default the offsets
 * to centre each column").
 */
function layoutHexes(side, columns, columnOffsets) {
  const rowPitch = SQRT3 * side;   // vertical distance between hex centres in a column
  const colPitch = 1.5 * side;     // horizontal distance between column centres
  const halfHex = rowPitch / 2;
  const maxCount = Math.max(...columns);
  const centres = [];
  columns.forEach((count, c) => {
    const colHeight = (count - 1) * rowPitch;
    const maxHeight = (maxCount - 1) * rowPitch;
    // Centre this column against the tallest column by default...
    let y0 = -colHeight / 2;
    // ...then apply any explicit half-hex offset on top (positive = down).
    const off = (columnOffsets && typeof columnOffsets[c] === 'number') ? columnOffsets[c] : 0;
    y0 -= off * halfHex;
    const x = c * colPitch; // column 0 at the left, x increasing rightward
    for (let r = 0; r < count; r++) {
      centres.push([x, y0 + r * rowPitch]);
    }
    // silence unused-var lint for maxHeight (kept for readability/future use)
    void maxHeight;
  });
  const half = side; // a flat-top hex's own half-extent in y is side*sqrt3/2, in x is side
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  centres.forEach(([cx, cy]) => {
    minX = Math.min(minX, cx - half);
    maxX = Math.max(maxX, cx + half);
    minY = Math.min(minY, cy - (SQRT3 / 2) * side);
    maxY = Math.max(maxY, cy + (SQRT3 / 2) * side);
  });
  return { centres, minX, maxX, minY, maxY };
}

// Compute the default cluster's bbox once, at module load, so DEFAULTS can
// carry frozen width/height/depth as the contract requires.
const _defaultLayout = layoutHexes(HEX_CLUSTER_DEFAULTS.side, HEX_DEFAULT_COLUMNS, HEX_DEFAULT_COLUMN_OFFSETS);
export const DEFAULTS_HEX_PANEL_CLUSTER = Object.freeze(Object.assign({}, HEX_CLUSTER_DEFAULTS, {
  width: Math.round((_defaultLayout.maxX - _defaultLayout.minX) * 100) / 100,
  height: Math.round((_defaultLayout.maxY - _defaultLayout.minY) * 100) / 100,
  depth: HEX_CLUSTER_DEFAULTS.thickness
}));

/**
 * A honeycomb cluster of regular hexagon felt panels: 29 meshes (at the
 * living-room default) sharing ONE geometry instance and one material --
 * each hex is its own THREE.Mesh (so it can be independently positioned),
 * but all 29 reuse the same small geometry and MeshStandardMaterial rather
 * than each allocating its own, which is what "cheap" means here (low
 * memory, a handful of triangles total) -- not a single merged
 * BufferGeometry / one draw call, which this does not attempt.
 *
 * @param {Object} THREE
 * @param {Object} [params]  overrides for DEFAULTS_HEX_PANEL_CLUSTER.
 *   `columns` is an array of per-column counts, left to right;
 *   `columnOffsets` an optional array of per-column half-hex shifts (same
 *   length as `columns`, or omitted to centre every column); `bevelWidth`/
 *   `bevelDepth` control the chamfered front edge (see
 *   buildBeveledHexGeometry above), and the hex's own outer footprint and
 *   the column/row pitch (both keyed to `side` alone) are unaffected by
 *   either.
 * @param {{detail?: 'full'|'low'}} [opts]  'low' drops the bevel entirely
 *   (a flat bevel-free extrusion, 60 vertices/hex) since the chamfer is a
 *   close-up-only detail; 'full' uses the custom beveled geometry (38
 *   vertices/hex -- fewer than the flat extrusion, despite the extra front
 *   ring, because it skips ExtrudeGeometry's own curve subdivision).
 * @returns {THREE.Group}
 */
function buildHexPanelCluster(THREE, params, opts) { // eslint-disable-line no-unused-vars
  const p = Object.assign({}, DEFAULTS_HEX_PANEL_CLUSTER, params || {});
  const sideM = p.side / 100;
  const thicknessM = p.thickness / 100;
  const bevelWidthM = p.bevelWidth / 100;
  const bevelDepthM = p.bevelDepth / 100;
  const columns = Array.isArray(p.columns) && p.columns.length ? p.columns : HEX_DEFAULT_COLUMNS;
  const columnOffsets = Array.isArray(p.columnOffsets) ? p.columnOffsets : null;
  const lowDetail = opts && opts.detail === 'low';

  const layout = layoutHexes(sideM, columns, columnOffsets);
  const widthM = layout.maxX - layout.minX;
  const heightM = layout.maxY - layout.minY;
  // Centre the whole cluster on local x = 0, bottom at y = 0, back at z = 0.
  const originX = (layout.minX + layout.maxX) / 2;
  const originY = layout.minY;

  let hexGeo;
  if (lowDetail) {
    // 'low': flat, bevel-free hex -- the chamfer is a close-up-only detail,
    // not worth its extra vertices at low LOD.
    const shapePts = hexPoints(sideM);
    const shape = new THREE.Shape();
    shapePts.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
    shape.closePath();
    hexGeo = new THREE.ExtrudeGeometry(shape, { depth: thicknessM, bevelEnabled: false, curveSegments: 1 });
    // ExtrudeGeometry extrudes 0..depth along +z from the shape's xy plane,
    // which already matches this module's own (x, y, z=depth) frame -- no
    // rotation needed.
  } else {
    hexGeo = buildBeveledHexGeometry(THREE, sideM, thicknessM, bevelWidthM, bevelDepthM);
  }

  const mat = makeFinish(THREE, p.finish, p.color);
  const group = new THREE.Group();
  group.name = 'furniture:hex-panel-cluster';

  layout.centres.forEach(([cx, cy]) => {
    const mesh = new THREE.Mesh(hexGeo, mat);
    mesh.position.set(cx - originX, cy - originY, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
  });

  // Sanity fallback: an empty columns array (all zero counts) would leave an
  // empty group and a zero-size bbox, which the contract test would then
  // reject on both width and height -- guard against that by refusing to
  // shrink below a single hex's own footprint.
  if (!layout.centres.length) {
    const mesh = new THREE.Mesh(hexGeo, mat);
    if (isKeptFinish(mat.userData.finish)) mesh.userData.keep = true;
    group.add(mesh);
  }

  void widthM; void heightM; // kept for documentation/debugging symmetry with slat-panel
  return group;
}

// ---------------------------------------------------------------------------
// Multi-type export
// ---------------------------------------------------------------------------

export const TYPES = {
  'slat-panel': { DEFAULTS: SLAT_DEFAULTS, build: buildSlatPanel },
  'hex-panel-cluster': { DEFAULTS: DEFAULTS_HEX_PANEL_CLUSTER, build: buildHexPanelCluster }
};
