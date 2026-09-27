/**
 * small-items.js - MULTI-TYPE module for the many small wall/floor fittings
 * across rooms: TVs, photo frames, speakers (wall,
 * floor-standing, ceiling and centre-channel), a subwoofer, a tube floor
 * lamp, a coat rack, mirrors, floating shelves (incl. a back-panel L-section
 * preset), monitors and a PC tower. (`wire-shelf`, a generic chrome wire rack,
 * was removed: nothing in a house used it.)
 *
 * `wall-clock` is a SEPARATE type owned by a different crew, not built here.
 * `clock` (an earlier, different type name) and `wall-art` used to live in
 * this module too; both were removed on review -- `clock` because
 * `wall-clock` now owns that ground, and `wall-art` because it added no
 * shape `photo-frame` (with `panels: 1`) does not already cover.
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

// Z-FIGHTING. A screen, an image, a mirror pane or an LED strip laid over a
// body must never share a plane with it: the depth buffer cannot order two
// surfaces at the same depth, so which one wins flips per pixel as the camera
// moves -- the diagonal dotted shimmer across a TV screen. Every overlay here
// is separated from the surface behind it by at least OVERLAY_GAP (2 mm; the
// depth buffer resolves well under 1 mm at room distances), and
// scripts/test-coplanar-faces.mjs fails any two faces of one item that face
// the same way within 1 mm of one plane and overlap.
const OVERLAY_GAP = 0.002;

// ============================================================================
// tv - a wall TV. Two bezel styles:
//   'thin'         a plain flat panel with a thin black bezel (the common
//                  case), optionally on a central pedestal stand instead of
//                  wall-mounted.
//   'picture-frame' a wooden picture-frame bezel (Frame-TV look), wall-hung,
//                  ("art mode" imagery is not built yet -- see `photo-frame`
//                  for the injectable-texture pattern a later PR can reuse).
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
  standDepth: 31.7
});

function buildTv(THREE, params, opts) {
  const p = Object.assign({}, TV_DEFAULTS, params || {});
  const o = opts || {};
  const w = m(p.width), d = m(p.depth);
  const g = new THREE.Group();
  g.name = 'furniture:tv';
  const pictureFrame = p.bezelStyle === 'picture-frame';
  const useStand = !pictureFrame && p.stand;

  // ENVELOPE: `height` and `depth` are the FULL assembly. With `stand`
  // enabled, the stand takes a slice off the bottom of the declared height,
  // and its own depth is clamped to the declared depth -- never overflowing
  // past what the params say the group occupies (no "deliberate breaks").
  let panelBottom = 0;
  if (useStand) {
    const standMat = makeFinish(THREE, 'matte', '#1c1c1c');
    const standH = Math.min(m(p.standHeight), Math.max(m(p.height) - 0.05, 0.01));
    const baseW = m(p.standWidth), baseD = Math.min(m(p.standDepth), d);
    // A slim neck plus a low wide foot, both centred under the panel.
    const neckW = Math.min(0.05, baseW * 0.15);
    const neckD = Math.min(baseD, d);
    g.add(box(THREE, neckW, neckD, standH, standMat, 0, standH / 2, neckD / 2));
    const footH = Math.min(standH * 0.25, 0.02);
    g.add(box(THREE, baseW, baseD, footH, standMat, 0, footH / 2, baseD / 2));
    panelBottom = standH;
  }
  const h = Math.max(m(p.height) - panelBottom, 0.01);

  const screenMat = makeFinish(THREE, 'emissive', p.screenColor);
  const screenDepth = Math.min(Math.max(d * 0.3, 0.005), d * 0.5);
  const cy = panelBottom + h / 2;

  if (!pictureFrame || o.detail === 'low') {
    // 'thin' (and the low-detail picture frame, whose body simply takes the
    // frame colour): the body stops OVERLAY_GAP short of the front, and the
    // screen -- a bezel in from the edges -- stands that far proud of it,
    // its own front at exactly z = d, so the overall depth is `depth`.
    // (Screen and body used to share the plane z = d: the shimmer.)
    const bodyMat = pictureFrame
      ? makeFinish(THREE, 'matte', p.frameColor)
      : makeFinish(THREE, p.finish, p.color);
    g.add(box(THREE, w, d - OVERLAY_GAP, h, bodyMat, 0, cy, (d - OVERLAY_GAP) / 2));
    const bezel = pictureFrame ? Math.min(m(p.frameWidth), w / 4, h / 4) : Math.min(0.012, w * 0.012);
    const screen = box(THREE, w - bezel * 2, screenDepth, h - bezel * 2, screenMat, 0, cy, d - screenDepth / 2);
    screen.userData.keep = true;
    g.add(screen);
    return g;
  }

  // Picture-frame bezel, full detail (Frame-TV look): four wooden bars the
  // full depth, the screen INSIDE their opening and set back OVERLAY_GAP
  // behind their fronts, and the dark panel body behind the screen tucked
  // into the bars -- its edges run inside them, so none of its outer faces
  // shares a plane with a bar's. Its back is OVERLAY_GAP off the wall for
  // the same reason (the bars' backs are at z = 0).
  const frameMat = makeFinish(THREE, 'matte', p.frameColor);
  const fw = Math.min(m(p.frameWidth), w / 4, h / 4);
  g.add(box(THREE, w, d, fw, frameMat, 0, panelBottom + h - fw / 2, d / 2));
  g.add(box(THREE, w, d, fw, frameMat, 0, panelBottom + fw / 2, d / 2));
  g.add(box(THREE, fw, d, h - fw * 2, frameMat, -w / 2 + fw / 2, cy, d / 2));
  g.add(box(THREE, fw, d, h - fw * 2, frameMat, w / 2 - fw / 2, cy, d / 2));
  const tuck = fw / 2;
  const bodyMat = makeFinish(THREE, p.finish, p.color);
  const bodyFront = d - OVERLAY_GAP - screenDepth;
  g.add(box(THREE, w - (fw - tuck) * 2, bodyFront - OVERLAY_GAP, h - (fw - tuck) * 2, bodyMat,
    0, cy, OVERLAY_GAP + (bodyFront - OVERLAY_GAP) / 2));
  const screen = box(THREE, w - fw * 2, screenDepth, h - fw * 2, screenMat, 0, cy, bodyFront + screenDepth / 2);
  screen.userData.keep = true;
  g.add(screen);
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
  // A textured panel is tagged `matte` (the closest palette entry for a
  // printed image) and marked keep=true explicitly -- the contract's "a
  // textured part must be kept and is budgeted individually" rule, since a
  // texture map can never be folded into the vertex-coloured merge.
  const panelMat = tex
    ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 })
    : makeFinish(THREE, p.finish, p.color);
  panelMat.userData.finish = tex ? 'matte' : p.finish;
  if (tex) panelMat.userData.keep = true;

  // Each frame is a moulding of four bars the full depth, and the picture
  // fills the opening between them, its face set back PICTURE_RECESS behind
  // the moulding's front -- as a real framed print sits. (It used to be a
  // panel whose face shared the plane z = d with a solid frame box behind
  // it: the same shimmer as the TV screen.) The picture runs from the back
  // (z = 0) so there is no hole to see through; its edges butt against the
  // bars' inner faces, which face the other way and so cannot fight.
  const PICTURE_RECESS = Math.min(Math.max(OVERLAY_GAP * 2, d * 0.15), d * 0.5);
  const fwc = Math.min(fw, panelW / 3, h / 3);
  for (let i = 0; i < n; i++) {
    const cx = -totalW / 2 + panelW / 2 + i * (panelW + gap);
    g.add(box(THREE, panelW, d, fwc, frameMat, cx, h - fwc / 2, d / 2));
    g.add(box(THREE, panelW, d, fwc, frameMat, cx, fwc / 2, d / 2));
    g.add(box(THREE, fwc, d, h - fwc * 2, frameMat, cx - panelW / 2 + fwc / 2, h / 2, d / 2));
    g.add(box(THREE, fwc, d, h - fwc * 2, frameMat, cx + panelW / 2 - fwc / 2, h / 2, d / 2));
    const innerW = Math.max(panelW - fwc * 2, 0.005);
    const innerH = Math.max(h - fwc * 2, 0.005);
    const pd = d - PICTURE_RECESS;
    const panel = box(THREE, innerW, pd, innerH, panelMat, cx, h / 2, pd / 2);
    if (tex) panel.userData.keep = true;
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
// THE FRONT (wall-trapezoid, floor-standing, centre, and the subwoofer): the
// cabinet stops a grille-depth short of the front; on its baffle sit real
// drivers (a rubber surround ring, a cone and a dust cap; a tweeter dome on
// a faceplate) and a round bass port; a frame rim runs round the front edge
// (the cabinet's edge detail); and a smoked, see-through grille fills the
// rim, so the drivers show through it. `grille: false` drops the grille
// panel (the rim stays); `port: false` drops the port. 'low' detail is the
// cabinet and rim only. Everything stays inside width x depth x height.
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
  // A see-through smoked grille over the drivers, and a round bass port on
  // the baffle (every kind with a front baffle).
  grille: true,
  port: true,
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

const DRIVER_COLORS = Object.freeze({ surround: '#161616', cone: '#2c2c2e', cap: '#111111', plate: '#1d1d1f' });
const GRILLE_COLOR = '#2a2c30';
const PORT_COLOR = '#0c0c0c';

/** How deep the grille zone in front of the baffle is, for a cabinet `d` deep. */
function grilleDepth(d) { return Math.min(0.016, Math.max(d * 0.2, 0.008)); }

