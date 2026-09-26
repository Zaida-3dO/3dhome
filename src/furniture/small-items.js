/**
 * small-items.js - MULTI-TYPE module for the many small wall/floor fittings
 * across rooms: TVs, photo frames, speakers (wall,
 * floor-standing, ceiling and centre-channel), a subwoofer, a tube floor
 * lamp, a coat rack, mirrors, floating shelves (incl. a back-panel L-section
 * preset), monitors, a PC tower and a wire wall shelf. Also builds `clock`
 * and `wall-art`, pre-seeded in registry.js against this module by an
 * earlier plan revision but not part of this item's own type list -- kept
 * minimal so the shared contract gate stays green for anyone using this
 * file.
 *
 * THE BUILDER CONTRACT (every src/furniture/<type>.js follows it):
 *   - Pure ESM, THREE injected; no `import 'three'`.
 *   - Exports TYPE, DEFAULTS (frozen, cm, includes width/depth/height) and
 *     build(THREE, params, { detail: 'full' | 'low' }) -> THREE.Group, per
 *     type, gathered under `export const TYPES = { '<type>': {...}, ... }`.
 *   - Local frame in METRES: y = 0 is the item's bottom, x is centred along
 *     the width, the BACK face is at z = 0 and the front faces +z.
 *   - Every material comes from makeFinish() (./finishes.js).
 * See docs/house-profile.md, "Furniture" / "Multi-type modules".
 *
 * PRIVACY: generic names and defaults only. No real model names, no real
 * images, no real room measurements -- those live only in a private house's
 * furniture[].params, never here.
 */
import { makeFinish, isKeptFinish } from './finishes.js';

const CM = 0.01;

/** width/depth/height (cm) -> metres, and a couple of small shared helpers. */
function m(v) { return v * CM; }
function box(THREE, w, d, h, mat, cx, cy, cz) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(cx || 0, cy || 0, cz || 0);
  return new THREE.Mesh(geo, mat);
}
function tagKeep(mesh) {
  if (isKeptFinish(mesh.material.userData.finish)) mesh.userData.keep = true;
  return mesh;
}
function group(name) {
  const g = new (this)();
  g.name = name;
  return g;
}

// ============================================================================
// tv - a wall TV. Two bezel styles:
//   'thin'         a plain flat panel with a thin black bezel (the common
//                  case), optionally on a central pedestal stand instead of
//                  wall-mounted.
//   'picture-frame' a wooden picture-frame bezel (Frame-TV look), wall-hung,
//                  with an optional "art mode" image.
// Generic defaults only -- real model dimensions (when a research note
// supplies them) belong in a private house's furniture[].params, never here.
// ============================================================================
const TV_DEFAULTS = Object.freeze({
  // A generic large flat-panel TV's real-world footprint (large-format
  // consumer TV, mid-2020s), from a research note -- no model name kept
  // here or anywhere in this repo, per the privacy rule.
  width: 167.1,
  height: 95.9,
  depth: 5.4,
  color: '#111111',
  finish: 'matte',
  bezelStyle: 'thin', // 'thin' | 'picture-frame'
  frameColor: '#8a6a4a',
  frameWidth: 4,
  screenColor: '#1a2733',
  // 'thin' style only: a central pedestal stand instead of wall-mounting.
  stand: false,
  standHeight: 10,
  standWidth: 42,
  standDepth: 31.7,
  // Optional "art mode" image, a URL relative to the HOUSE dir. Plain colour
  // by default -- texture loading is optional and injectable (no DOM needed
  // in Node).
  image: null
});

function buildTv(THREE, params, opts) {
  const p = Object.assign({}, TV_DEFAULTS, params || {});
  const o = opts || {};
  const w = m(p.width), h = m(p.height), d = m(p.depth);
  const g = new THREE.Group();
  g.name = 'furniture:tv';
  const pictureFrame = p.bezelStyle === 'picture-frame';

  let panelBottom = 0;
  if (!pictureFrame && p.stand) {
    const standMat = makeFinish(THREE, 'matte', '#1c1c1c');
    const standH = m(p.standHeight);
    const baseW = m(p.standWidth), baseD = m(p.standDepth);
    // A slim neck plus a low wide foot, both centred under the panel.
    const neckW = Math.min(0.05, baseW * 0.15);
    g.add(box(THREE, neckW, Math.min(baseD, d * 3), standH, standMat, 0, standH / 2, Math.min(baseD, d * 3) / 2));
    const footH = Math.min(standH * 0.25, 0.02);
    g.add(box(THREE, baseW, baseD, footH, standMat, 0, footH / 2, baseD / 2));
    panelBottom = standH;
  }

  const bodyMat = makeFinish(THREE, p.finish, p.color);
  const body = box(THREE, w, d, h, bodyMat, 0, panelBottom + h / 2, d / 2);
  g.add(body);

  const screenMat = makeFinish(THREE, 'emissive', p.screenColor);
  // A thin bezel in both styles; the picture-frame style additionally gets
  // the thicker wooden surround built below. The screen sits flush with the
  // panel's own front face (z = d), not proud of it, so the group's overall
  // depth stays exactly `depth`.
  const thinBezel = Math.min(0.012, w * 0.012);
  const screenDepth = Math.min(Math.max(d * 0.3, 0.005), d * 0.5);
  const screen = box(THREE, w - thinBezel * 2, screenDepth, h - thinBezel * 2, screenMat,
    0, panelBottom + h / 2, d - screenDepth / 2);
  screen.userData.keep = true;
  g.add(screen);

  if (pictureFrame) {
    // A thin wooden picture-frame bezel around the whole panel (Frame-TV
    // look). Four slim bars, `full` detail only -- `low` collapses to a
    // single ring-ish box behind the screen plane, well under `full`'s tri
    // count.
    const frameMat = makeFinish(THREE, 'matte', p.frameColor);
    const fw = m(p.frameWidth);
    if (o.detail !== 'low') {
      // box(THREE, width, depth, height, ...) -- depth is always `d` (the
      // panel's own depth), never the bar's in-plane extent.
      const top = box(THREE, w, d, fw, frameMat, 0, h - fw / 2, d / 2);
      const bottom = box(THREE, w, d, fw, frameMat, 0, fw / 2, d / 2);
      const left = box(THREE, fw, d, h - fw * 2, frameMat, -w / 2 + fw / 2, h / 2, d / 2);
      const right = box(THREE, fw, d, h - fw * 2, frameMat, w / 2 - fw / 2, h / 2, d / 2);
      g.add(top, bottom, left, right);
    } else {
      const ring = box(THREE, w, h, d * 0.6, frameMat, 0, h / 2, d * 0.3);
      g.add(ring);
    }
  }
  return g;
}

