#!/usr/bin/env node
/**
 * small-items.js: geometry decisions a contract-gate screenshot cannot pin.
 * No framework, no install: `node scripts/test-small-items.mjs`.
 *
 * scripts/test-furniture-core.mjs already checks the generic builder
 * contract (bbox at DEFAULTS, finish tags, no-three, low<=full triangles)
 * for every registered type. This file goes further, the way
 * scripts/test-wall-panels.mjs does for its own module:
 *
 *   1. EVERY type x kind/preset x {full, low} detail combination this
 *      module actually offers (mirroring specs/SmallItemsSpec.html's own
 *      preset list) builds to a bounding box that equals its OWN params
 *      (not just DEFAULTS) within 0.5cm on every axis, including the
 *      ENVELOPE rules: a stand, riser, stacked `levels` or draped coats
 *      must be described by (not exceed) the params passed in, per the
 *      "no deliberate breaks" rule -- the params describe the full
 *      envelope, so a correctly-configured preset always fits exactly.
 *   2. Every one of those builds has its back at z=0, bottom at y=0, and
 *      is centred on x=0 -- the shared furniture frame contract.
 *   3. FACING: for the shape whose plan tapers (the wall-trapezoid
 *      speaker), the WIDE edge is the one at z=0 (the wall)
 *      and the NARROW edge/point is at z=depth (into the room) -- checked
 *      by sampling the actual built geometry's cross-section widths at
 *      z~=0 and z~=depth, not by trusting a comment.
 *
 * MUTATION CHECK: this file's own checkContract() calls a deliberately
 * broken builder (backwards facing, envelope overflow, off-centre) at the
 * bottom and asserts every category of check above actually trips. A test
 * that cannot fail is not a test.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const SI = await imp('src/furniture/small-items.js');
const Fin = await imp('src/furniture/finishes.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;

function bboxCm(group) {
  group.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(group);
  return {
    minX: b.min.x * 100, maxX: b.max.x * 100,
    minY: b.min.y * 100, maxY: b.max.y * 100,
    minZ: b.min.z * 100, maxZ: b.max.z * 100
  };
}

/** The x-extent (cm) of every mesh vertex whose z is within `eps` cm of
 * `zTargetCm` -- used to sample a tapered plan's width at its two ends
 * without assuming which end is which. */
function widthAtZ(group, zTargetCm, epsCm = 0.6) {
  group.updateMatrixWorld(true);
  const zTarget = zTargetCm / 100, eps = epsCm / 100;
  let minX = Infinity, maxX = -Infinity, found = false;
  group.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry;
    const pos = geo.attributes.position;
    if (!pos) return;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      v.applyMatrix4(o.matrixWorld);
      if (Math.abs(v.z - zTarget) <= eps) {
        found = true;
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
      }
    }
  });
  if (!found) return null;
  return (maxX - minX) * 100;
}

/**
 * The full contract for one built group against its OWN resolved params
 * (not DEFAULTS) -- bbox equals params exactly (envelope included), back at
 * z=0, bottom at y=0, x centred. Returns the built group and its bbox for
 * any extra type-specific checks (e.g. facing) the caller wants to layer on.
 */
function checkEnvelope(tag, build, p, opts) {
  let g;
  try {
    g = build(THREE, p, opts || { detail: 'full' });
  } catch (e) {
    check(tag + ': builds without throwing', false, String(e && e.stack || e));
    return null;
  }
  check(tag + ': build() returns a THREE.Group', !!g && g.isGroup === true);
  if (!g || !g.isObject3D) return null;
  const b = bboxCm(g);
  check(tag + ': width == params within 0.5cm', near(b.maxX - b.minX, p.width), { bbox: b, width: p.width });
  check(tag + ': height == params within 0.5cm', near(b.maxY - b.minY, p.height), { bbox: b, height: p.height });
  check(tag + ': depth == params within 0.5cm', near(b.maxZ - b.minZ, p.depth), { bbox: b, depth: p.depth });
  check(tag + ': back at z=0', near(b.minZ, 0), b);
  check(tag + ': bottom at y=0', near(b.minY, 0), b);
  check(tag + ': centred on x=0', near((b.maxX + b.minX) / 2, 0), b);
  return { group: g, bbox: b };
}