/**
 * One driver on a baffle whose front face is the plane z = zFace, facing +z,
 * everything proud of that plane (never behind it: a driver behind the baffle
 * is invisible -- which is what the old CircleGeometry cones, set 1 mm INSIDE
 * the cabinet, were). `kind` 'woofer' is a rubber surround ring, a shallow
 * cone and a dust-cap dome; 'tweeter' is a dome on a round faceplate. `r` is
 * the driver's outer radius. Nothing stands more than `maxProud` in front
 * of the baffle (domes flatten to fit), so a driver never pokes through the
 * grille or past the envelope.
 */
function addDriver(THREE, g, mats, kind, r, cx, cy, zFace, segs, maxProud) {
  const toFront = geo => { geo.rotateX(Math.PI / 2); return geo; }; // +y axis -> +z
  if (kind === 'tweeter') {
    const plateT = Math.min(0.003, r * 0.3, maxProud / 3);
    const plate = new THREE.Mesh(toFront(new THREE.CylinderGeometry(r * 1.45, r * 1.45, plateT, segs)), mats.plate);
    plate.position.set(cx, cy, zFace + plateT / 2);
    plate.name = 'tweeterPlate';
    const dome = new THREE.Mesh(toFront(new THREE.SphereGeometry(r, segs, Math.max(2, segs / 4), 0, Math.PI * 2, 0, Math.PI / 2)), mats.cap);
    dome.scale.set(1, 1, Math.min(1, (maxProud - plateT) / r));
    dome.position.set(cx, cy, zFace + plateT);
    dome.name = 'tweeterDome';
    g.add(plate, dome);
    return;
  }
  const tube = Math.min(r * 0.1, maxProud);
  const surround = new THREE.Mesh(new THREE.TorusGeometry(r - tube, tube, 4, segs), mats.surround);
  surround.position.set(cx, cy, zFace);
  surround.name = 'driverSurround';
  const coneH = Math.min(r * 0.12, 0.008, maxProud / 2);
  const cone = new THREE.Mesh(toFront(new THREE.CylinderGeometry(r * 0.3, r - tube * 1.6, coneH, segs)), mats.cone);
  cone.position.set(cx, cy, zFace + coneH / 2);
  cone.name = 'driverCone';
  const capR = r * 0.3;
  const cap = new THREE.Mesh(toFront(new THREE.SphereGeometry(capR, segs, Math.max(2, segs / 4), 0, Math.PI * 2, 0, Math.PI / 2)), mats.cap);
  cap.scale.set(1, 1, Math.min(0.5, (maxProud - coneH) / capR)); // a flattened dome
  cap.position.set(cx, cy, zFace + coneH);
  cap.name = 'driverCap';
  g.add(surround, cone, cap);
}