// ============================================================================
// photo-frame - 1..N panels of picture-frame artwork
// ============================================================================
const PHOTO_FRAME_DEFAULTS = Object.freeze({
  width: 60,
  height: 50,
  depth: 3,
  panels: 1,
  gap: 2,
  frameColor: '#3a3a3a',
  frameWidth: 3,
  color: '#e7e2d6',
  finish: 'matte',
  // Relative to the HOUSE dir; a plain colour panel when omitted. Never
  // loaded in Node -- injectable so the contract test never touches a DOM.
  image: null
});

function buildPhotoFrame(THREE, params, opts) {
  // `params.textureLoader`, if given, is `(url) -> THREE.Texture`, an
  // injection point so texture loading stays optional and DOM-free -- a
  // build-time hook, not a dimension or style, so it is deliberately NOT in
  // DEFAULTS (which the schema's furnitureParams_photo-frame block mirrors
  // 1:1 for the drift test) and is not itself a serialisable param.
  const p = Object.assign({}, PHOTO_FRAME_DEFAULTS, params || {});
  const n = Math.max(1, Math.round(p.panels));
  const totalW = m(p.width), h = m(p.height), d = m(p.depth);
  const gap = m(p.gap);
  const panelW = (totalW - gap * (n - 1)) / n;
  const g = new THREE.Group();
  g.name = 'furniture:photo-frame';

  const frameMat = makeFinish(THREE, 'matte', p.frameColor);
  const fw = m(p.frameWidth);
  // A DOM-free, injectable texture: only used if a caller (the live scene or
  // a spec page) provides `textureLoader(url) -> THREE.Texture`. The
  // contract test never sets this, so builds stay pure in Node.
  let tex = null;
  if (p.image && typeof p.textureLoader === 'function') {
    try { tex = p.textureLoader(p.image); } catch (e) { tex = null; }
  }
  const panelMat = tex
    ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 })
    : makeFinish(THREE, p.finish, p.color);
  if (!tex) panelMat.userData.finish = p.finish;

  // The face panel sits flush with the frame's own front face (z = d), not
  // proud of it, so the group's overall depth stays exactly `depth`.
  const panelDepth = Math.min(Math.max(d * 0.3, 0.004), d * 0.5);
  for (let i = 0; i < n; i++) {
    const cx = -totalW / 2 + panelW / 2 + i * (panelW + gap);
    const frame = box(THREE, panelW, d, h, frameMat, cx, h / 2, d / 2);
    g.add(frame);
    const innerW = Math.max(panelW - fw * 2, 0.01);
    const innerH = Math.max(h - fw * 2, 0.01);
    const panel = box(THREE, innerW, panelDepth, innerH, panelMat, cx, h / 2, d - panelDepth / 2);
    if (tex) panel.userData.keep = true;
    else panel.userData.finish = p.finish;
    g.add(panel);
  }
  return g;
}

// ============================================================================
// speaker - four kinds, selected by `kind`:
//   'wall-trapezoid' (default)  a wall speaker, trapezoid plan (back wide,
//                               front narrow); `boxShape: true` swaps the
//                               trapezoid for a plain box at the same size.
//   'floor-standing'            a tall white column on a small plinth.
//   'ceiling'                   a small box/pod for a ceiling mount (Dolby
//                               Atmos style) -- see the placement note below.
//   'centre'                    a low wide box for a console.
//
// Every kind still follows the shared frame: y=0 is the item's bottom,
// back at z=0, front at +z, x centred -- INCLUDING 'ceiling'. A ceiling
// speaker's "back" is the ceiling it mounts to, so place it as an ordinary
// wall-anchored item on the room's ceiling-height "wall" band, or as a free
// item with `elevation` set to the ceiling height minus its own height and
// `rotation: 180` if it should point down/into the room; this module draws
// the geometry only and takes no position of its own.
// ============================================================================
const SPEAKER_DEFAULTS = Object.freeze({
  // `width` is the OVERALL (widest) footprint width, per the shared bbox
  // contract -- for the trapezoid that is the BACK edge. `frontWidth` is the
  // narrower front edge.
  width: 29,
  height: 28,
  depth: 10,
  frontWidth: 16,
  color: '#f2f2f2',
  finish: 'matte',
  kind: 'wall-trapezoid', // 'wall-trapezoid' | 'floor-standing' | 'ceiling' | 'centre'
  boxShape: false,         // wall-trapezoid only: swap the trapezoid for a box
  // floor-standing only. Real reference (a real household's own measurement): a
  // 16.5 x 24 x 90 cabinet on a small outrigger plinth; set width/depth/
  // height to those for that preset, and plinthWidth/plinthDepth to a size
  // a little larger than the cabinet. midDrivers is 2 or 3 bass/mid discs
  // below a top tweeter.
  plinthWidth: 22,
  plinthDepth: 30,
  midDrivers: 2,
  // centre only. Real reference: 45 x 20 x 16.5, two ~13cm mid discs either
  // side of a 2.5cm tweeter.
  midDriverDiameter: 13,
  tweeterDiameter: 2.5,
  // ceiling only. Real reference: ~18.5 x 18.5 x 31, driver face documented
  // by `firing`: 'down' (flush ceiling mount, fires into the room below),
  // 'angled' (front face, tilted across the room) or 'up' (default: away
  // from the room -- rare, kept only so an unset firing still builds).
  firing: 'down'
});