/** Facing: the WIDE edge must be at z=0 (the wall), the NARROW edge/point at
 * z=depth (into the room). Verified by sampling actual vertex positions at
 * both ends, not by reading a comment. */
function checkFacing(tag, group, depthCm, wideCm, narrowCm) {
  const wAtBack = widthAtZ(group, 0);
  const wAtFront = widthAtZ(group, depthCm);
  check(tag + ': has geometry at z=0 (the back)', wAtBack !== null, wAtBack);
  check(tag + ': has geometry at z=depth (the front)', wAtFront !== null, wAtFront);
  if (wAtBack === null || wAtFront === null) return;
  check(tag + ': WIDE edge (' + wideCm + 'cm) is at z=0 (the wall)', near(wAtBack, wideCm, 1), { wAtBack, wideCm });
  check(tag + ': NARROW edge/point (' + narrowCm + 'cm) is at z=depth (the room)', near(wAtFront, narrowCm, 1), { wAtFront, narrowCm });
}

// ============================================================================
// Every type x preset this module offers, mirroring specs/SmallItemsSpec.html.
// Each entry: { tag, type, params (FULL resolved params, envelope included) }.
// ============================================================================
const T = SI.TYPES;
function paramsFor(type, delta) {
  return Object.assign({}, T[type].DEFAULTS, delta || {});
}

const CASES = [
  // ---- tv ----
  ['tv: flat, thin bezel', 'tv', paramsFor('tv')],
  ['tv: flat, on pedestal stand', 'tv', paramsFor('tv', {
    stand: true, height: T.tv.DEFAULTS.height + T.tv.DEFAULTS.standHeight, depth: T.tv.DEFAULTS.standDepth
  })],
  ['tv: picture-frame (art mode)', 'tv', paramsFor('tv', { bezelStyle: 'picture-frame' })],

  // ---- photo-frame ----
  ['photo-frame: single panel', 'photo-frame', paramsFor('photo-frame')],
  ['photo-frame: hallway pair', 'photo-frame', paramsFor('photo-frame', { width: 60, height: 50 })],
  ['photo-frame: living-room 4-photo', 'photo-frame', paramsFor('photo-frame', { width: 140, height: 40, panels: 4 })],
  ['photo-frame: office 5-panel', 'photo-frame', paramsFor('photo-frame', { width: 250, height: 60, panels: 5 })],

  // ---- speaker ----
  ['speaker: wall (trapezoid)', 'speaker', paramsFor('speaker')],
  ['speaker: wall (box)', 'speaker', paramsFor('speaker', { boxShape: true })],
  ['speaker: floor-standing', 'speaker', paramsFor('speaker', { kind: 'floor-standing', width: 16.5, depth: 24, height: 90 })],
  ['speaker: floor-standing white satin', 'speaker', paramsFor('speaker', { kind: 'floor-standing', width: 16.5, depth: 24, height: 90, finish: 'gloss', color: '#f4f4f2' })],
  ['speaker: ceiling down-firing', 'speaker', paramsFor('speaker', { kind: 'ceiling', width: 18.5, depth: 18.5, height: 31, firing: 'down' })],
  ['speaker: ceiling angled', 'speaker', paramsFor('speaker', { kind: 'ceiling', width: 18.5, depth: 18.5, height: 31, firing: 'angled' })],
  ['speaker: centre channel', 'speaker', paramsFor('speaker', { kind: 'centre', width: 45, depth: 20, height: 16.5 })],

  // ---- subwoofer ----
  ['subwoofer: default', 'subwoofer', paramsFor('subwoofer')],

  // ---- tube-floor-lamp ----
  ['tube-floor-lamp: all-round glow', 'tube-floor-lamp', paramsFor('tube-floor-lamp')],
  ['tube-floor-lamp: one-sided glow', 'tube-floor-lamp', paramsFor('tube-floor-lamp', { oneSidedGlow: true })],

  // ---- coat-rack: envelope = rail band + coat drop ----
  ['coat-rack: empty rail', 'coat-rack', paramsFor('coat-rack')],
  ['coat-rack: one coat', 'coat-rack', paramsFor('coat-rack', { coats: 1, height: 10 + 55 })],
  ['coat-rack: three coats', 'coat-rack', paramsFor('coat-rack', { coats: 3, height: 10 + 55 })],

  // ---- mirror ----
  ['mirror: rectangle', 'mirror', paramsFor('mirror')],
  ['mirror: round', 'mirror', paramsFor('mirror', { shape: 'round' })],
  ['mirror: pebble', 'mirror', paramsFor('mirror', { shape: 'pebble' })],
  ['mirror: triangle (hallway)', 'mirror', paramsFor('mirror', { shape: 'triangle', width: 55, height: 70 })],

  // ---- shelf: envelope = levels stack height, backPanel is same height ----
  ['shelf: single', 'shelf', paramsFor('shelf')],
  ['shelf: single, LED edge', 'shelf', paramsFor('shelf', { led: true })],
  ['shelf: stacked set of 3', 'shelf', paramsFor('shelf', { levels: [30, 30], height: 5 + 30 + 5 + 30 + 5 })],
  ['shelf: floating shelf with back panel', 'shelf', paramsFor('shelf', { width: 180, depth: 22, height: 20, backPanel: true })],

  // ---- monitor: envelope = stand/riser height, riser depth ----
  ['monitor: flat', 'monitor', paramsFor('monitor')],
  ['monitor: flat, on riser', 'monitor', paramsFor('monitor', { riser: true, depth: 25 })],
  ['monitor: curved super-ultrawide', 'monitor', paramsFor('monitor', { curved: true })],
  ['monitor: curved, on riser', 'monitor', paramsFor('monitor', { curved: true, riser: true, depth: 25 })],

  // ---- pc-tower ----
  ['pc-tower: glass side panel', 'pc-tower', paramsFor('pc-tower')],
  ['pc-tower: no glass panel', 'pc-tower', paramsFor('pc-tower', { glassPanel: false })]
];