/** A round bass port on the baffle: a flared ring and its dark mouth. */
function addPort(THREE, g, mats, r, cx, cy, zFace, segs, maxProud) {
  const tube = Math.min(r * 0.22, maxProud);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 4, segs), mats.surround);
  ring.position.set(cx, cy, zFace);
  ring.name = 'portRing';
  // The mouth: a dark disc OVERLAY_GAP off the baffle, inside the ring.
  const mouth = new THREE.Mesh(new THREE.CircleGeometry(r, segs), mats.port);
  mouth.position.set(cx, cy, zFace + OVERLAY_GAP);
  mouth.name = 'portMouth';
  g.add(ring, mouth);
}

/**
 * The front of a speaker cabinet: rim, drivers, port and grille, over the
 * rectangle x in [-fw/2, fw/2], y in [y0, y1], between the baffle plane
 * z = zb and the front z = zf. `layout` is { drivers: [{kind, r, x, y}],
 * port: {r, x, y} | null }. Low detail: the rim only.
 */
function addSpeakerFront(THREE, g, p, opts, fw, y0, y1, zb, zf, layout) {
  const low = opts && opts.detail === 'low';
  const segs = low ? 8 : 16;
  const rimMat = makeFinish(THREE, p.finish, p.color);
  const rt = rimThickness(fw, y1 - y0);
  const rd = zf - zb;
  const cy = (y0 + y1) / 2, fh = y1 - y0;
  // The rim: four bars round the front edge, the full grille depth.
  [box(THREE, fw, rd, rt, rimMat, 0, y1 - rt / 2, zb + rd / 2),
    box(THREE, fw, rd, rt, rimMat, 0, y0 + rt / 2, zb + rd / 2),
    box(THREE, rt, rd, fh - rt * 2, rimMat, -fw / 2 + rt / 2, cy, zb + rd / 2),
    box(THREE, rt, rd, fh - rt * 2, rimMat, fw / 2 - rt / 2, cy, zb + rd / 2)
  ].forEach(bar => { bar.name = 'speakerRim'; g.add(bar); });
  if (low) return;
  const mats = {
    surround: makeFinish(THREE, 'matte', DRIVER_COLORS.surround),
    cone: makeFinish(THREE, 'matte', DRIVER_COLORS.cone),
    cap: makeFinish(THREE, 'gloss', DRIVER_COLORS.cap),
    plate: makeFinish(THREE, 'matte', DRIVER_COLORS.plate),
    port: makeFinish(THREE, 'matte', PORT_COLOR)
  };
  // Drivers and the port stay clear of the grille panel by OVERLAY_GAP.
  const gt = Math.min(0.002, rd / 4);
  const maxProud = rd - gt - OVERLAY_GAP;
  layout.drivers.forEach(dv => addDriver(THREE, g, mats, dv.kind, dv.r, dv.x, dv.y, zb, segs, maxProud));
  if (layout.port && p.port !== false) addPort(THREE, g, mats, layout.port.r, layout.port.x, layout.port.y, zb, segs, maxProud);
  if (p.grille !== false) {
    // The grille: a thin smoked panel inside the rim, its face at the front.
    const grille = box(THREE, fw - rt * 2, gt, fh - rt * 2, makeFinish(THREE, 'glass', GRILLE_COLOR), 0, cy, zf - gt / 2);
    grille.userData.keep = true;
    grille.name = 'speakerGrille';
    g.add(grille);
  }
}

