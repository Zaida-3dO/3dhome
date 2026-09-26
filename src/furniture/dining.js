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

/**
 * A BoxGeometry with the two caps PERPENDICULAR TO `capAxis` dropped -- 4
 * side faces (8 tris) instead of 6 (12 tris). BoxGeometry's own face order
 * is [+x,-x,+y,-y,+z,-z] (verified against the vendored build); `capAxis`
 * picks which opposing pair to drop: 'x' drops faces 0,1 (keeps 2,3,4,5),
 * 'y' drops 2,3 (the default box faces -- keeps 0,1,4,5), 'z' drops 4,5.
 * For a leg, the hidden ends are along its own long axis (y, the default).
 * For a crossbar built as BoxGeometry(length, thickness, thickness), the
 * hidden ends are its two tips along x, not its top/bottom (which, being a
 * horizontal bar, ARE sometimes visible from below or above) -- so the
 * crossbar passes capAxis: 'x'. Saves 4 tris per part; used by every leg
 * and crossbar in buildDiningTable (perf review round 1, item 89769f2b,
 * fix #5).
 */
function openBoxGeometry(THREE, width, height, depth, capAxis) {
  const box = new THREE.BoxGeometry(width, height, depth);
  const pos = box.attributes.position.array;
  const norm = box.attributes.normal.array;
  const dropFaces = capAxis === 'x' ? [0, 1] : capAxis === 'z' ? [4, 5] : [2, 3];
  const sideFaceIdx = [0, 1, 2, 3, 4, 5].filter(f => !dropFaces.includes(f));
  const newPos = [], newNorm = [];
  sideFaceIdx.forEach(f => {
    for (let v = 0; v < 4; v++) {
      const i = (f * 4 + v) * 3;
      newPos.push(pos[i], pos[i + 1], pos[i + 2]);
      newNorm.push(norm[i], norm[i + 1], norm[i + 2]);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(newNorm, 3));
  // BoxGeometry's own per-face winding is [0,2,1, 2,3,1] (verified against
  // the vendored build), not the [0,1,2, 0,2,3] a generic quad might assume.
  const indices = [];
  for (let f = 0; f < sideFaceIdx.length; f++) {
    const base = f * 4;
    indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
  }
  geo.setIndex(indices);
  return geo;
}

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
  // white per the photo -- no gloss sheen on the real top. The underside is
  // never seen (the table always stands on its legs, never viewed from
  // below) so it carries no bottom cap -- an open-ended cylinder side
  // (2*segments tris) plus ONE manual top cap (a CircleGeometry, `segments`
  // tris) instead of a closed CylinderGeometry's two caps, saving `segments`
  // tris (14 at the low-detail default) with the top surface unchanged
  // (perf review round 1, item 89769f2b, fix #5).
  const topSide = new THREE.CylinderGeometry(r, r, topThickness, segments, 1, true);
  const topCap = new THREE.CircleGeometry(r, segments);
  topCap.rotateX(-Math.PI / 2); // CircleGeometry is built facing +z; rotate flat, facing +y
  topCap.translate(0, topThickness / 2, 0); // sits at the cylinder's own top face
  const topGeo = new THREE.BufferGeometry();
  const sidePos = topSide.attributes.position.array, capPos = topCap.attributes.position.array;
  const sideNorm = topSide.attributes.normal.array, capNorm = topCap.attributes.normal.array;
  const merged = new Float32Array(sidePos.length + capPos.length);
  merged.set(sidePos, 0);
  merged.set(capPos, sidePos.length);
  const mergedNorm = new Float32Array(sideNorm.length + capNorm.length);
  mergedNorm.set(sideNorm, 0);
  mergedNorm.set(capNorm, sideNorm.length);
  topGeo.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  topGeo.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
  const sideVertCount = sidePos.length / 3;
  const sideIdx = Array.from(topSide.index.array);
  const capIdx = Array.from(topCap.index.array, i => i + sideVertCount);
  topGeo.setIndex(sideIdx.concat(capIdx));
  topGeo.translate(0, h - topThickness / 2, r);
  const top = new THREE.Mesh(topGeo, makeFinish(THREE, p.topFinish, p.topColor));
  top.name = 'tabletop';
  if (isKeptFinish(top.material.userData.finish)) top.userData.keep = true;
  group.add(top);

  // Four slim square legs, ONE PER SEAM between the nested chairs, splayed
  // OUTWARD ALONG THE SEAM'S OWN RADIAL LINE (not diagonally past the rim --
  // round-2 visual review, item 89769f2b: legTopInset=0.70 pushed the legs
  // OUTSIDE the chair cylinder, tops at radius 0.517 (1.7cm past the 0.5m
  // rim) and feet 9-13cm beyond it, which does not match the reference
  // photos or the "legs run in the seams" directive).
  //
  // THE SEAM. A nested dining-chair's DEFAULTS backSweep is 90 deg, so 4
  // chairs ring the full 360 deg with NO gap (this is why round 1's legs had
  // nowhere to go but through a chair or past the rim). This table assumes
  // its companion chairs are built with backSweep TRIMMED to
  // SEAM_ASSUMED_BACK_SWEEP (84 deg -- inside the review's 84-86 deg
  // range), which opens a 6-degree gap centred on each of the 45/135/225/
  // 315-degree seam lines (by symmetry the seam is ALWAYS centred there,
  // independent of the exact backSweep -- see the geometry note below). A
  // leg placed exactly ON that bisector, oriented so its 3.2cm width lies
  // TANGENTIALLY (across the seam) rather than diagonally, fits the gap
  // with room either side, verified against the real built chair geometry
  // in the "legs clear the nested chairs" test below. This is a documented
  // coupling assumption, not a hidden one: a caller who changes the
  // companion chair's backSweep or radius can reopen a collision, which is
  // exactly what the round-2 slider-guard fix (LOW) checks for on the spec
  // page.
  // A 6-degree seam (SEAM_ASSUMED_BACK_SWEEP=84) subtends only about 2 cm at
  // a 0.4 m radius, so a fully SQUARE 3.2cm leg leaves almost no angular
  // margin once its own corners are accounted for (round-2 code review found
  // it still clips chair1 by ~0.3deg at backSweep=84's exact 3deg half-gap).
  // The cross-section is therefore NARROWER across the seam (tangential,
  // `legWidthTangential`) than along it (radial, `legDepthRadial`) -- still
  // reads as a slim square leg from the front/side (the dominant viewing
  // angles), and gives a real angular margin verified in the "legs clear the
  // nested chairs" test below.
  const legWidthTangential = 0.020;
  const legDepthRadial = 0.032;
  // Leg TOP radius (under the tabletop) and FOOT radius (near the floor):
  // the top sits well inside the chairs' own arc radius (assumed 0.45m, the
  // DEFAULTS dining-chair radius) so it is genuinely "attached under the
  // top", and the foot lands close to the table's own rim -- "about the rim
  // line, not far past it" -- per the review's wording, both expressed as
  // fractions of THIS table's own radius `r` so a resized table scales
  // sensibly.
  const legTopRadius = r * 0.78;
  const legFootRadius = r * 0.97;
  const splayAngle = Math.atan2(legFootRadius - legTopRadius, h - topThickness); // radians, purely radial
  const legLen = Math.hypot(legFootRadius - legTopRadius, h - topThickness);

  // Local x = tangential (across the seam), local z = radial (along the
  // seam) -- matches the tiltAxis/radialDir frame each leg is placed in
  // below, so the NARROW dimension is always the one facing a neighbouring
  // chair.
  const legGeo = openBoxGeometry(THREE, legWidthTangential, legLen, legDepthRadial, 'y');
  legGeo.translate(0, -legLen / 2, 0); // pivot (0,0,0) is the TOP end of the leg
  // The 4 seam bisectors, in the table's OWN local frame (already offset by
  // +r in z per this module's convention -- see topGeo above): 45/135/225/
  // 315 degrees from the table's front (+z, i.e. the direction opposite the
  // dining.js back-at-z=0 convention), which is exactly where a seam
  // between chairs tucked at 0/90/180/270 sits, for ANY backSweep (each
  // chair's own sweep is centred on its own slot angle, so the midpoint
  // between two adjacent slots -- the seam -- never moves).
  const seamAngles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const legFeet = [];
  const legTops = [];
  seamAngles.forEach((theta, i) => {
    const leg = new THREE.Mesh(legGeo.clone(), legMat.clone());
    leg.name = 'leg' + i;
    // Orient the leg in two steps, composed as a single quaternion:
    //  1. Yaw about Y by `theta` so the leg's own local x (its NARROW,
    //     tangential dimension) points along the seam's tangent direction,
    //     and local z (its radial dimension) points along the seam's
    //     outward radial direction -- this is what actually makes the
    //     narrow face the one across the seam, rather than assuming a tilt
    //     about a world-space axis happens to line up with it.
    //  2. THEN tilt by `splayAngle` about the leg's OWN (now-yawed) local x
    //     axis, which is the seam's tangent direction -- so the splay
    //     swings the foot further out ALONG the radial line, never
    //     sideways into a neighbouring chair's territory.
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), theta);
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -splayAngle);
    leg.quaternion.copy(yaw).multiply(tilt);
    const radialDir = new THREE.Vector2(Math.sin(theta), Math.cos(theta));
    const top3 = new THREE.Vector3(radialDir.x * legTopRadius, h - topThickness, radialDir.y * legTopRadius + r);
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
  const vertSpan = h - topThickness;
  const frameY = Math.max(0.01, Math.min(p.frameHeight / 100, vertSpan - 0.02));
  const barThickness = 0.02;
  function crossbar(a, b, name) {
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const dir = new THREE.Vector3().subVectors(b, a);
    const lenFlat = Math.hypot(dir.x, dir.z);
    const barGeo = openBoxGeometry(THREE, lenFlat, barThickness, barThickness, 'x');
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
  // seamAngles = [45, 135, 225, 315] degrees -- index 0 and 2 are the true
  // diagonal opposite pair (45/225), as are 1 and 3 (135/315).
  crossbar(framePoints[0], framePoints[2], 'crossbarA'); // 45deg to 225deg
  crossbar(framePoints[1], framePoints[3], 'crossbarB'); // 135deg to 315deg

  // The splayed legs have a RECTANGULAR cross-section, so their tilted
  // corners (not just the centreline the trig above targets) drop a
  // fraction of a centimetre past y=0 -- solving that in closed form for an
  // arbitrary tilt axis is not worth it when a single measured correction
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
  // width/depth/height below are for backSweep=84 (see backSweep's own
  // comment) -- width = 2*radius*sin(84/2deg).
  width: 60.2,     // 2 * radius * sin(backSweep/2) at the DEFAULTS below
  depth: 45,       // == radius
  // Capped below the dining-table's own underside (its DEFAULTS.height 75
  // minus its 2.8cm top slab, with a 1cm clearance margin) -- when 4 of
  // these are tucked under a dining-table at DEFAULTS, the back's highest
  // point (at the centre, see backHeight's profile below) must not poke
  // into the tabletop (code review round 1, item 89769f2b: the back top
  // used to sit AT y=75, 2.8cm inside the table's underside at y=72.2).
  height: 71,
  radius: 45,          // cm, the arc's radius -- also this wedge's depth
  // 84 (not 90): a full 90-degree sweep rings the table with NO gap between
  // chairs, which leaves the table's own legs nowhere to go but through a
  // chair or past the rim (round-2 visual review, item 89769f2b). Trimming
  // to 84 opens a 6-degree gap centred on each of the 4 seams between
  // tucked chairs (the seam is ALWAYS centred there, at 45/135/225/315
  // degrees, independent of the exact backSweep -- see dining-table's own
  // leg-placement comment) -- wide enough for that table's legs to run
  // through, verified in the "legs clear the nested chairs" test.
  backSweep: 84,
  // Photo proportions (round-2 visual review, LOW): the black band (seat
  // underside to back peak) should read as roughly a third of the table
  // height, not a fifth. 46cm (down from 52) moves toward that -- lowering
  // it further to hit the full ~35cm band would need seatHeight ~40cm,
  // outside the 50-55cm the reference photos read, so 46 is the balance
  // point: as close to the ~35cm band as the table-clearance ceiling and
  // the photos' own seat-height range both allow at once. See the
  // perf-audit/likeness note in the back-shell build for the exact numbers.
  seatHeight: 46,
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
  // the eventual cylinder. TALLEST at the centre back, tapering down toward
  // the sides (code review round 1, item 89769f2b, fix #6 -- the photo shows
  // this profile, not a constant height). The peak is capped so the back's
  // highest point stays under a DEFAULTS dining-table's underside with a 1cm
  // margin when 4 of these are tucked underneath it (see CHAIR_DEFAULTS
  // .height's own comment) -- `h` (this build's declared height) IS that
  // peak, so a caller who raises `height` raises the peak, and the profile
  // still tapers down proportionally toward the sides.
  const backThickness = 0.025;
  const innerR = radius - backThickness;
  const backSegs = detail ? 6 : 16;
  const peakHeight = Math.max(0.01, h - seatH);
  const sideHeight = peakHeight * 0.65; // tapered, never to zero -- still one continuous shell
  function heightAt(theta) {
    // 1 at the centre (theta=0), 0 at the sweep edges -- a half-cosine taper.
    const frac = Math.cos((theta / (sweep / 2)) * (Math.PI / 2));
    return sideHeight + (peakHeight - sideHeight) * frac;
  }

  // CylinderGeometry's own local frame sweeps theta -> (x=r*sin(theta),
  // z=r*cos(theta)); to match the seat shape's x=r*sin(a), z=r-r*cos(a)
  // convention (back-centre a=0 at world z=0, curving forward to +z), that
  // needs the z axis MIRRORED -- which is also what flipped the winding in
  // round 1 (geo.scale(1,1,-1) mirrors the geometry, so the triangle winding
  // no longer matches the outward-pointing normal attribute, and the shell
  // was invisible from outside / lit from inside). This custom ruled-surface
  // build sidesteps a stock CylinderGeometry (which also cannot vary its own
  // height per-angle) and lays out the winding correctly from the start:
  // both rings are wound the SAME way seen from OUTSIDE the arc (increasing
  // theta), and each quad's two triangles keep that same outward winding.
  //
  // @param sign +1 for the outer shell (front face read from outside, at
  //   `radius`), -1 for the inner shell (front face read from INSIDE the
  //   shell -- i.e. its own outside -- at `radius - backThickness`, so its
  //   winding is the mirror of the outer one).
  function backShell(rad, sign, name) {
    const segs = backSegs;
    const positions = [];
    const indices = [];
    for (let i = 0; i <= segs; i++) {
      const theta = -sweep / 2 + (i / segs) * sweep;
      const x = rad * Math.sin(theta);
      // z is measured from the APEX (0, *, radius) using the TRUE radius,
      // not this shell's own `rad` -- round-2 code review, item 89769f2b:
      // using `rad` here (the shell's own radius) put both shells' rings on
      // circles centred on their OWN radius, which coincide at theta=0 (zero
      // thickness at the back centre) and diverge only through the sin/cos
      // curvature, not by a uniform inset. Using `radius` for every shell's
      // z-offset makes both rings concentric circles of radius `rad` CENTRED
      // ON THE SAME APEX POINT, which is what gives a uniform backThickness
      // gap between them at every angle (verified in the thickness test).
      const z = radius - rad * Math.cos(theta);
      const bottomY = seatH;
      const topY = seatH + heightAt(theta);
      positions.push(x, bottomY, z, x, topY, z); // 2 verts per column: bottom, top
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3; // a,c bottom; b,d top
      if (sign > 0) {
        // Outward normal points AWAY from the apex (0,*,radius) -- for the
        // OUTER shell that is away from the wedge's own centre, i.e. the
        // winding that reads front-facing from outside the arc.
        indices.push(a, b, c, b, d, c);
      } else {
        // Inner shell: its visible ("outside") face is the concave side,
        // facing the apex -- the mirror winding of the outer shell.
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
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
  // Both shells centred on the SAME arc convention (radius from the apex),
  // so the inner shell is a uniform `backThickness` inset from the outer one
  // everywhere, including at the back centre (round 1 fix #4 -- it used to
  // be centred on its own radius, giving zero thickness at the centre).
  backGroup.add(backShell(radius, 1, 'backOuter'), backShell(innerR, -1, 'backInner'));
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