for (const [tag, type, p] of CASES) {
  const impl = T[type];
  for (const detail of ['full', 'low']) {
    const fullTag = tag + ' [' + detail + ']';
    const result = checkEnvelope(fullTag, impl.build, p, { detail });
    if (!result) continue;
    const { group } = result;

    // Facing, for the tapered-plan shape.
    if (type === 'speaker' && p.kind === 'wall-trapezoid' && !p.boxShape) {
      checkFacing(fullTag, group, p.depth, p.width, Math.min(p.frontWidth, p.width));
    }

    // Finish/keep tags: every part readable through the same reader the
    // merge uses, and every kept finish actually marked keep.
    const parts = [];
    group.traverse(o => {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => parts.push({ mesh: o, material: m }));
    });
    check(fullTag + ': has meshes', parts.length > 0);
    const badFinish = parts.filter(x => Fin.partFinish(x.mesh, x.material).error);
    check(fullTag + ': every part has a palette finish', badFinish.length === 0,
      badFinish.map(x => Fin.partFinish(x.mesh, x.material).error));
    const unkept = parts.filter(x => {
      const f = Fin.partFinish(x.mesh, x.material).finish;
      return f && Fin.isKeptFinish(f) && Fin.partKeep(x.mesh, x.material).keep !== true;
    });
    check(fullTag + ': glass/mirror/emissive parts are marked keep', unkept.length === 0,
      unkept.map(x => Fin.partFinish(x.mesh, x.material).finish));
  }
}

// ============================================================================
// photo-frame: the injected-texture image panel is tagged AND kept.
// ============================================================================
{
  const fakeTex = { isTexture: true };
  const p = Object.assign({}, T['photo-frame'].DEFAULTS, {
    image: 'art.jpg',
    textureLoader: () => fakeTex
  });
  const g = T['photo-frame'].build(THREE, p, { detail: 'full' });
  let texturedPart = null;
  g.traverse(o => {
    if (o.isMesh && o.material && o.material.map === fakeTex) texturedPart = o;
  });
  check('photo-frame: textureLoader is actually used when image + loader are set', !!texturedPart);
  if (texturedPart) {
    const r = Fin.partFinish(texturedPart, texturedPart.material);
    check('photo-frame: textured panel has a palette finish tag', r.finish !== null, r);
    const k = Fin.partKeep(texturedPart, texturedPart.material);
    check('photo-frame: textured panel is marked keep', k.keep === true, k);
  }
}

