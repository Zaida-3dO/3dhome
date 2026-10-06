/**
 * smart-display.js - a countertop smart display: a tilted-back screen on a
 * fabric speaker base. One `kind` each for two Google products:
 *
 *   'nest-hub-max' (default)  Google Nest Hub Max, 10" screen, camera dot at
 *                             the top centre of the bezel.
 *                             250 x 101 x 183 mm (W x D x H).
 *   'nest-hub'                Google Nest Hub (2nd gen), 7" screen, no
 *                             camera. 177.4 x 69.8 x 120.5 mm.
 *   'nest-mini-stand'         Google Nest Mini (a 98 mm x 42 mm fabric puck)
 *                             held upright, facing forward, in a curved
 *                             cradle on a post and round base disc (the
 *                             common aftermarket "desk stand"). About 15 cm
 *                             tall; the stand is a generic one, so its
 *                             dimensions are illustrative (98 x 42 mm is
 *                             Google's published size of the Mini itself).
 *
 * SOURCE of the dimensions: Google's published specs, as quoted by Wikipedia's
 * "Google Nest Hub" article (Max: 3.99 in deep, 9.85 in wide, 7.19 in high =
 * 101 x 250 x 183 mm) and Google's Nest Hub (2nd gen) tech specs
 * (177.4 x 120.5 x 69.8 mm). Both are MEASURED products, so width, depth and
 * height are `fixed` in CONTROLS: the kind sets them.
 *
 * THE BUILDER CONTRACT (see docs/house-profile.md, "Furniture"): pure ESM,
 * THREE injected; exports TYPE, DEFAULTS (frozen, cm), build(THREE, params,
 * { detail }) -> Group. Local frame in METRES: y = 0 is the item's bottom,
 * x centred along the width, the BACK is at z = 0 and the front faces +z. The
 * bounding box is EXACTLY width x depth x height.
 *
 * LOOK. A wide, rounded, fabric-covered speaker base (matte) the full depth of
 * the envelope; on it a slim rounded slab leans back by a few degrees, its
 * bottom edge sunk into the base, its top reaching exactly `height`. The slab
 * has a bezel in the colourway's front colour (white for Chalk, near-black for
 * Charcoal -- the real units differ) and, inset in it, the screen: an
 * `emissive` part, near-black while `screenOn` is false, a dim warm
 * photo-frame glow while true. It adds no light to the room (an emissive
 * finish never does). The Max also has a camera dot at the top centre.
 *
 * NOW PLAYING. The screen is a dynamic part tagged `hubScreen`: while the
 * media_player the item opens the sound menu for (rooms.json
 * sensors.soundMenu.openFrom) is `playing`, the scene draws its artwork and
 * title on it (src/furniture/hub-screen.js). Otherwise it is the look above.
 *
 * PERF. Small item: one extruded rounded slab, one rounded base, a screen
 * box and a tiny camera cylinder. See scripts/test-smart-display.mjs for the
 * triangle caps.
 *
 * ELEVATION. The item stands on its own bottom; to put it on a cabinet give
 * the placement an `elevation` equal to the cabinet's top height.
 */
import { makeFinish } from './finishes.js';
import { select, toggle, color, unsupported, only } from './controls.js';
import { hubBlankTexture } from './hub-screen.js';

const HUBS = ['nest-hub-max', 'nest-hub'];

export const TYPE = 'smart-display';

const COMMON = {
  kind: 'nest-hub-max',   // 'nest-hub-max' | 'nest-hub'
  colorway: 'chalk',      // 'chalk' | 'charcoal'
  screenOn: false,        // false: dark glass; true: dim photo-frame glow
  screenColor: '#6a645a', // the glow's tint while screenOn (an emissive colour)
  standColor: 'black',    // nest-mini-stand only: 'black' | 'silver' | 'white'
  leds: false             // nest-mini-stand only: the four tiny status dots
};

export const DEFAULTS = Object.freeze(Object.assign({
  width: 25,
  depth: 10.1,
  height: 18.3
}, COMMON));

const HUB_DEFAULTS = Object.freeze(Object.assign({
  width: 17.74,
  depth: 6.98,
  height: 12.05
}, COMMON, { kind: 'nest-hub' }));

const MINI_DEFAULTS = Object.freeze(Object.assign({
  width: 9.8,
  depth: 8,
  height: 15
}, COMMON, { kind: 'nest-mini-stand', colorway: 'charcoal' }));

