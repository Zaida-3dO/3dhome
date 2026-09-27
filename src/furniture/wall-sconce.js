/**
 * wall-sconce.js - wall-mounted light fixtures. One module, one registered
 * type (`wall-sconce`), two visual variants selected by `params.kind`:
 *
 *   'swing-arm-globe' (default) - round brass wall plate, a brass arm
 *     projecting out and down, a brass cap and a smoked/amber glass globe
 *     shade hanging below with a visible bulb.
 *
 *   'up-down' - a flat rectangular wall light (see photo
 *     hallway-ceiling-light-2.jpg): a rounded-corner backplate on the wall, a
 *     smaller rectangular body standing proud of it, and a round lens
 *     protruding from the body's top and bottom, each beaming up/down when on.
 *
 * Builder contract (see plan artifact 029b34e0 on item 78f2b614):
 *   ESM, THREE injected. Exports TYPE, DEFAULTS (frozen, cm, with numeric
 *   width/height/depth) and build(THREE, params, {detail}) returning a
 *   THREE.Group in METRES. y=0 is the bottom, x is centred, the back face
 *   sits at z=0 and the front faces +z (the same local frame as
 *   wall-fittings.js placeOnWall/localXSign). `detail` is 'full' or 'low'.
 *
 * Finish contract (plan review finding #3, item 78f2b614): every mesh is
 * tagged userData.finish from the closed palette {matte, gloss, metal, glass,
 * mirror, emissive} with a flat colour material. userData.keep = true marks
 * the parts that must stay their own draw call: transparent glass and
 * emissive parts (globe, bulb, lenses, beam-cone hints).
 *
 * `on` controls an emissive glow (bulb/lenses) and, for 'up-down', a pair of
 * faint transparent emissive beam-cone hints pointing up and down. NO THREE
 * light is added by this module in either variant -- real light binding (a
 * THREE.PointLight/SpotLight bound to a Home Assistant light entity) is out
 * of scope and comes later via a lights[] schema entry.
 */

export const TYPE = 'wall-sconce';

// DEFAULTS describes the default kind, 'swing-arm-globe'. width/height/depth
// are its overall bounding box at these params (see the drift-test contract
// in scripts/test-furniture-core.mjs on branch feat/furniture-data-layer):
// width = 2*globeDiameter/2 clamps to plateR*2 -- here the globe (15 cm dia)
// is the widest part; height = plate position + plate radius; depth = arm
// projection + globe radius.
export const DEFAULTS = Object.freeze({
  kind: 'swing-arm-globe',
  width: 15,               // cm, widest part (the globe)
  height: 45.95,           // cm, wall plate centre + its radius
  depth: 29.5,             // cm, arm projection + globe radius
  armLength: 22,           // cm, horizontal projection of the arm off the wall
  dropLength: 18,          // cm, vertical drop from the arm to the globe cap
  globeDiameter: 15,       // cm
  metalColor: '#b08d57',   // brass
  glassColor: '#6b4a2a',   // smoked/amber
  on: true
});

// Up/down rectangular wall light (photo: hallway-ceiling-light-2.jpg).
// width/height/depth are the backplate width/height and the overall
// projection off the wall (plate + body + lens), matching the builder
// contract's bbox exactly at these defaults.
export const UP_DOWN_DEFAULTS = Object.freeze({
  kind: 'up-down',
  width: 12,               // cm, backplate width
  height: 20,              // cm, backplate height
  depth: 6,                // cm, plate (1) + body (5); lenses/beams protrude
                           // vertically (top/bottom), not out from the wall
  plateThickness: 1,       // cm
  bodyWidth: 6,            // cm
  bodyHeight: 12,          // cm
  bodyDepth: 5,            // cm
  lensDiameter: 3,         // cm
  lensProtrusion: 1,       // cm, how far each lens stands proud of the body
  metalColor: '#8a5a3c',   // brushed copper/bronze
  on: true
});