// ============================================================================
// clock and wall-art are GONE: removed types must not resolve.
// ============================================================================
{
  check('clock: removed from TYPES', !T['clock']);
  check('wall-art: removed from TYPES', !T['wall-art']);
}

// ============================================================================
// Speakers and the subwoofer (item e82cdd83): a grille, VISIBLE drivers, a
// front rim and a port -- inside their triangle caps.
// ============================================================================
function named(group, name) {
  const out = [];
  group.traverse(o => { if (o.isMesh && o.name === name) out.push(o); });
  return out;
}
function meshBox(o) { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o); }
function triCount(group) {
  let n = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry;
    n += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return n;
}
const SPEAKER_TRI_CAPS = Object.freeze({ full: 1200, low: 80 });

function checkSpeakerFront(tag, type, p, expectPort) {
  const impl = T[type];
  const full = impl.build(THREE, p, { detail: 'full' });
  const low = impl.build(THREE, p, { detail: 'low' });
  full.updateMatrixWorld(true);
  const cab = named(full, 'speakerCabinet');
  check(tag + ': has one cabinet body', cab.length === 1, cab.length);
  if (!cab.length) return;
  const baffleZ = meshBox(cab[0]).max.z;
  const driverParts = ['driverSurround', 'driverCone', 'driverCap', 'tweeterPlate', 'tweeterDome']
    .flatMap(n => named(full, n));
  check(tag + ': has woofer cones', named(full, 'driverCone').length >= 1);
  // VISIBLE: every driver part is in front of the baffle (the old cones sat
  // 1 mm INSIDE the cabinet and could not be seen at all). A surround ring
  // is centred on the baffle plane, so it may reach behind it by its own
  // tube radius, never further.
  const behind = driverParts.filter(o => {
    const b = meshBox(o);
    const centreZ = (b.min.z + b.max.z) / 2;
    return o.name === 'driverSurround' ? centreZ < baffleZ - 1e-6 : b.min.z < baffleZ - 1e-6;
  });
  check(tag + ': every driver part sits on or in front of the baffle', behind.length === 0,
    behind.map(o => [o.name, meshBox(o).min.z, baffleZ]));
  const front = meshBox(full).max.z;
  check(tag + ': every driver part stays behind the front (inside the envelope)',
    driverParts.every(o => meshBox(o).max.z <= front + 1e-6));
  check(tag + ': has a 4-bar front rim', named(full, 'speakerRim').length === 4);
  const grille = named(full, 'speakerGrille');
  check(tag + ': has a see-through grille (glass finish, kept)', grille.length === 1 &&
    Fin.partFinish(grille[0], grille[0].material).finish === 'glass' && Fin.partKeep(grille[0], grille[0].material).keep === true);
  if (grille.length) check(tag + ': the grille is at the very front', Math.abs(meshBox(grille[0]).max.z - front) < 1e-6);
  if (expectPort) check(tag + ': has a port (ring + mouth)', named(full, 'portRing').length === 1 && named(full, 'portMouth').length === 1);
  const noGrille = impl.build(THREE, Object.assign({}, p, { grille: false }), { detail: 'full' });
  check(tag + ': grille:false drops the grille but keeps the rim', named(noGrille, 'speakerGrille').length === 0 &&
    named(noGrille, 'speakerRim').length === 4);
  if (expectPort) {
    const noPort = impl.build(THREE, Object.assign({}, p, { port: false }), { detail: 'full' });
    check(tag + ': port:false drops the port', named(noPort, 'portRing').length === 0);
  }
  const tf = triCount(full), tl = triCount(low);
  check(tag + ': full triangles within cap', tf <= SPEAKER_TRI_CAPS.full, { tf, cap: SPEAKER_TRI_CAPS.full });
  check(tag + ': low triangles within cap', tl <= SPEAKER_TRI_CAPS.low, { tl, cap: SPEAKER_TRI_CAPS.low });
  check(tag + ': low has no drivers or grille', named(low, 'driverCone').length === 0 && named(low, 'speakerGrille').length === 0);
}
checkSpeakerFront('speaker wall-trapezoid', 'speaker', paramsFor('speaker'), true);
checkSpeakerFront('speaker wall box', 'speaker', paramsFor('speaker', { boxShape: true }), true);
checkSpeakerFront('speaker floor-standing', 'speaker', paramsFor('speaker', { kind: 'floor-standing', width: 16.5, depth: 24, height: 90 }), true);
checkSpeakerFront('speaker centre', 'speaker', paramsFor('speaker', { kind: 'centre', width: 45, depth: 20, height: 16.5 }), false);
checkSpeakerFront('subwoofer', 'subwoofer', paramsFor('subwoofer'), true);
{
  const sub = T.subwoofer.build(THREE, paramsFor('subwoofer'), { detail: 'full' });
  let feet = 0;
  sub.traverse(o => { if (o.isMesh && o.geometry.type === 'CylinderGeometry' && !o.name) feet++; });
  check('subwoofer: stands on four feet', feet === 4, feet);
  check('subwoofer: the cabinet sits on the feet (not on the floor)', meshBox(named(sub, 'speakerCabinet')[0]).min.y > 0.005);
}
// Ceiling speakers: the driver disc sits ON the envelope face it fires from,
// with the box behind it -- not inside the box.
['down', 'angled', 'up'].forEach(firing => {
  const p = paramsFor('speaker', { kind: 'ceiling', width: 18.5, depth: 18.5, height: 31, firing });
  const g = T.speaker.build(THREE, p, { detail: 'full' });
  const drv = named(g, 'driverCone')[0], cab = named(g, 'speakerCabinet')[0];
  const bd = meshBox(drv), bc = meshBox(cab);
  const ok = firing === 'down' ? (bd.max.y <= 1e-6 && bc.min.y >= 0.0015)
    : firing === 'angled' ? (Math.abs(bd.min.z - p.depth / 100) < 1e-6 && bc.max.z <= p.depth / 100 - 0.0015)
      : (Math.abs(bd.min.y - p.height / 100) < 1e-6 && bc.max.y <= p.height / 100 - 0.0015);
  check('speaker ceiling ' + firing + ': driver on the firing face, cabinet behind it', ok, { bd, bc });
});