/** The DEFAULTS a house item of this `kind` starts from (see wall-clock.js). */
export function defaultsFor(params) {
  const k = params && params.kind;
  return k === 'nest-hub' ? HUB_DEFAULTS : k === 'nest-mini-stand' ? MINI_DEFAULTS : DEFAULTS;
}

// Per-kind proportions, as fractions of the envelope.
const KINDS = {
  'nest-hub-max': { baseFrac: 0.30, bezelSide: 0.05, bezelTop: 0.1, bezelBot: 0.07, tilt: 8, camera: true },
  'nest-hub':     { baseFrac: 0.32, bezelSide: 0.05, bezelTop: 0.08, bezelBot: 0.1, tilt: 8, camera: false }
};

const COLORWAYS = {
  chalk:    { fabric: '#cdcdc8', front: '#ecece8' },
  charcoal: { fabric: '#4b4c50', front: '#1c1c1f' }
};

const SCREEN_OFF = '#0a0c10';
const GAP = 0.0015;   // the screen stands this proud of the slab's front face, m

const num = (v, fb) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : fb);

function rrShape(THREE, w, h, r) {
  r = Math.max(1e-4, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4));
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, 0);
  s.lineTo(w / 2 - r, 0);
  s.quadraticCurveTo(w / 2, 0, w / 2, r);
  s.lineTo(w / 2, h - r);
  s.quadraticCurveTo(w / 2, h, w / 2 - r, h);
  s.lineTo(-w / 2 + r, h);
  s.quadraticCurveTo(-w / 2, h, -w / 2, h - r);
  s.lineTo(-w / 2, r);
  s.quadraticCurveTo(-w / 2, 0, -w / 2 + r, 0);
  return s;
}

const STANDS = {
  black:  { color: '#1f1f22', finish: 'matte' },
  silver: { color: '#b9bbbe', finish: 'satin' },
  white:  { color: '#eeeeeb', finish: 'satin' }
};

/**
 * The Nest Mini on its desk stand. Local frame as above: the base disc's back
 * at z = 0 and its diameter = depth; the puck (width = its diameter) stands
 * over the post, its top at y = height, facing +z.
 */
function buildMiniStand(THREE, p, low) {
  const cw = COLORWAYS[p.colorway] || COLORWAYS.charcoal;
  const st = STANDS[p.standColor] || STANDS.black;
  if (!STANDS[p.standColor]) console.warn('[smart-display] unknown standColor "' + p.standColor + '", using black');
  const W = num(p.width, MINI_DEFAULTS.width) * 0.01;
  const D = num(p.depth, MINI_DEFAULTS.depth) * 0.01;
  const H = num(p.height, MINI_DEFAULTS.height) * 0.01;
  const R = W / 2;                       // puck radius
  const ph = Math.min(R * 0.86, D * 0.9);  // puck thickness (42 mm of 98 mm)
  const cy = Math.max(H - R, R * 0.5);   // puck centre height
  const cz = D / 2;                      // over the post
  const g = new THREE.Group();
  g.name = 'furniture:smart-display';
  const seg = low ? 8 : 24;
  const stMat = makeFinish(THREE, st.finish, st.color);

  const baseT = Math.min(0.006, H * 0.05);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(D / 2, D / 2 * 0.98, baseT, seg), stMat);
  base.position.set(0, baseT / 2, cz);
  base.name = 'miniStandBase';
  g.add(base);

  // Cradle: a thin arc band under the puck (annulus sector, extruded along z).
  const ro = R * 1.05, ri = R * 1.005, half = 65 * Math.PI / 180, bandW = Math.min(ph * 0.4, 0.016);
  const sh = new THREE.Shape();
  sh.absarc(0, 0, ro, -Math.PI / 2 - half, -Math.PI / 2 + half, false);
  sh.absarc(0, 0, ri, -Math.PI / 2 + half, -Math.PI / 2 - half, true);
  const bandGeo = new THREE.ExtrudeGeometry(sh, { depth: bandW, curveSegments: low ? 5 : 14, bevelEnabled: false });
  bandGeo.translate(0, cy, cz - bandW / 2);
  const band = new THREE.Mesh(bandGeo, stMat);
  band.name = 'miniStandCradle';
  g.add(band);

  // Post: from the base up into the cradle's lowest point.
  const postBot = baseT, postTop = cy - ro + 0.002;
  const postR = Math.min(0.011, R * 0.25);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(postR, postR, Math.max(postTop - postBot, 0.002), low ? 8 : 12), stMat);
  post.position.set(0, (postTop + postBot) / 2, cz);
  post.name = 'miniStandPost';
  g.add(post);

  // The puck: a lathe profile (rounded edge), axis turned to z.
  const e = Math.min(0.006, ph * 0.3, R * 0.3), hh = ph / 2;
  const prof = [[0, -hh], [R - e, -hh], [R - e * 0.3, -hh + e * 0.3], [R, -hh + e],
    [R, hh - e], [R - e * 0.3, hh - e * 0.3], [R - e, hh], [0, hh]].map(a => new THREE.Vector2(a[0], a[1]));
  const pg = new THREE.LatheGeometry(prof, low ? 12 : 24);
  pg.rotateX(Math.PI / 2);
  pg.translate(0, cy, cz);
  const puck = new THREE.Mesh(pg, makeFinish(THREE, 'matte', cw.fabric));
  puck.name = 'miniPuck';
  g.add(puck);

  if (p.leds) {
    const cols = ['#9ec5ff', '#ff8f9a', '#ffd76a', '#8fe3b0'];
    const r = R * 0.016, pitch = R * 0.19;
    cols.forEach((c, i) => {
      const geo = new THREE.CylinderGeometry(r, r, 0.0008, 5);
      geo.rotateX(Math.PI / 2);
      geo.translate((i - 1.5) * pitch, cy + R * 0.12, cz + hh + 0.0004 - 0.0002);
      const led = new THREE.Mesh(geo, makeFinish(THREE, 'emissive', c));
      led.name = 'miniLed';
      led.userData.keep = true;
      g.add(led);
    });
  }
  return g;
}