function buildSpeakerCone(THREE, mat, radius, cx, cy, cz) {
  const cone = new THREE.Mesh(new THREE.CircleGeometry(radius, 16), mat);
  cone.position.set(cx, cy, cz);
  return cone;
}

function buildSpeakerWallTrapezoid(THREE, p, opts) {
  const g = new THREE.Group();
  const mat = makeFinish(THREE, p.finish, p.color);
  const h = m(p.height), d = m(p.depth);
  const backW = m(p.width);
  const frontW = m(Math.min(p.frontWidth, p.width));

  if (p.boxShape) {
    g.add(box(THREE, backW, d, h, mat, 0, h / 2, d / 2));
  } else {
    // Trapezoid in plan: back (z=0) is `width` wide (the widest edge, per
    // the bbox contract), front (z=d) is the narrower `frontWidth`.
    const shape = new THREE.Shape();
    shape.moveTo(-backW / 2, 0);
    shape.lineTo(backW / 2, 0);
    shape.lineTo(frontW / 2, d);
    shape.lineTo(-frontW / 2, d);
    shape.lineTo(-backW / 2, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
    // ExtrudeGeometry extrudes the shape's local XY plane (x, plan-depth)
    // along +Z (world height) by `depth` (here, `h`). Rotating -90 about X
    // maps shape-Y (plan depth, currently 0..d) to world -Z (so it lands on
    // -d..0) and the extrude axis (world Z pre-rotation) to world Y (0..h).
    // Translate +d along Z afterward so the plan depth lands on 0..d, matching
    // the shared frame (back at z=0, front at z=d).
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, d);
    g.add(new THREE.Mesh(geo, mat));
  }
  if (opts && opts.detail !== 'low') {
    const coneMat = makeFinish(THREE, 'matte', '#222222');
    const coneR = Math.min(frontW, h) * 0.32;
    g.add(buildSpeakerCone(THREE, coneMat, coneR, 0, h / 2, d - 0.001));
  }
  return g;
}

function buildSpeakerFloorStanding(THREE, p, opts) {
  // A slim tower on an outrigger plinth. Real reference (a real household's own
  // measurement): a 16.5 x 24 x 90 cabinet on a plinth that spreads a
  // little wider than the cabinet itself for stability -- generic
  // dimensions only, no brand kept anywhere. The plinth's outrigger
  // footprint is clamped to the declared width/depth so the group's own
  // bbox still equals width x depth x height exactly; params.plinthWidth/
  // plinthDepth may ask for more, in which case they are capped rather
  // than overflowing the contract.
  const g = new THREE.Group();
  const mat = makeFinish(THREE, p.finish, p.color);
  const w = m(p.width), d = m(p.depth), h = m(p.height);
  const plinthH = Math.min(h * 0.05, 0.03);
  const plinthMat = makeFinish(THREE, 'matte', '#1c1c1c');
  const plinthW = Math.min(m(p.plinthWidth), w);
  const plinthD = Math.min(m(p.plinthDepth), d);
  g.add(box(THREE, plinthW, plinthD, plinthH, plinthMat, 0, plinthH / 2, plinthD / 2));
  g.add(box(THREE, w, d, h - plinthH, mat, 0, plinthH + (h - plinthH) / 2, d / 2));
  if (opts && opts.detail !== 'low') {
    // Tweeter at the top, 2-3 bass/mid discs below it.
    const coneMat = makeFinish(THREE, 'matte', '#181818');
    const tweeterMat = makeFinish(THREE, 'matte', '#333333');
    const cabinetH = h - plinthH;
    const midCount = Math.max(2, Math.min(3, Math.round(p.midDrivers)));
    const tweeterY = plinthH + cabinetH * 0.9;
    g.add(buildSpeakerCone(THREE, tweeterMat, Math.min(w, h) * 0.12, 0, tweeterY, d - 0.001));
    for (let i = 0; i < midCount; i++) {
      const cy = plinthH + cabinetH * (0.15 + 0.55 * (i / Math.max(1, midCount - 1)));
      g.add(buildSpeakerCone(THREE, coneMat, Math.min(w, h / (midCount + 1)) * 0.4, 0, cy, d - 0.001));
    }
  }
  return g;
}

function buildSpeakerCeiling(THREE, p, opts) {
  // Geometry only: a compact box with an angled or down-firing driver face
  // (Dolby-Atmos style). No placement of its own -- see the DEFAULTS-block
  // note: mount it as a wall-anchored item on the ceiling band, or as a
  // free item with `elevation` at ceiling height minus its own height.
  // `firing` documents which face carries the driver, for the placer:
  //   'down'   the driver is on the BOTTOM (y = 0) -- a flush ceiling mount
  //            firing straight down into the room; the common Atmos case.
  //   'angled' the driver is on the FRONT face (z = depth), tilted -- a
  //            speaker mounted near the ceiling but firing across the room.
  //   'up'     the driver is on TOP (y = height) -- rare, kept only so an
  //            unrecognised or unset `firing` still builds something.
  const g = new THREE.Group();
  const mat = makeFinish(THREE, p.finish, p.color);
  const w = m(p.width), d = m(p.depth), h = m(p.height);
  g.add(box(THREE, w, d, h, mat, 0, h / 2, d / 2));
  if (!(opts && opts.detail === 'low')) {
    const driverMat = makeFinish(THREE, 'matte', '#181818');
    const r = Math.min(w, d) * 0.32;
    if (p.firing === 'down') {
      const driver = buildSpeakerCone(THREE, driverMat, r, 0, 0.001, d / 2);
      driver.rotation.x = Math.PI / 2;
      g.add(driver);
    } else if (p.firing === 'angled') {
      const driver = buildSpeakerCone(THREE, driverMat, r, 0, h * 0.7, d - 0.001);
      g.add(driver);
    } else {
      const driver = buildSpeakerCone(THREE, driverMat, r, 0, h - 0.001, d / 2);
      driver.rotation.x = -Math.PI / 2;
      g.add(driver);
    }
  }
  return g;
}

