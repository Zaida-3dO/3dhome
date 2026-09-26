/**
 * dining.js - the kitchen dining set: a round table and its chairs. A
 * multi-type module per the builder contract (see docs/house-profile.md,
 * "Multi-type modules").
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Each TYPES[key] exports DEFAULTS (frozen, cm, includes width/depth/
 *     height) and build(THREE, params, { detail: 'full' | 'low' }) -> Group.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0 and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 * See docs/house-profile.md, "Furniture".
 *
 * REFERENCE. Modelled from real kitchen photos of this house: a small round
 * SPACE-SAVING NESTING set. Round WHITE MATTE top (~2.5-3cm thin, ~100cm
 * diameter) on FOUR slim square black legs splayed outward (no pedestal),
 * positioned in the GAPS between the tucked chairs, joined by a low black
 * crossbar frame near the floor. Four `dining-chair`s are each a 90-degree
 * WEDGE (quadrant) of a cylinder -- black velvet, a continuous curved back
 * shell as the outer arc, the seat narrowing to a point at the front (the
 * side facing the table centre). Tucked in, the four wedges together form a
 * black cylinder that the white top overhangs slightly, like a lid. Each
 * chair stands on four slim square black legs (inside its own wedge
 * footprint, so nested chairs' legs never collide) joined by a low box
 * stretcher.
 *
 * REDESIGN (item 89769f2b, 2026-09-26): new reference photos of the real set
 * arrived (private, never committed) and the nesting concept was explained
 * over several corrections, closing 30f119ef (the earlier tub-back likeness
 * gap) at the same time. This replaces the original pedestal table and
 * low-back/tapered-leg chair entirely.
 *
 * HISTORY. The wall clock that used to live in this module was split out
 * (item 89769f2b, 2026-09-26) into its own module, src/furniture/wall-clock.js,
 * and its own spec page, specs/ClockSpec.html -- it shared no geometry with
 * the table/chairs, just a spec page by coincidence of both being kitchen
 * photos. See wall-clock.js for the clock's own history note.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

// ---------------------------------------------------------------------------
// dining-table - round top on four splayed square legs, no pedestal, joined
// by a low X crossbar frame near the floor.
// ---------------------------------------------------------------------------

const TABLE_DEFAULTS = Object.freeze({
  width: 100,     // diameter, cm (also used as `depth` -- see build())
  depth: 100,
  height: 75,
  topColor: '#f5f5f2',
  topFinish: 'matte',
  legColor: '#1a1a1a',
  legFinish: 'matte',
  frameHeight: 22   // cm, floor to the crossbar frame's centre
});

/**
 * A round table only has one horizontal size, `diameter`, but the builder
 * contract's bbox check needs width AND depth to both equal it -- so both
 * DEFAULTS keys carry the same number and a caller only needs to override
 * one of them (or neither) to resize the whole thing evenly.
 */