export function build(THREE, params, opts) {
  if (params && params.kind === 'nest-mini-stand') {
    return buildMiniStand(THREE, Object.assign({}, MINI_DEFAULTS, params), !!(opts && opts.detail === 'low'));
  }
  const p = Object.assign({}, defaultsFor(params), params || {});
  const low = !!(opts && opts.detail === 'low');
  const k = KINDS[p.kind] || KINDS['nest-hub-max'];
  if (!KINDS[p.kind]) console.warn('[smart-display] unknown kind "' + p.kind + '", using nest-hub-max');
  const cw = COLORWAYS[p.colorway] || COLORWAYS.chalk;
  if (!COLORWAYS[p.colorway]) console.warn('[smart-display] unknown colorway "' + p.colorway + '", using chalk');

  const W = num(p.width, DEFAULTS.width) * 0.01;
  const D = num(p.depth, DEFAULTS.depth) * 0.01;
  const H = num(p.height, DEFAULTS.height) * 0.01;
  const seg = low ? 1 : 5;

  const g = new THREE.Group();
  g.name = 'furniture:smart-display';

  // ---- the fabric speaker base: back at z = 0, full depth, bottom at y = 0.
  const baseH = H * k.baseFrac;
  const baseMat = makeFinish(THREE, 'matte', cw.fabric);
  {
    // Plan outline: a rounded rectangle W x D, extruded up baseH, with the
    // top and bottom edges softened at full detail.
    const r = Math.min(D * 0.45, W * 0.2);
    const s = rrShape(THREE, W, D, r);
    const b = low ? 0 : Math.min(baseH * 0.25, r * 0.5);
    const geo = b > 1e-5
      ? new THREE.ExtrudeGeometry(s, { depth: baseH - 2 * b, curveSegments: seg, bevelEnabled: true,
        bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1 }).translate(0, 0, b)
      : new THREE.ExtrudeGeometry(s, { depth: baseH, curveSegments: seg, bevelEnabled: false });
    // shape y (0..D) -> world z (0..D); extrusion z (0..baseH) -> world y.
    geo.rotateX(-Math.PI / 2);   // (x, y, z) -> (x, z, -y)
    geo.translate(0, 0, D);      // -y in 0..-D  ->  z in D..0
    const base = new THREE.Mesh(geo, baseMat);
    base.name = 'smartDisplayBase';
    g.add(base);
  }

  // ---- the leaning slab (bezel + screen + camera), pivoting about its
  // bottom front edge. Its top-front corner must land at y = H, and its back
  // must stay at z >= 0, so the tilt is clamped to what the depth allows.
  const t = D * 0.2;                        // slab thickness
  const inset = D * 0.08;                   // front of the slab, back from the base's front
  const zf = D - inset;                     // pivot z
  const y0 = baseH * 0.8;                   // pivot height: sunk into the base
  let tilt = k.tilt * Math.PI / 180;
  // hs = (H - y0) / cos(tilt); the top-back corner sits at zf - t - hs sin(tilt).
  for (let i = 0; i < 12; i++) {
    const hs = (H - y0) / Math.cos(tilt);
    if (zf - t - hs * Math.sin(tilt) >= 0.0005) break;
    tilt *= 0.7;
  }
  const hs = (H - y0) / Math.cos(tilt);

  const slab = new THREE.Group();
  slab.name = 'smartDisplaySlab';
  slab.position.set(0, y0, zf);
  slab.rotation.x = -tilt;                  // top leans back (towards -z)
  g.add(slab);

  const frontMat = makeFinish(THREE, 'satin', cw.front);
  {
    const geo = new THREE.ExtrudeGeometry(rrShape(THREE, W, hs, Math.min(W, hs) * 0.08),
      { depth: t - GAP, curveSegments: low ? 1 : 4, bevelEnabled: false });
    geo.translate(0, 0, -t);               // spans z = -t .. -GAP
    const body = new THREE.Mesh(geo, frontMat);
    body.name = 'smartDisplayBezel';
    slab.add(body);
  }

  const bezSide = W * k.bezelSide, bezTop = hs * k.bezelTop, bezBot = hs * k.bezelBot;
  const sw = Math.max(W - 2 * bezSide, 0.005);
  const sh = Math.max(hs - bezTop - bezBot, 0.005);
  const screenMat = makeFinish(THREE, 'emissive', p.screenOn ? p.screenColor : SCREEN_OFF);
  // NOW PLAYING (src/furniture/hub-screen.js): the scene draws the speaker's
  // artwork and title on this screen while it plays, and restores the look
  // below (hubOff) when it stops. The map is a 1x1 white stand-in until then,
  // so the material's program never changes between the two.
  screenMat.emissiveMap = hubBlankTexture(THREE);
  screenMat.userData.hubOff = { color: screenMat.color.getHex(), emissive: screenMat.emissive.getHex(),
    intensity: screenMat.emissiveIntensity };
  screenMat.userData.hubMode = 'idle';
  {
    const geo = new THREE.BoxGeometry(sw, sh, 0.004);
    geo.translate(0, bezBot + sh / 2, -GAP + 0.0005 - 0.002 + 0.0015);   // front face at +0.0005 past the bezel face
    const screen = new THREE.Mesh(geo, screenMat);
    screen.name = 'smartDisplayScreen';
    screen.userData.keep = true;
    // Its own live mesh (never merged), so the scene can draw on it per item.
    screen.userData.dynamic = true;
    screen.userData.hubScreen = true;
    screen.userData.hubAspect = sw / sh;
    slab.add(screen);
  }

  if (k.camera) {
    const r = Math.min(W, hs) * 0.012;
    const geo = new THREE.CylinderGeometry(r, r, 0.0015, low ? 6 : 12);
    geo.rotateX(Math.PI / 2);              // axis along z
    geo.translate(0, hs - bezTop / 2, -GAP + 0.00075);
    const cam = new THREE.Mesh(geo, makeFinish(THREE, 'gloss', '#07070a'));
    cam.name = 'smartDisplayCamera';
    slab.add(cam);
  }

  return g;
}

// ---- edit-mode controls ---------------------------------------------------------
export const CONTROLS = [
  select('kind', 'Model', [
    { value: 'nest-hub-max', label: 'Nest Hub Max (10")' },
    { value: 'nest-hub', label: 'Nest Hub 2nd gen (7")' },
    { value: 'nest-mini-stand', label: 'Nest Mini on desk stand' }
  ]),
  select('colorway', 'Colour', [
    { value: 'chalk', label: 'Chalk' },
    { value: 'charcoal', label: 'Charcoal' }
  ]),
  only(toggle('screenOn', 'Screen on (ambient glow)'), { kinds: HUBS }),
  only(color('screenColor', 'Glow colour'), { kinds: HUBS }),
  only(select('standColor', 'Stand', ['black', 'silver', 'white']), { kinds: ['nest-mini-stand'] }),
  only(toggle('leds', 'Status dots'), { kinds: ['nest-mini-stand'] }),
  unsupported('width', 'Width', 'fixed'),
  unsupported('depth', 'Depth', 'fixed'),
  unsupported('height', 'Height', 'fixed')
];

export const CONTROL_RULES = { screenColor: { when: { screenOn: true } } };