/**
 * The DEFAULTS a house item of this `kind` starts from, BEFORE its own
 * params are applied (src/furniture.js calls this when present, item
 * 7c056b3e). Without it an item giving only `{ kind: 'up-down' }` declared
 * the swing-arm globe's 15 x 45.95 x 29.5 envelope and build() stretched the
 * up/down light's backplate to fill it.
 */
export function defaultsFor(params) {
  return (params && params.kind) === 'up-down' ? UP_DOWN_DEFAULTS : DEFAULTS;
}

const CM = 0.01;

const add = (group, mesh, finish, castsShadow) => {
  mesh.userData.finish = finish;
  mesh.castShadow = castsShadow !== false;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
};

const keep = (group, mesh, finish) => {
  mesh.userData.finish = finish;
  mesh.userData.keep = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);
  return mesh;
};

/** Round rectangle THREE.Shape, used for the up-down backplate outline. */
function roundedRectShape(THREE, w, h, r) {
  const shape = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  shape.moveTo(x, y + r);
  shape.lineTo(x, y + h - r);
  shape.quadraticCurveTo(x, y + h, x + r, y + h);
  shape.lineTo(x + w - r, y + h);
  shape.quadraticCurveTo(x + w, y + h, x + w, y + h - r);
  shape.lineTo(x + w, y + r);
  shape.quadraticCurveTo(x + w, y, x + w - r, y);
  shape.lineTo(x + r, y);
  shape.quadraticCurveTo(x, y, x, y + r);
  return shape;
}

function buildSwingArmGlobe(THREE, p, detail) {
  const isLow = detail === 'low';
  const ARM_LEN = p.armLength * CM;
  const DROP = p.dropLength * CM;
  const GLOBE_D = Math.max(0.01, p.globeDiameter * CM);
  const GLOBE_R = GLOBE_D / 2;

  const radialSegs = isLow ? 10 : 20;
  const globeSegs = isLow ? 10 : 16;

  const group = new THREE.Group();
  group.name = 'wallSconce';

  const metalMat = new THREE.MeshStandardMaterial({ color: p.metalColor, roughness: 0.32, metalness: 0.9 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: p.glassColor, roughness: 0.15, metalness: 0,
    transparent: true, opacity: 0.55, side: THREE.DoubleSide
  });
  const bulbColor = p.on ? 0xfff4d6 : 0xdcd2b8;
  const bulbMat = new THREE.MeshStandardMaterial({
    color: bulbColor, emissive: p.on ? 0xffcf7a : 0x000000,
    emissiveIntensity: p.on ? 1.4 : 0, roughness: 0.4, metalness: 0
  });

  // ---- geometry layout, computed top-down so y=0 lands on the globe base ----
  const plateThk = 1.2 * CM;
  const plateR = Math.max(3 * CM, GLOBE_R * 0.7);
  const armR = Math.max(0.7 * CM, plateThk * 0.5);
  const capH = 2.2 * CM;
  const capR = Math.max(armR * 1.4, GLOBE_R * 0.5);

  const globeCenterY = GLOBE_R;
  const globeTopY = GLOBE_D;
  const dropTopY = globeTopY + DROP;
  const plateCenterY = dropTopY + ARM_LEN * 0.35;

  // ---- wall plate: round, flush on the wall (back face at z=0) ----
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(plateR, plateR, plateThk, radialSegs), metalMat);
  plate.rotation.x = Math.PI / 2;
  plate.position.set(0, plateCenterY, plateThk / 2);
  add(group, plate, 'metal').name = 'sconceWallPlate';

  // ---- swing arm: a single straight brass tube from the plate face to the
  // point above the globe, angled down and out from the wall. ----
  const armStart = new THREE.Vector3(0, plateCenterY, plateThk);
  const armEnd = new THREE.Vector3(0, dropTopY, ARM_LEN);
  const armVec = new THREE.Vector3().subVectors(armEnd, armStart);
  const armLenActual = armVec.length();
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(armR, armR, armLenActual, radialSegs), metalMat);
  arm.position.copy(armStart).addScaledVector(armVec, 0.5);
  const armAxis = armVec.clone().normalize();
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), armAxis);
  add(group, arm, 'metal').name = 'sconceArm';

  // ---- drop rod: vertical brass tube from the arm's outer end down to the globe cap ----
  const dropLen = Math.max(0.001, dropTopY - globeTopY);
  const dropRod = new THREE.Mesh(new THREE.CylinderGeometry(armR * 0.8, armR * 0.8, dropLen, radialSegs), metalMat);
  dropRod.position.set(0, globeTopY + dropLen / 2, ARM_LEN);
  add(group, dropRod, 'metal').name = 'sconceDropRod';

  // ---- cap: brass fitting joining the drop rod to the globe ----
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(capR, capR * 0.85, capH, radialSegs), metalMat);
  cap.position.set(0, globeTopY - capH * 0.1, ARM_LEN);
  add(group, cap, 'metal').name = 'sconceCap';

  // ---- globe: smoked/amber glass shade, kept out of the merge ----
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_R, globeSegs, Math.max(8, globeSegs * 0.75)), glassMat);
  globe.position.set(0, globeCenterY, ARM_LEN);
  globe.name = 'sconceGlobe';
  keep(group, globe, 'glass');

  // ---- bulb: visible inside the globe, emissive when on, kept out of the merge ----
  const bulbR = GLOBE_R * 0.4;
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(bulbR, Math.max(8, globeSegs), Math.max(6, globeSegs * 0.6)), bulbMat);
  bulb.position.set(0, globeCenterY, ARM_LEN);
  bulb.name = 'sconceBulb';
  keep(group, bulb, 'emissive');

  return group;
}