function buildDiningTable(THREE, params, opts) {
  const p = Object.assign({}, TABLE_DEFAULTS, params || {});
  const diameter = Math.min(p.width, p.depth) / 100;
  const r = diameter / 2;
  const h = p.height / 100;
  const detail = opts && opts.detail === 'low';

  const topThickness = 0.028;
  // A thin flat disk reads the same at 32 segments as at 48 -- kept low to
  // stay inside the per-type triangle budget (200 full / 100 low, see
  // perf-audit-furniture.md B3) now that this builder also carries 4 legs
  // and a crossbar frame it did not have as a pedestal design.
  const segments = detail ? 14 : 32;
  const legMat = makeFinish(THREE, p.legFinish, p.legColor);

  const group = new THREE.Group();
  group.name = 'furniture:dining-table';

  // Top: a short cylinder, its top face at y = h. Thin (2.8 cm) and matte
  // white per the photo -- no gloss sheen on the real top.
  const topGeo = new THREE.CylinderGeometry(r, r, topThickness, segments);
  topGeo.translate(0, h - topThickness / 2, r);
  const top = new THREE.Mesh(topGeo, makeFinish(THREE, p.topFinish, p.topColor));
  top.name = 'tabletop';
  if (isKeptFinish(top.material.userData.finish)) top.userData.keep = true;
  group.add(top);

  // Four slim square legs, splayed outward: each leg's TOP attaches inset
  // under the rim and its FOOT lands further out and exactly at the floor
  // (y=0) -- the outward lean the photo shows. Each leg is tilted about a
  // single horizontal axis PERPENDICULAR to its own outward diagonal (so the
  // tilt is purely radial, away from centre, not skewed), and its length is
  // scaled by 1/cos(splayAngle) so its VERTICAL projection still spans
  // exactly h - topThickness -- the foot lands at y=0 by construction,
  // independent of splayAngle.
  const legSize = 0.032;               // square cross-section, metres
  const legTopInset = r * 0.62;        // how far in from the rim the leg attaches
  const splayAngle = 0.16;             // radians outward tilt, from vertical
  // The centreline compensation below (1/cos(splayAngle)) is exact for a
  // ROUND leg; a SQUARE leg's tilted corners drop a little further still.
  // Rather than solve the exact trig for an arbitrary diagonal tilt axis,
  // shrink the target span by the same order-of-magnitude correction
  // (half the cross-section times sin(splayAngle)) so the corner-accurate
  // fix-up below (measured from the real geometry) only has a sub-millimetre
  // residual to correct, keeping both y=0 AND y=h accurate to the contract's
  // 0.5 cm tolerance.
  const vertSpan = h - topThickness - (legSize / 2) * Math.sin(splayAngle);
  const legLen = vertSpan / Math.cos(splayAngle);

  const legGeo = new THREE.BoxGeometry(legSize, legLen, legSize);
  legGeo.translate(0, -legLen / 2, 0); // pivot (0,0,0) is the TOP end of the leg
  const legCorners = [
    { sx: -1, sz: -1 }, { sx: 1, sz: -1 }, { sx: -1, sz: 1 }, { sx: 1, sz: 1 }
  ];
  const legFeet = [];
  const legTops = [];
  legCorners.forEach((c, i) => {
    const leg = new THREE.Mesh(legGeo.clone(), legMat.clone());
    leg.name = 'leg' + i;
    // The outward diagonal in the xz-plane, from centre through this
    // corner: (c.sx, c.sz) normalised. Tilting about the axis perpendicular
    // to that diagonal (in the horizontal plane) swings the foot straight
    // out along the diagonal, away from centre -- true radial splay.
    const diag = new THREE.Vector2(c.sx, c.sz).normalize();
    const tiltAxis = new THREE.Vector3(-diag.y, 0, diag.x); // perpendicular, horizontal
    leg.setRotationFromAxisAngle(tiltAxis, splayAngle);
    const top3 = new THREE.Vector3(c.sx * legTopInset, h - topThickness, c.sz * legTopInset + r);
    leg.position.copy(top3);
    group.add(leg);
    legTops.push(top3);
    // The foot's world position, for the crossbar frame below.
    const footLocal = new THREE.Vector3(0, -legLen, 0);
    leg.updateMatrix();
    footLocal.applyMatrix4(leg.matrix);
    legFeet.push(footLocal);
  });

  // Low crossbar frame joining the four legs, an X across the diagonals --
  // the "black crossbar frame joining the legs, visible as an X ... in the
  // floor shadow" from the photo. Two thin bars, one per diagonal, crossing
  // at the centre at a fixed height, each running leg-centreline to
  // leg-centreline at that height.
  const frameY = Math.max(0.01, Math.min(p.frameHeight / 100, vertSpan - 0.02));
  const barThickness = 0.02;
  function crossbar(a, b, name) {
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const dir = new THREE.Vector3().subVectors(b, a);
    const lenFlat = Math.hypot(dir.x, dir.z);
    const barGeo = new THREE.BoxGeometry(lenFlat, barThickness, barThickness);
    const bar = new THREE.Mesh(barGeo, legMat.clone());
    bar.name = name;
    bar.position.set(mid.x, frameY, mid.z);
    bar.rotation.y = -Math.atan2(dir.z, dir.x);
    group.add(bar);
  }
  // Each leg's centreline point at height frameY, by linear interpolation
  // between its (known) top and foot world positions.
  const framePoints = legTops.map((top3, i) => {
    const foot = legFeet[i];
    const t = (top3.y - frameY) / (top3.y - foot.y);
    return new THREE.Vector3().lerpVectors(top3, foot, Math.min(1, Math.max(0, t)));
  });
  crossbar(framePoints[0], framePoints[3], 'crossbarA'); // (-,-) to (+,+)
  crossbar(framePoints[1], framePoints[2], 'crossbarB'); // (+,-) to (-,+)

  // The splayed legs are SQUARE in cross-section, so their tilted corners
  // (not just the centreline the trig above targets) drop a fraction of a
  // centimetre past y=0 -- solving that in closed form for an arbitrary
  // diagonal tilt axis is not worth it when a single measured correction
  // is exact and cheap: nudge the whole assembly up so its true minimum Y
  // (from the real geometry, corners included) lands at exactly 0, per the
  // builder contract.
  const realMinY = new THREE.Box3().setFromObject(group).min.y;
  if (realMinY !== 0) group.position.y -= realMinY;

  return group;
}

// ---------------------------------------------------------------------------
// dining-chair - a 90-degree WEDGE (quadrant) of a cylinder: four of these,
// tucked in, form the black cylinder the round table top sits on like a lid.
// The curved velvet back is the cylinder's OUTER arc; the seat is the wedge
// itself, its narrow point (the front) aimed at the table centre.
// ---------------------------------------------------------------------------