function rimThickness(fw, fh) { return Math.min(0.012, fw * 0.07, fh * 0.07); }

/**
 * A vertical column of drivers for a front `fw` wide spanning [y0, y1]:
 * a port at the bottom (when on), `mids` woofers above it, a tweeter on
 * top. Radii are fitted to the space, so any sane size builds.
 */
function columnLayout(p, fw, y0, y1, mids) {
  const rt = rimThickness(fw, y1 - y0);
  const innerW = fw - rt * 2, top = y1 - rt, bottom = y0 + rt;
  const hasPort = p.port !== false;
  const portR = hasPort ? Math.min(0.022, innerW * 0.14, (top - bottom) * 0.07) : 0;
  const portY = bottom + portR * 1.3 + 0.006;
  const floor = hasPort ? portY + portR * 1.3 + 0.006 : bottom + 0.006;
  const tweeterR = Math.min(0.014, innerW * 0.1);
  const tweeterY = top - tweeterR * 1.45 - 0.008;
  const avail = (tweeterY - tweeterR * 1.45 - 0.006) - floor;
  const r = Math.max(0.01, Math.min(innerW / 2 * 0.86, avail / mids / 2 * 0.92));
  const drivers = [{ kind: 'tweeter', r: tweeterR, x: 0, y: tweeterY }];
  for (let i = 0; i < mids; i++) drivers.push({ kind: 'woofer', r, x: 0, y: floor + (avail / mids) * (i + 0.5) });
  return { drivers, port: hasPort ? { r: portR, x: 0, y: portY } : null };
}

function buildSpeakerWallTrapezoid(THREE, p, opts) {
  const g = new THREE.Group();
  const mat = makeFinish(THREE, p.finish, p.color);
  const h = m(p.height), d = m(p.depth);
  const backW = m(p.width);
  const frontW = m(Math.min(p.frontWidth, p.width));
  // The cabinet stops a grille-depth short of the front; see THE FRONT.
  const gd = grilleDepth(d);
  const zb = d - gd;
  // The trapezoid's width at the baffle plane z = zb (it tapers towards
  // frontW at z = d, so the baffle is a little wider than the rim).
  const baffleW = p.boxShape ? backW : frontW + (backW - frontW) * (gd / d);

  if (p.boxShape) {
    g.add(Object.assign(box(THREE, backW, zb, h, mat, 0, h / 2, zb / 2), { name: 'speakerCabinet' }));
  } else {
    // Trapezoid in plan: back (z=0) is `width` wide (the widest edge, per
    // the bbox contract), narrowing towards the front.
    //
    // ExtrudeGeometry extrudes the shape's local XY plane (x, shape-y) along
    // +Z (world height) by `depth` (here, `h`). Rotating -90 about X maps
    // shape-y=0 to world z=+zb and shape-y=zb to world z=0 (VERIFIED: this is
    // an inversion, not a straight relabelling -- rotating -90 about X sends
    // +Y to +Z, but the geometry's own vertices at shape-y=0 land at the
    // FAR end post-translate, confirmed by sampling vertex positions). So
    // the shape is authored with the NARROW edge at shape-y=0 (which becomes
    // the FAR face, world z=zb) and the WIDE edge at shape-y=zb (which becomes
    // world z=0, the back) -- the opposite of what reads naturally from the
    // frame's own name. Do not "simplify" this without re-verifying against
    // built geometry; a previous attempt got exactly this backwards.
    const shape = new THREE.Shape();
    shape.moveTo(-baffleW / 2, 0);
    shape.lineTo(baffleW / 2, 0);
    shape.lineTo(backW / 2, zb);
    shape.lineTo(-backW / 2, zb);
    shape.lineTo(-baffleW / 2, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, zb);
    g.add(Object.assign(new THREE.Mesh(geo, mat), { name: 'speakerCabinet' }));
  }
  const fw = p.boxShape ? backW : frontW;
  addSpeakerFront(THREE, g, p, opts, fw, 0, h, zb, d, columnLayout(p, fw, 0, h, 1));
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
  const gd = grilleDepth(d), zb = d - gd;
  g.add(Object.assign(box(THREE, w, zb, h - plinthH, mat, 0, plinthH + (h - plinthH) / 2, zb / 2), { name: 'speakerCabinet' }));
  const midCount = Math.max(2, Math.min(3, Math.round(p.midDrivers)));
  addSpeakerFront(THREE, g, p, opts, w, plinthH, h, zb, d, columnLayout(p, w, plinthH, h, midCount));
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
  // The box stops OVERLAY_GAP short of the driver's face and the driver
  // disc sits ON that face of the envelope, so it is visible (it used to be
  // 1 mm inside the box).
  const g = new THREE.Group();
  const mat = makeFinish(THREE, p.finish, p.color);
  const w = m(p.width), d = m(p.depth), h = m(p.height);
  const low = opts && opts.detail === 'low';
  const gap = low ? 0 : OVERLAY_GAP;
  const down = p.firing === 'down', angled = p.firing === 'angled';
  const bodyD = angled ? d - gap : d;
  const bodyY0 = down ? gap : 0, bodyY1 = (!down && !angled) ? h - gap : h;
  g.add(Object.assign(box(THREE, w, bodyD, bodyY1 - bodyY0, mat, 0, (bodyY0 + bodyY1) / 2, bodyD / 2), { name: 'speakerCabinet' }));
  if (!low) {
    const driverMat = makeFinish(THREE, 'matte', '#181818');
    const r = Math.min(w, d) * 0.32;
    const driver = new THREE.Mesh(new THREE.CircleGeometry(r, 16), driverMat);
    driver.name = 'driverCone';
    if (down) {
      driver.rotation.x = Math.PI / 2;
      driver.position.set(0, 0, d / 2);
    } else if (angled) {
      driver.position.set(0, h * 0.7, d);
    } else {
      driver.rotation.x = -Math.PI / 2;
      driver.position.set(0, h, d / 2);
    }
    g.add(driver);
  }
  return g;
}