function buildUpDown(THREE, p, detail) {
  const isLow = detail === 'low';
  const radialSegs = isLow ? 10 : 20;

  const PLATE_W = p.width * CM;
  const PLATE_H = p.height * CM;
  const PLATE_T = p.plateThickness * CM;
  const BODY_W = p.bodyWidth * CM;
  const BODY_H = p.bodyHeight * CM;
  const BODY_D = p.bodyDepth * CM;
  const LENS_D = Math.max(0.005, p.lensDiameter * CM);
  const LENS_R = LENS_D / 2;
  const LENS_PROTRUSION = p.lensProtrusion * CM;
  const CORNER_R = Math.min(PLATE_W, PLATE_H) * 0.12;

  const group = new THREE.Group();
  group.name = 'wallSconce';

  const metalMat = new THREE.MeshStandardMaterial({ color: p.metalColor, roughness: 0.3, metalness: 0.85 });
  const lensColor = p.on ? 0xfff4d6 : 0xdcd2b8;
  const lensMat = new THREE.MeshStandardMaterial({
    color: lensColor, emissive: p.on ? 0xffcf7a : 0x000000,
    emissiveIntensity: p.on ? 1.4 : 0, roughness: 0.35, metalness: 0
  });
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffcf7a, transparent: true, opacity: p.on ? 0.16 : 0,
    depthWrite: false, side: THREE.DoubleSide
  });

  // ---- layout: y=0 at the backplate's bottom edge; centred on x; back at
  // z=0. Every part (including the beam-cone hints) is budgeted to stay
  // inside the declared width/height/depth bbox -- the builder contract
  // checks the WHOLE group's bounds against DEFAULTS/UP_DOWN_DEFAULTS. ----
  const plateCenterY = PLATE_H / 2;
  const bodyCenterY = plateCenterY; // body centred on the plate vertically
  const lensZ = PLATE_T + BODY_D / 2;

  // ---- backplate: rounded-corner flat plate on the wall ----
  const plateShape = roundedRectShape(THREE, PLATE_W, PLATE_H, CORNER_R);
  const plateGeo = new THREE.ExtrudeGeometry(plateShape, { depth: PLATE_T, bevelEnabled: false, curveSegments: isLow ? 2 : 6 });
  const plate = new THREE.Mesh(plateGeo, metalMat);
  plate.position.set(0, plateCenterY, 0);
  add(group, plate, 'metal').name = 'sconceBackplate';

  // ---- body: smaller rectangular box standing off the plate, slightly rounded edges ----
  const bodyGeo = new THREE.BoxGeometry(BODY_W, BODY_H, BODY_D, 1, 1, 1);
  const body = new THREE.Mesh(bodyGeo, metalMat);
  body.position.set(0, bodyCenterY, PLATE_T + BODY_D / 2);
  add(group, body, 'metal').name = 'sconceBody';

  // ---- lenses: round emitters protruding from the body's top and bottom.
  // Protrusion is capped to whatever headroom is left inside the plate's
  // height, so a large lensProtrusion param cannot push the bbox past
  // height/depth. ----
  const lensTopY = bodyCenterY + BODY_H / 2;
  const lensBotY = bodyCenterY - BODY_H / 2;
  const topHeadroom = Math.max(0, PLATE_H - lensTopY);
  const botHeadroom = Math.max(0, lensBotY);
  const depthHeadroom = Math.max(0.002, (p.depth * CM) - lensZ - LENS_R);
  const lensProtrusion = Math.max(0.002, Math.min(LENS_PROTRUSION, topHeadroom, botHeadroom, depthHeadroom));

  const topLens = new THREE.Mesh(
    new THREE.CylinderGeometry(LENS_R, LENS_R, lensProtrusion, radialSegs), lensMat);
  topLens.position.set(0, lensTopY + lensProtrusion / 2, lensZ);
  topLens.name = 'sconceLensTop';
  keep(group, topLens, 'emissive');

  const botLens = new THREE.Mesh(
    new THREE.CylinderGeometry(LENS_R, LENS_R, lensProtrusion, radialSegs), lensMat);
  botLens.position.set(0, lensBotY - lensProtrusion / 2, lensZ);
  botLens.name = 'sconceLensBottom';
  keep(group, botLens, 'emissive');

  // ---- faint up/down beam-cone hints: transparent emissive, kept, cheap.
  // Sized to fit in the remaining headroom above/below the lenses, so they
  // read as a soft glow hint without growing the fixture's declared bbox. ----
  const beamTopLen = Math.max(0.001, topHeadroom - lensProtrusion);
  const beamBotLen = Math.max(0.001, botHeadroom - lensProtrusion);
  const beamR = LENS_R * 1.6;

  const beamTop = new THREE.Mesh(
    new THREE.ConeGeometry(beamR, beamTopLen, Math.max(6, radialSegs * 0.5), 1, true), beamMat);
  beamTop.position.set(0, lensTopY + lensProtrusion + beamTopLen / 2, lensZ);
  beamTop.name = 'sconceBeamUp';
  keep(group, beamTop, 'emissive');

  const beamBot = new THREE.Mesh(
    new THREE.ConeGeometry(beamR, beamBotLen, Math.max(6, radialSegs * 0.5), 1, true), beamMat);
  beamBot.rotation.x = Math.PI;
  beamBot.position.set(0, lensBotY - lensProtrusion - beamBotLen / 2, lensZ);
  beamBot.name = 'sconceBeamDown';
  keep(group, beamBot, 'emissive');

  return group;
}

/**
 * Build a wall sconce. Returns a THREE.Group. Variant is selected by
 * `params.kind` ('swing-arm-globe' default, or 'up-down'); an unrecognised
 * kind falls back to 'swing-arm-globe' rather than throwing.
 * @param {object} THREE   the injected three.js module
 * @param {object} params  overrides merged onto DEFAULTS by the caller
 * @param {object} [opts]  { detail: 'full'|'low' } -- 'low' drops
 *                         cylinder/sphere/cone segment counts.
 */
export function build(THREE, params, opts) {
  const kind = (params && params.kind) || DEFAULTS.kind;
  const base = kind === 'up-down' ? UP_DOWN_DEFAULTS : DEFAULTS;
  const p = Object.assign({}, base, params);
  const detail = (opts && opts.detail) || 'full';

  if (p.kind === 'up-down') return buildUpDown(THREE, p, detail);
  return buildSwingArmGlobe(THREE, p, detail);
}