const CHAIR_DEFAULTS = Object.freeze({
  // width/depth are DERIVED from radius/backSweep (see build()) -- carried
  // in DEFAULTS anyway because the builder contract requires numeric
  // width/depth/height, and the furniture-defaults drift test computes
  // footprints from these without running any JS.
  width: 63.6,     // 2 * radius * sin(backSweep/2) at the DEFAULTS below
  depth: 45,       // == radius
  height: 75,
  radius: 45,          // cm, the arc's radius -- also this wedge's depth
  backSweep: 90,       // degrees, the arc's angular span, centred on straight back
  seatHeight: 52,      // cm, floor to the top of the seat (photo reads 50-55cm)
  seatColor: '#1a1a1a',
  seatFinish: 'matte',
  legColor: '#1a1a1a',
  legFinish: 'matte'
});

/**
 * Local frame per the builder contract: y=0 bottom, x centred, BACK at
 * z=0, front faces +z. For this wedge that means: the curved arc (the
 * chair's back, symmetric about x=0) touches z=0 at its centre (straight
 * back) and curves forward (+z) toward its two side edges; the wedge's
 * point -- the front, aimed at the table centre when placed -- sits at
 * (0, radius), the far +z corner. Placing the arc's centre of curvature AT
 * the apex point means every arc vertex is exactly `radius` from the apex,
 * which is what keeps the back-vertex-at-z=0 / apex-at-z=depth relationship
 * exact regardless of backSweep.
 */