function buildSpeakerCentre(THREE, p, opts) {
  // A low wide console speaker: mid, tweeter, mid across the front.
  const g = new THREE.Group();
  const mat = makeFinish(THREE, p.finish, p.color);
  const w = m(p.width), d = m(p.depth), h = m(p.height);
  const gd = grilleDepth(d), zb = d - gd;
  g.add(Object.assign(box(THREE, w, zb, h, mat, 0, h / 2, zb / 2), { name: 'speakerCabinet' }));
  const innerH = h - rimThickness(w, h) * 2;
  const midR = Math.min(m(p.midDriverDiameter) / 2, innerH / 2 * 0.9);
  const tweeterR = Math.min(m(p.tweeterDiameter) / 2, innerH / 2 * 0.5);
  const gap = w * 0.24;
  addSpeakerFront(THREE, g, p, opts, w, 0, h, zb, d, {
    drivers: [
      { kind: 'woofer', r: midR, x: -gap, y: h / 2 },
      { kind: 'tweeter', r: tweeterR, x: 0, y: h / 2 },
      { kind: 'woofer', r: midR, x: gap, y: h / 2 }
    ],
    port: null
  });
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
// subwoofer - a white cube on four short feet: one big front-firing woofer
// and a bass port behind a see-through grille, inside a front rim (see THE
// FRONT under `speaker`).
// ============================================================================
const SUBWOOFER_DEFAULTS = Object.freeze({
  width: 35,
  height: 35,
  depth: 35,
  color: '#f2f2f2',
  finish: 'matte',
  grille: true,
  port: true
});

function buildSubwoofer(THREE, params, opts) {
  const p = Object.assign({}, SUBWOOFER_DEFAULTS, params || {});
  const w = m(p.width), h = m(p.height), d = m(p.depth);
  const low = opts && opts.detail === 'low';
  const mat = makeFinish(THREE, p.finish, p.color);
  const g = new THREE.Group();
  g.name = 'furniture:subwoofer';
  const gd = grilleDepth(d), zb = d - gd;
  // Four short feet; the cabinet sits on them.
  const footH = Math.min(0.015, h * 0.06);
  if (!low) {
    const footMat = makeFinish(THREE, 'matte', '#1a1a1a');
    const fr = Math.min(0.02, w * 0.08, d * 0.08);
    const ix = w / 2 - fr * 1.6, zs = [fr * 1.6, zb - fr * 1.6];
    [-ix, ix].forEach(x => zs.forEach(z => {
      const geo = new THREE.CylinderGeometry(fr, fr, footH, 12);
      geo.translate(x, footH / 2, z);
      g.add(new THREE.Mesh(geo, footMat));
    }));
  }
  const y0 = low ? 0 : footH;
  g.add(Object.assign(box(THREE, w, zb, h - y0, mat, 0, y0 + (h - y0) / 2, zb / 2), { name: 'speakerCabinet' }));
  // One big woofer above a port, fitted to the front.
  const rt = rimThickness(w, h - y0);
  const innerW = w - rt * 2, bottom = y0 + rt, top = h - rt;
  const hasPort = p.port !== false;
  const portR = hasPort ? Math.min(0.026, innerW * 0.08) : 0;
  const portY = bottom + portR * 1.3 + 0.006;
  const floor = hasPort ? portY + portR * 1.3 + 0.008 : bottom + 0.008;
  const r = Math.max(0.02, Math.min(innerW / 2 * 0.86, (top - 0.008 - floor) / 2));
  addSpeakerFront(THREE, g, p, opts, w, y0, h, zb, d, {
    drivers: [{ kind: 'woofer', r, x: 0, y: floor + r }],
    port: hasPort ? { r: portR, x: 0, y: portY } : null
  });
  return g;
}

// ============================================================================
// tube-floor-lamp - a thin emissive light tube rising from a round base
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

const LAMP_TRIM_COLOR = '#b9bcc0';

function buildTubeFloorLamp(THREE, params, opts) {
  const p = Object.assign({}, TUBE_FLOOR_LAMP_DEFAULTS, params || {});
  const g = new THREE.Group();
  g.name = 'furniture:tube-floor-lamp';
  const low = opts && opts.detail === 'low';
  const segs = low ? 8 : 24;
  const baseMat = makeFinish(THREE, p.baseFinish, p.baseColor);
  const trimMat = makeFinish(THREE, 'metal', LAMP_TRIM_COLOR);
  const H = m(p.height);
  const baseH = Math.min(m(p.baseHeight), H * 0.5);
  const baseR = Math.min(m(p.width), m(p.depth)) / 2;
  const tubeR = Math.min(m(p.tubeDiameter) / 2, baseR * 0.4);
  const cz = baseR; // everything is centred over the base's own centre
  const cyl = (rTop, rBot, hgt, y0, mat) => {
    const geo = new THREE.CylinderGeometry(rTop, rBot, hgt, segs);
    geo.translate(0, y0 + hgt / 2, cz);
    const mesh = new THREE.Mesh(geo, mat);
    g.add(mesh);
    return mesh;
  };

  // THE BASE: a weighted foot disc with a chamfered top edge, a tapered
  // collar rising from it to the tube, and a metal trim ring where the tube
  // enters. Each part sits on the one below (touching faces point opposite
  // ways, so none of them can z-fight).
  const footH = Math.min(0.025, baseH * 0.25);
  const chamfer = Math.min(footH * 0.4, 0.008);
  cyl(baseR, baseR, footH - chamfer, 0, baseMat);
  cyl(baseR - chamfer, baseR, chamfer, footH - chamfer, baseMat);
  const trimH = low ? 0 : Math.min(0.012, baseH * 0.1);
  const collarH = baseH - footH - trimH;
  cyl(tubeR * 1.5, Math.max(baseR * 0.42, tubeR * 1.6), collarH, footH, baseMat);
  if (!low) cyl(tubeR * 1.3, tubeR * 1.3, trimH, baseH - trimH, trimMat);

  // THE TUBE, with a metal end cap on top.
  const capH = low ? 0 : Math.min(0.012, H * 0.02);
  const tubeH = H - baseH - capH;
  const tubeMat = makeFinish(THREE, p.finish, p.color);
  if (p.oneSidedGlow) {
    // One-sided glow: the half facing the room (+z) glows; the half facing
    // the wall is the lamp's body, in the base's finish, so the tube is
    // still a whole tube from behind or the side. (It used to be an open
    // half-cylinder alone -- invisible from the back.) CylinderGeometry
    // puts theta = 0 on +z, so the glowing half is theta -PI/2..+PI/2.
    const glowGeo = new THREE.CylinderGeometry(tubeR, tubeR, tubeH, segs, 1, true, -Math.PI / 2, Math.PI);
    glowGeo.translate(0, baseH + tubeH / 2, cz);
    const glow = new THREE.Mesh(glowGeo, tubeMat);
    glow.name = 'lampTube';
    glow.userData.keep = true;
    g.add(glow);
    const backGeo = new THREE.CylinderGeometry(tubeR, tubeR, tubeH, segs, 1, true, Math.PI / 2, Math.PI);
    backGeo.translate(0, baseH + tubeH / 2, cz);
    g.add(Object.assign(new THREE.Mesh(backGeo, baseMat), { name: 'lampTubeBack' }));
  } else {
    const tube = cyl(tubeR, tubeR, tubeH, baseH, tubeMat);
    tube.name = 'lampTube';
    tube.userData.keep = true;
  }
  if (!low) cyl(tubeR * 1.12, tubeR * 1.12, capH, H - capH, trimMat);
  return g;
}

// ============================================================================
// coat-rack - a wall hook rail with 0-3 simple draped coats.
//
// ENVELOPE: `height` is the FULL assembly. The rail itself is a fixed-height
// band (min(height, 10cm)) at the TOP of the declared height; when `coats` is
// nonzero the draped coats hang from the rail down to y=0, so a caller asking
// for coats must set `height` to rail-band-height + the coats' own drop (the
// DEFAULTS keep `coats: 0`, where the rail alone equals the declared height).
// No part is ever placed below y=0 or beyond width/depth/height, regardless
// of `coats`.
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

  // The rail is a fixed-height band (never taller than the declared
  // envelope) sitting at the TOP of `height`, so coats can drop below it
  // down to y=0 without ever leaving the envelope.
  const railH = Math.min(m(10), h);
  const railY = h - railH;
  const railMat = makeFinish(THREE, p.finish, p.color);
  g.add(box(THREE, w, d, railH, railMat, 0, railY + railH / 2, d / 2));

  // Hook knobs, evenly spaced, on the rail band.
  const hookMat = makeFinish(THREE, 'metal', '#888888');
  const hookCount = Math.max(coats, 3);
  const hookR = Math.min(0.012, w / (hookCount * 6));
  const segs = opts && opts.detail === 'low' ? 6 : 12;
  for (let i = 0; i < hookCount; i++) {
    const cx = -w / 2 + w * (i + 0.5) / hookCount;
    const geo = new THREE.SphereGeometry(hookR, segs, Math.max(4, segs / 2));
    // Flush with the rail's own front face (z = d), not proud of it, so the
    // group's overall depth stays exactly `depth`.
    geo.translate(cx, railY + railH / 2, d - hookR);
    g.add(new THREE.Mesh(geo, hookMat));
  }

  // Simple draped coats: a rounded box "body" hanging from the rail's
  // underside down toward y=0, clamped so it never crosses either bound --
  // the requested coatHeight is honoured only as far as the envelope allows.
  const coatH = Math.min(m(p.coatHeight), railY);
  const coatD = Math.min(d * 1.3, d);
  for (let i = 0; i < coats; i++) {
    const cx = -w / 2 + w * (i + 0.5) / hookCount;
    const color = p.coatColors[i % p.coatColors.length];
    const coatMat = makeFinish(THREE, 'matte', color);
    const coatW = Math.min(0.22, w / hookCount * 0.8);
    const geo = new THREE.BoxGeometry(coatW, coatH, coatD);
    geo.translate(cx, railY - coatH / 2, coatD / 2);
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
  // The frame (a backer plate the full outline) stops OVERLAY_GAP short of
  // the front, so the glass's face at z = d never shares its plane.
  const frameGeo = new THREE.ExtrudeGeometry(outerShape, { depth: d - OVERLAY_GAP, bevelEnabled: false, curveSegments: opts && opts.detail === 'low' ? 8 : 24 });
  frameGeo.rotateX(0); // shape is already in the x/y (width/height) plane
  // The extrude axis is +Z here, which is our world depth axis already
  // (shape x -> width, shape y -> height, extrude -> depth). No rotation
  // needed; just recentre so the back sits at z=0 and the shape is centred
  // vertically at h/2 (shape is currently centred at y=0).
  frameGeo.translate(0, h / 2, 0);
  const frameMesh = new THREE.Mesh(frameGeo, frameMat);
  g.add(frameMesh);

  // Mirror glass: a slightly inset, slightly thinner copy of the same
  // outline, its face at z = d, OVERLAY_GAP proud of the frame's face.
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
//              horizontal shelf slab in front of it. Real reference: 180w x
//              ~22d x ~20h overall, a white ~20h back panel and an oak
//              shelf slab -- generic defaults only, no brand kept anywhere.
//
// ENVELOPE: `height` is ALWAYS the full assembly -- one slab's thickness
// with no `levels` and no `backPanel`; the WHOLE stack (every slab plus
// every gap) with `levels`; the overall back-panel-to-shelf-top height with
// `backPanel`. Each slab's own thickness is `shelfThickness`, a SEPARATE
// param, so a `levels` stack's per-slab thickness never has to double as
// the group's overall height. `levels` and `backPanel` are independent: a
// stacked set may or may not have a back panel on the bottom unit; a single
// shelf may or may not either.
// ============================================================================
const SHELF_DEFAULTS = Object.freeze({
  width: 80,
  depth: 20,
  height: 5,
  shelfThickness: 5,
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
  // With an LED edge the slab stops OVERLAY_GAP short of the front and the
  // strip's face is at z = d, proud of it; the strip used to share the
  // slab's front plane and shimmer against it.
  const slabD = led ? d - OVERLAY_GAP : d;
  g.add(box(THREE, w, slabD, thickness, mat, 0, thickness / 2, slabD / 2));
  if (led) {
    // Along the bottom of the slab's front edge, its face at z = d.
    const stripDepth = Math.max(thickness * 0.15, 0.003);
    // OVERLAY_GAP above the slab's underside, so its own underside is not
    // in the slab's plane.
    const stripH = Math.min(Math.max(thickness * 0.4, 0.004), thickness - OVERLAY_GAP * 2);
    const ledMat = makeFinish(THREE, 'emissive', ledColor);
    const strip = box(THREE, w * 0.96, stripDepth, stripH,
      ledMat, 0, OVERLAY_GAP + stripH / 2, d - stripDepth / 2);
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
  const backMat = makeFinish(THREE, 'matte', p.backPanelColor);
  const backThickness = Math.min(0.02, d * 0.15);
  const shelfMat = makeFinish(THREE, p.finish, p.shelfColor);
  const shelfY = Math.max(totalH - shelfThickness, backThickness);
  // The back panel stops at the slab's underside. Running it on up through
  // the slab (as it did) put its top and back faces in the slab's own
  // planes, in two different colours -- a shimmering strip along the back of
  // the shelf top.
  const backH = Math.min(m(p.backPanelHeight), totalH, shelfY);
  g.add(box(THREE, w, backThickness, backH, backMat, 0, backH / 2, backThickness / 2));
  const slabD = p.led ? d - OVERLAY_GAP : d;
  g.add(box(THREE, w, slabD, shelfThickness, shelfMat, 0, shelfY + shelfThickness / 2, slabD / 2));

  if (p.led) {
    // Flush with the shelf slab's own underside: the strip's bottom face
    // touches the slab's own bottom face (y = shelfY) exactly.
    const stripDepth = Math.max(shelfThickness * 0.15, 0.003);
    const stripH = Math.min(Math.max(shelfThickness * 0.4, 0.004), shelfThickness - OVERLAY_GAP * 2);
    const ledMat = makeFinish(THREE, 'emissive', p.ledColor);
    const strip = box(THREE, w * 0.96, stripDepth, stripH,
      ledMat, 0, shelfY + OVERLAY_GAP + stripH / 2, d - stripDepth / 2);
    strip.userData.keep = true;
    g.add(strip);
  }
  return g;
}

function buildShelf(THREE, params, opts) {
  const p = Object.assign({}, SHELF_DEFAULTS, params || {});
  const w = m(p.width), d = m(p.depth);
  const g = new THREE.Group();
  g.name = 'furniture:shelf';
  const detail = opts && opts.detail;
  const levels = Array.isArray(p.levels) ? p.levels : [];

  if (levels.length === 0) {
    // No stack: `height` is this one slab's own thickness (the envelope of
    // a single item), matching `shelfThickness` in the DEFAULTS case.
    const thickness = m(p.height);
    const one = p.backPanel
      ? buildShelfWithBackPanel(THREE, w, d, thickness, Math.min(thickness, m(p.shelfThickness)), p, detail)
      : buildOneShelf(THREE, w, d, thickness, p.color, p.finish, p.led, p.ledColor, detail);
    g.add(one);
    return g;
  }

  // A stacked set: `height` is the FULL stack (every slab plus every gap),
  // and each slab's own thickness is the SEPARATE `shelfThickness` param --
  // it never has to double as the group's overall height. The bottom shelf
  // sits at y = 0..shelfThickness, then each subsequent shelf is offset
  // upward by its own thickness plus the gap. A back panel, if asked for,
  // applies to the bottom unit only, using its slice of the stack's height.
  const thickness = m(p.shelfThickness);
  let y = 0;
  const n = levels.length + 1;
  for (let i = 0; i < n; i++) {
    const one = (i === 0 && p.backPanel)
      ? buildShelfWithBackPanel(THREE, w, d, thickness, Math.min(thickness, m(p.shelfThickness)), p, detail)
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

  const w = m(p.width), d = m(p.depth);
  const bodyMat = makeFinish(THREE, p.finish, p.color);
  const screenMat = makeFinish(THREE, 'emissive', p.screenColor);
  const standD = Math.min(d, 0.06);

  if (p.riser) {
    // `depth` is the OVERALL envelope, and the riser is typically the
    // deepest part of the assembly -- so the riser's own depth is clamped
    // to never exceed the declared `depth` (never a silent overflow past
    // what the params say the group occupies).
    const riserMat = makeFinish(THREE, 'matte', '#2a2a2a');
    const rw = m(p.riserWidth), rd = Math.min(m(p.riserDepth), d);
    g.add(box(THREE, rw, rd, riserH, riserMat, 0, riserH / 2, rd / 2));
  }

  // `height` is the FULL assembly: riser (if any) + stand + panel. The
  // stand takes a fixed slice off the bottom of the declared height so the
  // overall bounding box always equals width/depth/height exactly.
  const standH = Math.min(m(6), Math.max(m(p.height) - riserH - 0.05, 0.01));
  g.add(box(THREE, m(6), standD, standH, bodyMat, 0, riserH + standH / 2, standD / 2));

  const panelBottom = riserH + standH;
  const h = Math.max(m(p.height) - panelBottom, 0.01);
  const screenDepth = Math.min(Math.max(d * 0.3, 0.004), d * 0.5);
  if (!p.curved) {
    // The body stops OVERLAY_GAP short of the front and the screen stands
    // that far proud, its face at z = d (see OVERLAY_GAP: they used to
    // share the plane z = d).
    g.add(box(THREE, w, d - OVERLAY_GAP, h, bodyMat, 0, panelBottom + h / 2, (d - OVERLAY_GAP) / 2));
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
    const CURVED_GAP = 0.006;
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
      // The body segment stops CURVED_GAP short of its screen segment's
      // face. More than OVERLAY_GAP: the screen segment is turned about y
      // by up to ~0.14 rad, so its edges swing ~4.5 mm either way of its
      // centre plane and must stay in front of the body all the same.
      const segD = Math.max(d - zBow - CURVED_GAP, screenDepth);
      const seg = box(THREE, segW * 1.02, segD, h, bodyMat, 0, 0, 0);
      seg.position.set(x, panelBottom + h / 2, segD / 2);
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

export const TYPES = {
  'tv': { TYPE: 'tv', DEFAULTS: TV_DEFAULTS, build: buildTv },
  'photo-frame': { TYPE: 'photo-frame', DEFAULTS: PHOTO_FRAME_DEFAULTS, build: buildPhotoFrame },
  'speaker': { TYPE: 'speaker', DEFAULTS: SPEAKER_DEFAULTS, build: buildSpeaker },
  'subwoofer': { TYPE: 'subwoofer', DEFAULTS: SUBWOOFER_DEFAULTS, build: buildSubwoofer },
  'tube-floor-lamp': { TYPE: 'tube-floor-lamp', DEFAULTS: TUBE_FLOOR_LAMP_DEFAULTS, build: buildTubeFloorLamp },
  'coat-rack': { TYPE: 'coat-rack', DEFAULTS: COAT_RACK_DEFAULTS, build: buildCoatRack },
  'mirror': { TYPE: 'mirror', DEFAULTS: MIRROR_DEFAULTS, build: buildMirror },
  'shelf': { TYPE: 'shelf', DEFAULTS: SHELF_DEFAULTS, build: buildShelf },
  'monitor': { TYPE: 'monitor', DEFAULTS: MONITOR_DEFAULTS, build: buildMonitor },
  'pc-tower': { TYPE: 'pc-tower', DEFAULTS: PC_TOWER_DEFAULTS, build: buildPcTower }
};