function buildSpeakerCentre(THREE, p, opts) {
  // A low wide console speaker: mid, tweeter, mid across the front.
  const g = new THREE.Group();
  const mat = makeFinish(THREE, p.finish, p.color);
  const w = m(p.width), d = m(p.depth), h = m(p.height);
  g.add(box(THREE, w, d, h, mat, 0, h / 2, d / 2));
  if (opts && opts.detail !== 'low') {
    const midMat = makeFinish(THREE, 'matte', '#222222');
    const tweeterMat = makeFinish(THREE, 'matte', '#333333');
    const midR = m(p.midDriverDiameter) / 2;
    const tweeterR = m(p.tweeterDiameter) / 2;
    const gap = w * 0.24;
    g.add(buildSpeakerCone(THREE, midMat, midR, -gap, h / 2, d - 0.001));
    g.add(buildSpeakerCone(THREE, tweeterMat, tweeterR, 0, h / 2, d - 0.001));
    g.add(buildSpeakerCone(THREE, midMat, midR, gap, h / 2, d - 0.001));
  }
  return g;
}

function buildSpeaker(THREE, params, opts) {
  const p = Object.assign({}, SPEAKER_DEFAULTS, params || {});
  const g = new THREE.Group();
  g.name = 'furniture:speaker';
  let inner;
  if (p.kind === 'floor-standing') inner = buildSpeakerFloorStanding(THREE, p, opts);
  else if (p.kind === 'ceiling') inner = buildSpeakerCeiling(THREE, p, opts);
  else if (p.kind === 'centre') inner = buildSpeakerCentre(THREE, p, opts);
  else inner = buildSpeakerWallTrapezoid(THREE, p, opts);
  g.add(inner);
  return g;
}

// ============================================================================
// subwoofer - a simple cube, white
// ============================================================================
const SUBWOOFER_DEFAULTS = Object.freeze({
  width: 35,
  height: 35,
  depth: 35,
  color: '#f2f2f2',
  finish: 'matte'
});

function buildSubwoofer(THREE, params) {
  const p = Object.assign({}, SUBWOOFER_DEFAULTS, params || {});
  const mat = makeFinish(THREE, p.finish, p.color);
  const g = new THREE.Group();
  g.name = 'furniture:subwoofer';
  g.add(box(THREE, m(p.width), m(p.depth), m(p.height), mat, 0, m(p.height) / 2, m(p.depth) / 2));
  return g;
}

// ============================================================================
// tube-floor-lamp - a thin emissive light tube rising from a small base
// ============================================================================
const TUBE_FLOOR_LAMP_DEFAULTS = Object.freeze({
  // width/depth are the OVERALL footprint, per the shared bbox contract --
  // here that is the base (the widest part), not the thin tube above it.
  width: 20,
  depth: 20,
  height: 150,
  baseHeight: 20,
  tubeDiameter: 4,
  color: '#e8f4ff',
  finish: 'emissive',
  baseColor: '#e8e8e8',
  baseFinish: 'matte',
  oneSidedGlow: false
});

function buildTubeFloorLamp(THREE, params, opts) {
  const p = Object.assign({}, TUBE_FLOOR_LAMP_DEFAULTS, params || {});
  const g = new THREE.Group();
  g.name = 'furniture:tube-floor-lamp';

  const baseMat = makeFinish(THREE, p.baseFinish, p.baseColor);
  const baseH = m(p.baseHeight);
  const baseR = Math.min(m(p.width), m(p.depth)) / 2;
  const segs = opts && opts.detail === 'low' ? 8 : 24;
  const baseGeo = new THREE.CylinderGeometry(baseR, baseR, baseH, segs);
  baseGeo.translate(0, baseH / 2, baseR);
  const base = new THREE.Mesh(baseGeo, baseMat);
  g.add(base);

  const tubeMat = makeFinish(THREE, p.finish, p.color);
  const tubeH = m(p.height) - baseH;
  const tubeR = m(p.tubeDiameter) / 2;
  // A one-sided glow: a thin half-cylinder-ish tube (an open arc) rather
  // than a full cylinder, so the tube reads as glowing from one side only.
  // Still emissive/keep either way, per the contract.
  let tubeGeo;
  if (p.oneSidedGlow) {
    tubeGeo = new THREE.CylinderGeometry(tubeR, tubeR, tubeH, segs, 1, true, 0, Math.PI);
  } else {
    tubeGeo = new THREE.CylinderGeometry(tubeR, tubeR, tubeH, segs);
  }
  // Centred over the base's own centre (z = baseR), not at z = tubeR, so
  // the thin tube sits above the middle of the base rather than at its
  // own tiny footprint's back edge.
  tubeGeo.translate(0, baseH + tubeH / 2, baseR);
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.userData.keep = true;
  g.add(tube);
  return g;
}

// ============================================================================
// coat-rack - a wall hook rail with 0-3 simple draped coats
// ============================================================================
const COAT_RACK_DEFAULTS = Object.freeze({
  width: 80,
  height: 10,
  depth: 6,
  color: '#6b5a45',
  finish: 'matte',
  coats: 0,
  coatColors: Object.freeze(['#3a3f4a', '#7a2e2e', '#2e4a3a']),
  coatHeight: 55
});