function buildDiningChair(THREE, params, opts) {
  const p = Object.assign({}, CHAIR_DEFAULTS, params || {});
  const radius = p.radius / 100;
  const sweep = (p.backSweep * Math.PI) / 180;
  const h = p.height / 100;
  const seatH = Math.min(p.seatHeight / 100, h - 0.02);
  const detail = opts && opts.detail === 'low';

  const group = new THREE.Group();
  group.name = 'furniture:dining-chair';

  const seatMat = makeFinish(THREE, p.seatFinish, p.seatColor);
  const legMat = makeFinish(THREE, p.legFinish, p.legColor);

  // ---- Seat: an extruded wedge (a wide "pie slice" that narrows to a
  // point at the front), built as a THREE.Shape swept to seatThickness. ----
  const seatThickness = 0.04;
  const arcSegs = detail ? 6 : 14;
  const apex = new THREE.Vector2(0, radius); // the front point, +z
  const shape = new THREE.Shape();
  shape.moveTo(apex.x, apex.y);
  for (let i = 0; i <= arcSegs; i++) {
    const a = -sweep / 2 + (i / arcSegs) * sweep; // angle from straight back
    // Arc centred AT the apex, radius `radius`: back-centre (a=0) lands at
    // z=0 exactly; side edges land at z = radius*(1-cos(a/2... )) > 0.
    const x = radius * Math.sin(a);
    const z = radius - radius * Math.cos(a);
    shape.lineTo(x, z);
  }
  shape.lineTo(apex.x, apex.y);
  const seatGeo = new THREE.ExtrudeGeometry(shape, { depth: seatThickness, bevelEnabled: false });
  // ExtrudeGeometry builds in the shape's local xy-plane extruded along +z
  // (its OWN z, i.e. thickness) -- rotateX(+90deg) maps shape-local (x,y) to
  // world (x,z) directly (shape y=radius, our apex, lands at world z=radius,
  // matching the seat-shape convention above) but leaves the extrude's own
  // thickness axis spanning world y in [-seatThickness, 0], so translate by
  // +seatThickness to bring it to [0, seatThickness].
  seatGeo.rotateX(Math.PI / 2);
  seatGeo.translate(0, seatH, 0);
  const seat = new THREE.Mesh(seatGeo, seatMat);
  seat.name = 'seat';
  if (isKeptFinish(seat.material.userData.finish)) seat.userData.keep = true;
  group.add(seat);

  // ---- Back: a thin curved shell rising from the arc, the outer wall of
  // the eventual cylinder. ~40cm tall per the photo, highest at the centre
  // back and curving down/out toward the sides is out of scope for a first
  // cut -- a constant-height shell already reads as "one continuous arc"
  // from every normal viewing angle, and keeps the bbox height exact. ----
  const backHeight = Math.max(0.01, Math.min(0.40, h - seatH));
  const backThickness = 0.025;
  const innerR = radius - backThickness;
  const backSegs = detail ? 6 : 16;

  // CylinderGeometry's own local frame sweeps theta -> (x=r*sin(theta),
  // z=r*cos(theta)); to match the seat shape's x=r*sin(a), z=r-r*cos(a)
  // convention (back-centre a=0 at world z=0, curving forward to +z), the
  // cylinder needs its z axis MIRRORED (scale z by -1) before translating by
  // +radius -- confirmed by probe: theta=0 -> z=0, theta=+-sweep/2 -> the
  // same side-edge z the seat shape produces, for every sweep.
  function backShell(rad, name) {
    const geo = new THREE.CylinderGeometry(rad, rad, backHeight, backSegs, 1, true, -sweep / 2, sweep);
    geo.scale(1, 1, -1);
    geo.translate(0, 0, rad);
    geo.translate(0, seatH + backHeight / 2, 0);
    const mesh = new THREE.Mesh(geo, seatMat.clone());
    mesh.name = name;
    // Matte velvet, same finish/merge rule as every other flat-palette part
    // (see finishes.js) -- curved geometry alone is not a reason to force
    // userData.keep; only glass/mirror/emissive or a genuinely moving part
    // is (neither applies to a static upholstered back).
    if (isKeptFinish(mesh.material.userData.finish)) mesh.userData.keep = true;
    return mesh;
  }
  const backGroup = new THREE.Group();
  backGroup.name = 'back';
  backGroup.add(backShell(radius, 'backOuter'), backShell(innerR, 'backInner'));
  group.add(backGroup);

  // ---- Legs: 4 slim square near-vertical legs, placed INSIDE the wedge
  // footprint (well clear of the arc AND the two straight sides) so four
  // nested chairs' legs never collide, joined by a low box stretcher. ----
  const legSize = 0.03;
  const legLen = seatH - seatThickness;
  const legMargin = 0.045; // safety margin in from the wedge's true edge

  // The wedge's actual boundary, for a leg-safe half-width at any z: the arc
  // (0 <= z <= zEnd, the arc endpoints' own z) for the back, then the two
  // STRAIGHT sides running from the arc endpoints up to the apex (0, radius)
  // for the rest -- this is a triangle-ish wedge, not a rectangle, so a
  // fixed half-width (the earlier approach) put the front two legs outside
  // the shape entirely once z exceeded zEnd.
  const halfSweep = sweep / 2;
  const xEnd = radius * Math.sin(halfSweep);
  const zEnd = radius - radius * Math.cos(halfSweep);
  function safeHalfWidthAtZ(z) {
    if (z <= zEnd) {
      // On the arc: invert z = radius - radius*cos(a) -> a = acos(1 - z/radius).
      const a = Math.acos(Math.min(1, Math.max(-1, 1 - z / radius)));
      return radius * Math.sin(a) - legMargin;
    }
    // On the straight side: linear from (xEnd, zEnd) to (0, radius).
    return Math.max(0, xEnd * (radius - z) / (radius - zEnd) - legMargin);
  }
  // Two rows: a "back" row just past the arc (z = zEnd + a small step) and a
  // "front" row well short of the apex, both using the shape's own safe
  // half-width at that z so every backSweep/radius combination stays inside.
  const zBack = zEnd + 0.02;
  const zFront = Math.min(radius * 0.75, radius - 0.10);
  const legPositions = [
    { x: -safeHalfWidthAtZ(zBack) * 0.9, z: zBack },
    { x: safeHalfWidthAtZ(zBack) * 0.9, z: zBack },
    { x: -safeHalfWidthAtZ(zFront) * 0.9, z: zFront },
    { x: safeHalfWidthAtZ(zFront) * 0.9, z: zFront }
  ];
  const legGeo = new THREE.BoxGeometry(legSize, legLen, legSize);
  legGeo.translate(0, legLen / 2, 0);
  legPositions.forEach((pos, i) => {
    const leg = new THREE.Mesh(legGeo.clone(), legMat.clone());
    leg.name = 'leg' + i;
    leg.position.set(pos.x, 0, pos.z);
    group.add(leg);
  });

  // Low box stretcher joining the four legs near the floor.
  const stretcherY = 0.15;
  const stretcherThickness = 0.018;
  function stretcher(a, b, name) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const geo = new THREE.BoxGeometry(len, stretcherThickness, stretcherThickness);
    const bar = new THREE.Mesh(geo, legMat.clone());
    bar.name = name;
    bar.position.set((a.x + b.x) / 2, stretcherY, (a.z + b.z) / 2);
    bar.rotation.y = -Math.atan2(dz, dx);
    group.add(bar);
  }
  stretcher(legPositions[0], legPositions[1], 'stretcherBack');
  stretcher(legPositions[2], legPositions[3], 'stretcherFront');
  stretcher(legPositions[0], legPositions[2], 'stretcherLeft');
  stretcher(legPositions[1], legPositions[3], 'stretcherRight');

  return group;
}

export const TYPES = {
  'dining-table': { DEFAULTS: TABLE_DEFAULTS, build: buildDiningTable },
  'dining-chair': { DEFAULTS: CHAIR_DEFAULTS, build: buildDiningChair }
};