// ============================================================================
// Tube floor lamp (item e82cdd83): the one-sided version's back is a visible
// tube body, the glow faces the room, and the base has real parts.
// ============================================================================
{
  const p = paramsFor('tube-floor-lamp', { oneSidedGlow: true });
  const g = T['tube-floor-lamp'].build(THREE, p, { detail: 'full' });
  const glow = named(g, 'lampTube'), back = named(g, 'lampTubeBack');
  check('tube lamp one-sided: a glowing half and a body half', glow.length === 1 && back.length === 1);
  if (glow.length && back.length) {
    check('tube lamp one-sided: the glowing half is emissive and kept',
      Fin.partFinish(glow[0], glow[0].material).finish === 'emissive' && Fin.partKeep(glow[0], glow[0].material).keep === true);
    check('tube lamp one-sided: the back half is NOT emissive (it is the lamp body)',
      Fin.partFinish(back[0], back[0].material).finish === p.baseFinish);
    const cz = Math.min(p.width, p.depth) / 200;
    const gb = meshBox(glow[0]), bb = meshBox(back[0]);
    check('tube lamp one-sided: the glow faces the room (+z)', gb.min.z >= cz - 1e-6 && gb.max.z > cz, { gb, cz });
    check('tube lamp one-sided: the body half faces the wall (-z)', bb.max.z <= cz + 1e-6 && bb.min.z < cz, { bb, cz });
  }
  const all = T['tube-floor-lamp'].build(THREE, paramsFor('tube-floor-lamp'), { detail: 'full' });
  check('tube lamp all-round: no body half', named(all, 'lampTubeBack').length === 0 && named(all, 'lampTube').length === 1);
  let baseParts = 0, metalParts = 0;
  all.traverse(o => {
    if (!o.isMesh || o.name) return;
    baseParts++;
    if (Fin.partFinish(o, o.material).finish === 'metal') metalParts++;
  });
  check('tube lamp: the base is designed (foot, chamfer, collar, trim) plus a tube cap', baseParts >= 5 && metalParts >= 2,
    { baseParts, metalParts });
}