function buildCoatRack(THREE, params, opts) {
  const p = Object.assign({}, COAT_RACK_DEFAULTS, params || {});
  const coats = Math.max(0, Math.min(3, Math.round(p.coats)));
  const w = m(p.width), h = m(p.height), d = m(p.depth);
  const g = new THREE.Group();
  g.name = 'furniture:coat-rack';

  const railMat = makeFinish(THREE, p.finish, p.color);
  g.add(box(THREE, w, d, h, railMat, 0, h / 2, d / 2));

  // Hook knobs, evenly spaced.
  const hookMat = makeFinish(THREE, 'metal', '#888888');
  const hookCount = Math.max(coats, 3);
  const hookR = Math.min(0.012, w / (hookCount * 6));
  const segs = opts && opts.detail === 'low' ? 6 : 12;
  for (let i = 0; i < hookCount; i++) {
    const cx = -w / 2 + w * (i + 0.5) / hookCount;
    const geo = new THREE.SphereGeometry(hookR, segs, Math.max(4, segs / 2));
    // Flush with the rail's own front face (z = d), not proud of it, so the
    // group's overall depth stays exactly `depth`.
    geo.translate(cx, h / 2, d - hookR);
    g.add(new THREE.Mesh(geo, hookMat));
  }

  // Simple draped coats: a rounded box "body" hanging below the rail.
  const coatH = m(p.coatHeight);
  for (let i = 0; i < coats; i++) {
    const cx = -w / 2 + w * (i + 0.5) / hookCount;
    const color = p.coatColors[i % p.coatColors.length];
    const coatMat = makeFinish(THREE, 'matte', color);
    const coatW = Math.min(0.22, w / hookCount * 0.8);
    const coatD = d * 1.3;
    const geo = new THREE.BoxGeometry(coatW, coatH, coatD);
    geo.translate(cx, h - coatH / 2, coatD / 2);
    g.add(new THREE.Mesh(geo, coatMat));
  }
  return g;
}

// ============================================================================
// mirror - round, rect, pebble or triangle, with a frame
// ============================================================================
const MIRROR_DEFAULTS = Object.freeze({
  width: 60,
  height: 80,
  depth: 3,
  shape: 'rect', // 'round' | 'rect' | 'pebble' | 'triangle'
  frameColor: '#3a3a3a',
  frameWidth: 2.5,
  frameFinish: 'matte'
});

function pebbleShape(THREE, w, h) {
  // A soft asymmetric "pebble" outline: an ellipse-like closed curve built
  // from a handful of control points via a smooth spline, cheap in
  // triangles and clearly not a plain round/rect. The spline can overshoot
  // its control points between them, so the raw curve is rescaled to fit
  // EXACTLY within [-w/2, w/2] x [-h/2, h/2] afterward -- required by the
  // shared bbox contract (width/height must equal the params within 0.5cm).
  const rx = w / 2, ry = h / 2;
  const pts = [];
  const lobes = 7;
  for (let i = 0; i <= lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    const wobble = 1 + 0.08 * Math.sin(a * 3);
    pts.push(new THREE.Vector2(Math.cos(a) * rx * wobble, Math.sin(a) * ry * wobble));
  }
  const curve = new THREE.SplineCurve(pts);
  const raw = curve.getPoints(48);
  const minX = Math.min(...raw.map(p => p.x)), maxX = Math.max(...raw.map(p => p.x));
  const minY = Math.min(...raw.map(p => p.y)), maxY = Math.max(...raw.map(p => p.y));
  const sx = (2 * rx) / (maxX - minX), sy = (2 * ry) / (maxY - minY);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const fitted = raw.map(p => new THREE.Vector2((p.x - cx) * sx, (p.y - cy) * sy));
  const shape = new THREE.Shape(fitted);
  return shape;
}

function mirrorPlanShape(THREE, shapeKind, w, h) {
  const shape = new THREE.Shape();
  if (shapeKind === 'round') {
    shape.absellipse(0, 0, w / 2, h / 2, 0, Math.PI * 2, false, 0);
  } else if (shapeKind === 'triangle') {
    shape.moveTo(0, h / 2);
    shape.lineTo(w / 2, -h / 2);
    shape.lineTo(-w / 2, -h / 2);
    shape.lineTo(0, h / 2);
  } else if (shapeKind === 'pebble') {
    return pebbleShape(THREE, w, h);
  } else {
    shape.moveTo(-w / 2, -h / 2);
    shape.lineTo(w / 2, -h / 2);
    shape.lineTo(w / 2, h / 2);
    shape.lineTo(-w / 2, h / 2);
    shape.lineTo(-w / 2, -h / 2);
  }
  return shape;
}

function buildMirror(THREE, params, opts) {
  const p = Object.assign({}, MIRROR_DEFAULTS, params || {});
  const w = m(p.width), h = m(p.height), d = m(p.depth);
  const fw = m(p.frameWidth);
  const g = new THREE.Group();
  g.name = 'furniture:mirror';
  const segs = opts && opts.detail === 'low' ? 1 : 1;

  const frameMat = makeFinish(THREE, p.frameFinish, p.frameColor);
  const outerShape = mirrorPlanShape(THREE, p.shape, w, h);
  const frameGeo = new THREE.ExtrudeGeometry(outerShape, { depth: d, bevelEnabled: false, curveSegments: opts && opts.detail === 'low' ? 8 : 24 });
  frameGeo.rotateX(0); // shape is already in the x/y (width/height) plane
  // The extrude axis is +Z here, which is our world depth axis already
  // (shape x -> width, shape y -> height, extrude -> depth). No rotation
  // needed; just recentre so the back sits at z=0 and the shape is centred
  // vertically at h/2 (shape is currently centred at y=0).
  frameGeo.translate(0, h / 2, 0);
  const frameMesh = new THREE.Mesh(frameGeo, frameMat);
  g.add(frameMesh);

  // Mirror glass: a slightly inset, slightly thinner copy of the same
  // outline, sitting just in front of the frame's face.
  const innerShape = mirrorPlanShape(THREE, p.shape, Math.max(w - fw * 2, 0.02), Math.max(h - fw * 2, 0.02));
  const glassMat = makeFinish(THREE, 'mirror', '#d8dadc');
  const glassGeo = new THREE.ExtrudeGeometry(innerShape, { depth: Math.max(d * 0.2, 0.005), bevelEnabled: false, curveSegments: opts && opts.detail === 'low' ? 8 : 24 });
  glassGeo.translate(0, h / 2, d - Math.max(d * 0.2, 0.005));
  const glassMesh = new THREE.Mesh(glassGeo, glassMat);
  glassMesh.userData.keep = true;
  g.add(glassMesh);

  return g;
}

// ============================================================================
// shelf - a floating shelf. Three independent options:
//   led        an emissive LED edge strip (adds no light source).
//   levels     explicit vertical gaps (cm) between STACKED shelves, e.g.
//              [30, 30] for a 3-shelf set. Empty/absent = a single shelf.
//   backPanel  an L-section "floating shelf with back panel": a vertical
//              panel of its own colour against the wall (z=0) plus the
//              horizontal shelf slab in front of it. `height` here is the
//              OVERALL height (back panel top to shelf underside included),
//              and the group's own bbox still equals width/depth/height
//              exactly. Real reference: 180w x ~22d x ~20h overall, a white
//              ~20h back panel and an oak shelf slab -- generic defaults
//              only, no brand kept anywhere.
// levels and backPanel are independent: a stacked set may or may not have
// a back panel on the bottom unit; a single shelf may or may not either.
// ============================================================================
const SHELF_DEFAULTS = Object.freeze({
  width: 80,
  depth: 20,
  height: 5,
  color: '#e7e2d6',
  finish: 'matte',
  led: false,
  ledColor: '#eaf6ff',
  levels: Object.freeze([]),
  backPanel: false,
  backPanelHeight: 20,
  backPanelColor: '#f4f2ec',
  shelfColor: '#8a6a45'
});

function buildOneShelf(THREE, w, d, thickness, color, finish, led, ledColor, detail) {
  const g = new THREE.Group();
  const mat = makeFinish(THREE, finish, color);
  g.add(box(THREE, w, d, thickness, mat, 0, thickness / 2, d / 2));
  if (led) {
    // Flush with the slab's own front edge (z = d), not proud of it, so the
    // group's overall depth stays exactly `depth`.
    const stripDepth = detail === 'low' ? Math.max(thickness * 0.15, 0.003) : Math.max(thickness * 0.15, 0.003);
    const ledMat = makeFinish(THREE, 'emissive', ledColor);
    const strip = box(THREE, w * 0.96, stripDepth, Math.max(thickness * 0.4, 0.004),
      ledMat, 0, thickness * 0.08, d - stripDepth / 2);
    strip.userData.keep = true;
    g.add(strip);
  }
  return g;
}

/** The L-section: a vertical back panel plus a horizontal oak-style shelf,
 * built to fit exactly within width x depth x height. The shelf slab sits
 * at the TOP of the declared height (things sit on it), the back panel
 * rises the full backPanelHeight from y=0 against the wall. */
function buildShelfWithBackPanel(THREE, w, d, totalH, shelfThickness, p, detail) {
  const g = new THREE.Group();
  const backH = Math.min(m(p.backPanelHeight), totalH);
  const backMat = makeFinish(THREE, 'matte', p.backPanelColor);
  const backThickness = Math.min(0.02, d * 0.15);
  g.add(box(THREE, w, backThickness, backH, backMat, 0, backH / 2, backThickness / 2));

  const shelfMat = makeFinish(THREE, p.finish, p.shelfColor);
  const shelfY = Math.max(totalH - shelfThickness, backThickness);
  g.add(box(THREE, w, d, shelfThickness, shelfMat, 0, shelfY + shelfThickness / 2, d / 2));

  if (p.led) {
    const stripDepth = Math.max(shelfThickness * 0.15, 0.003);
    const ledMat = makeFinish(THREE, 'emissive', p.ledColor);
    const strip = box(THREE, w * 0.96, stripDepth, Math.max(shelfThickness * 0.4, 0.004),
      ledMat, 0, shelfY + shelfThickness * 0.08, d - stripDepth / 2);
    strip.userData.keep = true;
    g.add(strip);
  }
  return g;
}

function buildShelf(THREE, params, opts) {
  const p = Object.assign({}, SHELF_DEFAULTS, params || {});
  const w = m(p.width), d = m(p.depth), thickness = m(p.height);
  const g = new THREE.Group();
  g.name = 'furniture:shelf';
  const detail = opts && opts.detail;
  const levels = Array.isArray(p.levels) ? p.levels : [];

  if (levels.length === 0) {
    const one = p.backPanel
      ? buildShelfWithBackPanel(THREE, w, d, thickness, Math.min(thickness, m(5)), p, detail)
      : buildOneShelf(THREE, w, d, thickness, p.color, p.finish, p.led, p.ledColor, detail);
    g.add(one);
    return g;
  }

  // A stacked set: the bottom shelf sits at y = 0..thickness, then each
  // subsequent shelf is offset upward by its own thickness plus the gap.
  // A back panel, if asked for, applies to the bottom unit only.
  let y = 0;
  const n = levels.length + 1;
  for (let i = 0; i < n; i++) {
    const one = (i === 0 && p.backPanel)
      ? buildShelfWithBackPanel(THREE, w, d, thickness, Math.min(thickness, m(5)), p, detail)
      : buildOneShelf(THREE, w, d, thickness, p.color, p.finish, p.led, p.ledColor, detail);
    one.position.y = y;
    g.add(one);
    if (i < levels.length) y += thickness + m(levels[i]);
  }
  return g;
}

// ============================================================================
// monitor - flat or curved super-ultrawide, optional riser
// ============================================================================
const MONITOR_DEFAULTS = Object.freeze({
  width: 85,
  height: 35,
  depth: 8,
  curved: false,
  color: '#181818',
  finish: 'matte',
  screenColor: '#0d1520',
  riser: false,
  riserHeight: 10,
  riserWidth: 40,
  riserDepth: 25
});