// ============================================================================
// wire-shelf is GONE (item e82cdd83): nothing in a house used it.
// ============================================================================
check('wire-shelf: removed from TYPES', !T['wire-shelf']);

// ============================================================================
// tv: `image` param is gone (declared-but-unused was removed, not kept).
// ============================================================================
{
  check('tv: DEFAULTS has no `image` key', !Object.prototype.hasOwnProperty.call(T.tv.DEFAULTS, 'image'), T.tv.DEFAULTS);
}

// ============================================================================
// MUTATION CHECK: this file's own checks must be able to fail. A deliberately
// broken build for each category (backwards facing, envelope overflow,
// off-centre, wrong bottom/back) must trip the corresponding check above.
// ============================================================================
{
  const savedError = console.error;
  const caught = [];
  console.error = m => caught.push(String(m));

  const before = failures;

  // 1. Backwards facing: wide edge at the FRONT instead of the back.
  function backwardsTrapezoid(THREE, p) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    mat.userData.finish = 'matte';
    const backW = p.width / 100, frontW = p.frontWidth / 100, d = p.depth / 100, h = p.height / 100;
    const shape = new THREE.Shape();
    // Deliberately backwards vs. the fixed builder: wide edge ends up at z=d.
    shape.moveTo(-backW / 2, 0); shape.lineTo(backW / 2, 0);
    shape.lineTo(frontW / 2, d); shape.lineTo(-frontW / 2, d); shape.lineTo(-backW / 2, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, d);
    const mesh = new THREE.Mesh(geo, mat);
    g.add(mesh);
    return g;
  }
  const bp = paramsFor('speaker');
  const bg = backwardsTrapezoid(THREE, bp);
  checkFacing('mutation probe: backwards trapezoid', bg, bp.depth, bp.width, bp.frontWidth);

  // 2. Envelope overflow: a "riser" that ignores the declared depth.
  function overflowingRiser(THREE, p) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    mat.userData.finish = 'matte';
    const w = p.width / 100, d = p.depth / 100, h = p.height / 100;
    const geo = new THREE.BoxGeometry(w, h, d * 3); // 3x too deep, on purpose
    geo.translate(0, h / 2, (d * 3) / 2);
    g.add(new THREE.Mesh(geo, mat));
    return g;
  }
  checkEnvelope('mutation probe: overflowing riser', overflowingRiser, paramsFor('monitor', { depth: 25 }), { detail: 'full' });

  // 3. Off-centre / wrong bottom: a box shifted away from x=0 and y=0.
  function offCentre(THREE, p) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    mat.userData.finish = 'matte';
    const w = p.width / 100, d = p.depth / 100, h = p.height / 100;
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(0.05, h / 2 + 0.05, d / 2); // off-centre AND floating
    g.add(new THREE.Mesh(geo, mat));
    return g;
  }
  checkEnvelope('mutation probe: off-centre/floating', offCentre, paramsFor('subwoofer'), { detail: 'full' });

  console.error = savedError;
  const tripped = failures - before;
  failures = before; // the probes' failures are expected, not real findings
  check('mutation check: backwards facing, envelope overflow and off-centre/floating are all caught',
    tripped === 5 && caught.some(m => /WIDE edge/.test(m)) && caught.some(m => /NARROW edge/.test(m)) &&
      caught.some(m => /depth == params/.test(m)) && caught.some(m => /centred on x=0/.test(m)) &&
      caught.some(m => /bottom at y=0/.test(m)),
    { tripped, caughtCount: caught.length, caught });
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