function buildMonitor(THREE, params, opts) {
  const p = Object.assign({}, MONITOR_DEFAULTS, params || {});
  const g = new THREE.Group();
  g.name = 'furniture:monitor';
  const riserH = p.riser ? m(p.riserHeight) : 0;

  if (p.riser) {
    const riserMat = makeFinish(THREE, 'matte', '#2a2a2a');
    const rw = m(p.riserWidth), rd = m(p.riserDepth);
    g.add(box(THREE, rw, rd, riserH, riserMat, 0, riserH / 2, rd / 2));
  }

  const w = m(p.width), d = m(p.depth);
  const bodyMat = makeFinish(THREE, p.finish, p.color);
  const screenMat = makeFinish(THREE, 'emissive', p.screenColor);
  const standD = Math.min(d, 0.06);

  // `height` is the FULL assembly: riser (if any) + stand + panel. The
  // stand takes a fixed slice off the bottom of the declared height so the
  // overall bounding box always equals width/depth/height exactly.
  const standH = Math.min(m(6), Math.max(m(p.height) - riserH - 0.05, 0.01));
  g.add(box(THREE, m(6), standD, standH, bodyMat, 0, riserH + standH / 2, standD / 2));

  const panelBottom = riserH + standH;
  const h = Math.max(m(p.height) - panelBottom, 0.01);
  const screenDepth = Math.min(Math.max(d * 0.3, 0.004), d * 0.5);
  if (!p.curved) {
    g.add(box(THREE, w, d, h, bodyMat, 0, panelBottom + h / 2, d / 2));
    // The screen sits flush with the panel's own front face (z = d), not
    // proud of it, so the group's overall depth stays exactly `depth`.
    const screen = box(THREE, w * 0.97, screenDepth, h * 0.94, screenMat,
      0, panelBottom + h / 2, d - screenDepth / 2);
    screen.userData.keep = true;
    g.add(screen);
  } else {
    // A curved super-ultrawide: several slim segments arcing around a
    // shallow radius so the bounding box still equals width/depth/height
    // exactly (the contract's bbox check), while reading as curved. The
    // body segments are left UNROTATED (only bowed back in z) so rotating a
    // full-depth box never swings a corner past z=0 or past the declared
    // depth; only the thin screen segments rotate, and they are clamped to
    // the same [0, d] range explicitly.
    const segCount = opts && opts.detail === 'low' ? 5 : 13;
    const radius = w * 1.1; // shallow curve
    const totalAngle = w / radius; // arc length ~= chord for a shallow bend
    const segW = w / segCount;
    const bowMax = Math.min(d * 0.15, d - screenDepth); // never exceeds depth
    // Segment centres are placed by ANGLE (for the bow), but then rescaled
    // in x so the outermost segment edges land exactly on +-w/2 -- the
    // angle-based sin() spacing alone undershoots the declared width.
    const rawXs = [];
    for (let i = 0; i < segCount; i++) {
      const t = (i + 0.5) / segCount - 0.5; // -0.5..0.5
      rawXs.push(Math.sin(t * totalAngle) * radius);
    }
    const rawSpan = (rawXs[rawXs.length - 1] - rawXs[0]) + segW * 1.02;
    const xScale = rawSpan > 0 ? w / rawSpan : 1;
    for (let i = 0; i < segCount; i++) {
      const t = (i + 0.5) / segCount - 0.5; // -0.5..0.5
      const angle = t * totalAngle;
      const x = rawXs[i] * xScale;
      const zBow = Math.max(0, Math.min(radius - Math.cos(angle) * radius, bowMax));
      const segZ = Math.max(screenDepth / 2, d - screenDepth / 2 - zBow);
      const seg = box(THREE, segW * 1.02, Math.max(d - zBow, screenDepth), h, bodyMat, 0, 0, 0);
      seg.position.set(x, panelBottom + h / 2, Math.max(d - zBow, screenDepth) / 2);
      g.add(seg);
      const screenSeg = box(THREE, segW * 0.98, screenDepth, h * 0.94, screenMat, 0, 0, 0);
      screenSeg.position.set(x, panelBottom + h / 2, segZ);
      screenSeg.rotation.y = -angle * 0.3;
      screenSeg.userData.keep = true;
      g.add(screenSeg);
    }
  }
  return g;
}

// ============================================================================
// pc-tower - a box-ish tower with a glass side panel
// ============================================================================
const PC_TOWER_DEFAULTS = Object.freeze({
  width: 22,
  height: 45,
  depth: 42,
  color: '#141414',
  finish: 'matte',
  glassPanel: true
});

function buildPcTower(THREE, params) {
  const p = Object.assign({}, PC_TOWER_DEFAULTS, params || {});
  const w = m(p.width), h = m(p.height), d = m(p.depth);
  const g = new THREE.Group();
  g.name = 'furniture:pc-tower';
  const bodyMat = makeFinish(THREE, p.finish, p.color);
  const glassSide = p.glassPanel ? Math.min(0.008, w * 0.08) : 0;
  g.add(box(THREE, w - glassSide, d, h, bodyMat, -glassSide / 2, h / 2, d / 2));
  if (p.glassPanel) {
    const glassMat = makeFinish(THREE, 'glass', '#a8d8e8');
    const glass = box(THREE, glassSide, d * 0.92, h * 0.92, glassMat, w / 2 - glassSide / 2, h / 2, d / 2);
    glass.userData.keep = true;
    g.add(glass);
  }
  return g;
}

// ============================================================================
// wire-shelf - a triangular white wire wall shelf (living room). Optional.
// ============================================================================
const WIRE_SHELF_DEFAULTS = Object.freeze({
  width: 40,
  depth: 40,
  height: 3,
  color: '#f4f4f4',
  finish: 'metal'
});

function buildWireShelf(THREE, params, opts) {
  const p = Object.assign({}, WIRE_SHELF_DEFAULTS, params || {});
  const w = m(p.width), d = m(p.depth), h = m(p.height);
  const g = new THREE.Group();
  g.name = 'furniture:wire-shelf';
  const mat = makeFinish(THREE, p.finish, p.color);

  // Triangular plan: back edge (z=0) spans the full width, tapering to a
  // point at z=d. A handful of thin wire "rails" approximate a wire shelf
  // cheaply while a bounding box still matches width/depth/height exactly.
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, d);
  shape.lineTo(-w / 2, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  // Rotating -90 about X maps shape-Y (plan depth, 0..d) to world -Z
  // (landing on -d..0) and the extrude axis to world Y (already 0..h, no
  // translate needed there). Shift +d along Z so plan depth lands on 0..d.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, d);
  const mesh = new THREE.Mesh(geo, mat);
  g.add(mesh);

  if (!(opts && opts.detail === 'low')) {
    // A couple of thin wire rails for visual texture at full detail.
    const railMat = makeFinish(THREE, p.finish, p.color);
    for (let i = 1; i <= 2; i++) {
      const z = (d * i) / 3;
      const railW = w * (1 - z / d) * 0.95;
      const rail = box(THREE, railW, h * 0.6, 0.004, railMat, 0, h * 0.8, z);
      g.add(rail);
    }
  }
  return g;
}

// ============================================================================
// clock - a plain round wall clock. Pre-seeded in registry.js against this
// module from an earlier plan revision; not in this item's own type list,
// but built here anyway so the shared contract gate (which loads every
// registered type whose module file exists) stays green for whoever uses
// small-items.js next. Kept deliberately minimal.
// ============================================================================
const CLOCK_DEFAULTS = Object.freeze({
  width: 30,
  height: 30,
  depth: 4,
  color: '#f4f4f0',
  finish: 'matte',
  handColor: '#1a1a1a'
});

function buildClock(THREE, params, opts) {
  const p = Object.assign({}, CLOCK_DEFAULTS, params || {});
  const w = m(p.width), h = m(p.height), d = m(p.depth);
  const r = Math.min(w, h) / 2;
  const g = new THREE.Group();
  g.name = 'furniture:clock';
  const segs = opts && opts.detail === 'low' ? 12 : 32;

  // Face runs the whole declared depth so the group's bbox equals `depth`
  // exactly; the hands sit flush with the face's own front, not proud of it.
  const faceMat = makeFinish(THREE, p.finish, p.color);
  const faceGeo = new THREE.CylinderGeometry(r, r, d, segs);
  faceGeo.rotateX(Math.PI / 2);
  faceGeo.translate(0, h / 2, d / 2);
  g.add(new THREE.Mesh(faceGeo, faceMat));

  const handMat = makeFinish(THREE, 'matte', p.handColor);
  const handZ = d - 0.001;
  const minuteHand = box(THREE, r * 0.08, 0.002, r * 0.75, handMat, 0, h / 2 + r * 0.35, handZ);
  const hourHand = box(THREE, r * 0.1, 0.002, r * 0.5, handMat, 0, h / 2 + r * 0.22, handZ);
  g.add(minuteHand, hourHand);
  return g;
}

// ============================================================================
// wall-art - a single flat panel of wall art (colour + size only). Pre-seeded
// in registry.js against this module from an earlier plan revision. Where
// the item's own photo-frame type carries an image, this is the plain single-
// panel case with no frame -- a canvas print, not a framed photo.
// ============================================================================
const WALL_ART_DEFAULTS = Object.freeze({
  width: 60,
  height: 80,
  depth: 3,
  color: '#8a7a63',
  finish: 'matte'
});

function buildWallArt(THREE, params) {
  const p = Object.assign({}, WALL_ART_DEFAULTS, params || {});
  const w = m(p.width), h = m(p.height), d = m(p.depth);
  const g = new THREE.Group();
  g.name = 'furniture:wall-art';
  const mat = makeFinish(THREE, p.finish, p.color);
  g.add(box(THREE, w, d, h, mat, 0, h / 2, d / 2));
  return g;
}

export const TYPES = {
  'tv': { TYPE: 'tv', DEFAULTS: TV_DEFAULTS, build: buildTv },
  'clock': { TYPE: 'clock', DEFAULTS: CLOCK_DEFAULTS, build: buildClock },
  'wall-art': { TYPE: 'wall-art', DEFAULTS: WALL_ART_DEFAULTS, build: buildWallArt },
  'photo-frame': { TYPE: 'photo-frame', DEFAULTS: PHOTO_FRAME_DEFAULTS, build: buildPhotoFrame },
  'speaker': { TYPE: 'speaker', DEFAULTS: SPEAKER_DEFAULTS, build: buildSpeaker },
  'subwoofer': { TYPE: 'subwoofer', DEFAULTS: SUBWOOFER_DEFAULTS, build: buildSubwoofer },
  'tube-floor-lamp': { TYPE: 'tube-floor-lamp', DEFAULTS: TUBE_FLOOR_LAMP_DEFAULTS, build: buildTubeFloorLamp },
  'coat-rack': { TYPE: 'coat-rack', DEFAULTS: COAT_RACK_DEFAULTS, build: buildCoatRack },
  'mirror': { TYPE: 'mirror', DEFAULTS: MIRROR_DEFAULTS, build: buildMirror },
  'shelf': { TYPE: 'shelf', DEFAULTS: SHELF_DEFAULTS, build: buildShelf },
  'monitor': { TYPE: 'monitor', DEFAULTS: MONITOR_DEFAULTS, build: buildMonitor },
  'pc-tower': { TYPE: 'pc-tower', DEFAULTS: PC_TOWER_DEFAULTS, build: buildPcTower },
  'wire-shelf': { TYPE: 'wire-shelf', DEFAULTS: WIRE_SHELF_DEFAULTS, build: buildWireShelf }
};
