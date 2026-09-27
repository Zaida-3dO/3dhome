/**
 * strip-light.js - a linear LED strip that reads as ONE long, smooth source.
 *
 * Today (home3d-scene.js addStrip) a strip is an emissive box plus ONE
 * PointLight at its centre: the surface below it gets a round blob, not a
 * line. This module builds a strip four ways behind one `technique` option so
 * they can be compared side by side (specs/StripLightSpec.html) before any of
 * them goes into the house:
 *
 *   'A' baseline    exactly today's look: an emissive, 85%-opaque box
 *                   (default 2.5 x 2.5 cm) and one PointLight at its centre
 *                   (reach 2.5 m, decay 2).
 *   'B' multi-point N dim PointLights spread evenly along the line, the total
 *                   intensity conserved (each is intensity / N), inside a
 *                   frosted diffuser tube.
 *   'C' area        one RectAreaLight the size of the diffuser's face -- three's
 *                   true area light (LTC). Needs RectAreaLightUniformsLib.init()
 *                   ONCE per THREE instance (vendor/three-r160/addons/lights/),
 *                   which the CALLER does: this module never imports three.
 *                   Limits: no shadows, lights MeshStandardMaterial /
 *                   MeshPhysicalMaterial only (Lambert/Phong ignore it), no
 *                   distance cut-off.
 *   'D' zero-light  NO light objects: the diffuser tube plus additive glow
 *                   cards ("washes") on the surface the strip faces and,
 *                   optionally, on the wall behind it. Each card carries the
 *                   irradiance a Lambertian line source with the same flux as
 *                   B/C would put there (closed form, so it is soft along the
 *                   length AND across, with no hard edge anywhere), times the
 *                   albedo of the surface it lies on. Costs no fragment
 *                   uniforms at all -- the low-tier / phone option.
 *
 * AIMED STRIPS (`aim: true`): A's and B's lights become unshadowed
 * SpotLights pointing along `facing` (AIM_ANGLE_DEG), so an up-facing cove
 * lights the ceiling but not the wall BELOW its ledge -- lights are
 * unshadowed here, so a ledge or lip cannot block them. C is one-sided by
 * nature and D paints nothing behind the strip, so the option means the same
 * for all four. A SpotLight costs 7 uniform vectors against a PointLight's 4.
 *
 * THE DIFFUSER (B, C, D): a round frosted tube in an aluminium channel. Its
 * glow is an emissive gradient AROUND the tube (brightest on the side that
 * faces out, milky at the flanks) and perfectly uniform ALONG it, so it reads
 * as one continuous source at any N. It is not lit by its own lights: every
 * light sits on or behind the channel's mounting face (see below), so a
 * light can never draw a hotspot on the tube. No MeshPhysicalMaterial
 * `transmission` -- that adds a whole extra render pass.
 *
 * WHY B's LIGHTS SIT BEHIND THE MOUNTING FACE: a PointLight a centimetre off
 * the cabinet underside it is stuck to lights that underside with ~1/d^2 --
 * a white dot per light, the exact thing this is meant to remove. Setting
 * each light SETBACK_M behind the mounting plane puts every point of that
 * plane behind the light (N.L <= 0), so the plane gets nothing, while
 * everything in front (worktop, wall, floor) is lit as by a line source.
 * Lights are unshadowed, so the cabinet they sit "inside" does not block them.
 *
 * THE FRAME (metres): the strip runs along local X, centred on 0, from
 * -length/2 to +length/2. The group's ORIGIN is the MOUNTING POINT -- the
 * middle of the channel's back, on the surface the strip is stuck to -- and
 * the strip emits along `facing`:
 *   'down'  -Y  under a cabinet / desk / shelf       (default)
 *   'up'    +Y  a cove or cornice washing a ceiling
 *   'front' +Z  a strip on a wall, lighting the room
 *   'back'  -Z  behind a TV / headboard, washing the wall
 * The caller positions and rotates the group like any furniture part.
 *
 * STATE: applyStripState(group, { on, bri 0-100, color '#rrggbb' }) poses a
 * built strip (every light, the tube, the washes) without a rebuild -- the
 * same channel state light-parts.js takes, so the house's syncLights() can
 * drive one shared brightness and colour for every strip. dispose(group)
 * frees everything a strip owns on the GPU.
 *
 * Pure ESM, THREE injected, no DOM: scripts/test-strip-light.mjs builds it
 * with the vendored module in Node.
 */

export const TYPE = 'strip-light';

export const TECHNIQUES = Object.freeze(['A', 'B', 'C', 'D']);

export const TECHNIQUE_LABELS = Object.freeze({
  A: 'A baseline (box + 1 point light)',
  B: 'B multi-point (N point lights)',
  C: 'C area light (RectAreaLight)',
  D: 'D zero-light (glow only)'
});

export const FACINGS = Object.freeze({
  down: Object.freeze([0, -1, 0]),
  up: Object.freeze([0, 1, 0]),
  front: Object.freeze([0, 0, 1]),
  back: Object.freeze([0, 0, -1])
});

/** Frozen defaults, cm (illustrative, not a survey of any fitting). */
export const DEFAULTS = Object.freeze({
  technique: 'B',
  length: 100,          // cm; typical strips range 10..340
  diameter: 1.6,        // cm; the diffuser tube (B/C/D)
  boxSize: Object.freeze([2.5, 2.5]), // cm; A: the box's [height, depth] -- today's addStrip default
  channel: true,        // aluminium U-channel behind the tube (B/C/D)
  facing: 'down',
  n: 6,                 // B: lights along the strip (clamped to 1..MAX_N)
  intensity: 0.3,       // the strip's TOTAL light at bri 100 (today's accent: 0.3)
  reach: 250,           // cm; the point lights' cut-off (today's default 2.5 m)
  color: '#ffb45a',
  bri: 100,
  on: true,
  aim: false,           // A/B: SpotLights along `facing` instead of PointLights
  washDistance: 0,      // cm; D: distance to the surface the strip faces (0 = no card)
  washSpread: 0,        // cm; D: how far the cards reach across the line and past its ends (0 = auto)
  washAlbedo: '#ffffff',// D: colour of the surface the wash card lies on
  backWash: 0,          // cm; D, facing down/up: distance to a wall BEHIND the strip (0 = none)
  backAlbedo: '#ffffff' // D: colour of that wall
});

/** B never builds more lights than this per strip. */
export const MAX_N = 24;
/** How far B's lights sit behind the mounting plane (metres). */
export const SETBACK_M = 0.01;
/** Channel wall thickness / clearance (metres). */
export const CHANNEL_T = 0.002;
/** A lit strip's tube never glows dimmer than this share (a dimmed LED still reads lit). */
export const TUBE_MIN = 0.2;
/** Tube emissive intensity at bri 100 (B/C/D). Baseline A keeps today's 1.5. */
export const TUBE_GLOW = 1.6;
/** A's emissive intensity at bri 100 and its opacity -- today's applyAccent(). */
export const BASELINE_GLOW = 1.5;
export const BASELINE_OPACITY = 0.85;
/**
 * C: radiance x area = AREA_FLUX x the point light's intensity. The analytic
 * half-space flux match: a point light of intensity I sends 2*pi*I into the
 * half-space in front of the strip; a one-sided Lambertian rectangle of
 * radiance Le and area A sends pi*Le*A. (Checked against r160's
 * RE_Direct_RectArea_Physical. On the axis, far away, C therefore reads 2x A
 * -- A spends half its light behind the strip.)
 */
export const AREA_FLUX = 2;
/** D: an overall trim on the physically derived card brightness (1 = as computed). */
export const WASH_GAIN = 1;
/** D: washSpread 0 means this many times the distance to the lit surface, clamped to 5..80 cm. */
export const AUTO_SPREAD = 2.5;
/** A/B with aim: the SpotLights' half-angle (degrees) and penumbra. */
export const AIM_ANGLE_DEG = 80;
export const AIM_PENUMBRA = 0.5;

/**
 * Fragment uniform vectors each light type adds to EVERY lit shader, counted
 * one register per struct member (how ANGLE's D3D backend lays them out and
 * how this repo has always budgeted -- see light-merge.js). A driver that
 * packs GLSL-ES structs tightly (most native GLES phones) uses fewer, so these
 * are an upper bound. RectAreaLight also binds two LTC textures (samplers, not
 * vectors).
 */
export const UNIFORM_VECTORS = Object.freeze({ point: 4, spot: 7, rectArea: 4, directional: 2, hemisphere: 3 });

const CM = 0.01;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Kelvin -> 0xrrggbb, the SAME ramp the house uses for its whites (home3d-scene.js k2h). */
export function kelvinToHex(k) {
  const t = clamp((Number(k) - 2700) / 3800, 0, 1);
  return (Math.round(255 - t * 30) << 16) | (Math.round(215 + t * 30) << 8) | Math.round(160 + t * 90);
}

/** DEFAULTS + params, normalised. Unknown technique/facing fall back with a warning. */
export function resolveParams(params) {
  const p = Object.assign({}, DEFAULTS, params || {});
  if (TECHNIQUES.indexOf(p.technique) === -1) {
    console.warn('[strip-light] unknown technique ' + JSON.stringify(p.technique) + ' -- using "B"');
    p.technique = 'B';
  }
  if (!FACINGS[p.facing]) {
    console.warn('[strip-light] unknown facing ' + JSON.stringify(p.facing) + ' -- using "down"');
    p.facing = 'down';
  }
  p.length = Math.max(1, Number(p.length) || DEFAULTS.length);
  p.diameter = Math.max(0.3, Number(p.diameter) || DEFAULTS.diameter);
  p.n = clamp(Math.round(Number(p.n) || 1), 1, MAX_N);
  p.intensity = Math.max(0, Number(p.intensity) || 0);
  p.reach = Math.max(1, Number(p.reach) || DEFAULTS.reach);
  p.aim = p.aim === true;
  const bs = Array.isArray(p.boxSize) && p.boxSize.length === 2 ? p.boxSize : DEFAULTS.boxSize;
  p.boxSize = [Math.max(0.3, Number(bs[0]) || 2.5), Math.max(0.3, Number(bs[1]) || 2.5)];
  p.washDistance = Math.max(0, Number(p.washDistance) || 0);
  p.backWash = Math.max(0, Number(p.backWash) || 0);
  p.washSpread = Number(p.washSpread) > 0 ? Number(p.washSpread) : clamp(AUTO_SPREAD * p.washDistance, 5, 80);
  return p;
}

/** How many light objects of each type a strip with these params builds. */
export function lightCounts(params) {
  const p = resolveParams(params);
  const punctual = p.technique === 'A' ? 1 : p.technique === 'B' ? p.n : 0;
  return {
    point: p.aim ? 0 : punctual,
    spot: p.aim ? punctual : 0,
    rectArea: p.technique === 'C' ? 1 : 0
  };
}

/** Fragment uniform vectors (upper bound, see UNIFORM_VECTORS) these params add. */
export function uniformVectors(params) {
  const c = lightCounts(params);
  return c.point * UNIFORM_VECTORS.point + c.spot * UNIFORM_VECTORS.spot + c.rectArea * UNIFORM_VECTORS.rectArea;
}

// ---- geometry helpers --------------------------------------------------------

/** A quaternion turning local -Z (a RectAreaLight's emit direction) onto `facing`. */
function facingQuaternion(THREE, f) {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3(f[0], f[1], f[2]));
}

/**
 * The tube's glow texture: a 64x1 gradient around the tube's circumference,
 * brightest where the tube faces out, milky (not dark) at the flanks and
 * back. The cylinder is built along Y then rotated onto X, so its u
 * coordinate runs round the circumference; `faceU` is the u that faces out.
 */
function tubeGlowTexture(THREE, faceU) {
  const W = 64;
  const data = new Uint8Array(W * 4);
  for (let i = 0; i < W; i++) {
    const u = (i + 0.5) / W;
    const a = (u - faceU) * Math.PI * 2;
    const k = 0.45 + 0.55 * Math.pow(Math.max(0, Math.cos(a)), 0.8);
    const v = Math.round(255 * k);
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The integral over s in [-half, half] of 1 / ((x - s)^2 + a)^2, in closed
 * form (a > 0: the squared distance from the line, perpendicular).
 */
export function lineIntegral(x, half, a) {
  const q = Math.sqrt(a);
  const F = u => u / (2 * a * (u * u + a)) + Math.atan(u / q) / (2 * a * q);
  return F(x + half) - F(x - half);
}

/**
 * Irradiance per unit radiant intensity per metre that a Lambertian line
 * source (length L, emitting along `facing`) puts on
 *   'face'  the plane it faces, h away, at (x along, y across);
 *   'back'  a wall b behind it, at (x along, y = depth past the strip's plane),
 * i.e. the line integral of cos(emit) x cos(receive) / r^2.
 */
export function lineIrradiance(kind, L, x, y, h, b) {
  if (kind === 'face') return h * h * lineIntegral(x, L / 2, y * y + h * h);
  return y * b * lineIntegral(x, L / 2, y * y + b * b);
}

/** A smooth window: 1 at t = 0, exactly 0 (with zero slope) at t = 1. */
export function fadeWindow(t) {
  const u = clamp(t, 0, 1);
  return (1 - u * u) * (1 - u * u);
}

/**
 * A glow card's texture: lineIrradiance over the card divided by its peak (so
 * the texture is 0..1 and the absolute peak goes into the material colour),
 * times fadeWindow so it reaches exactly 0 at EVERY card edge.
 *   face: the card spans x in [-L/2 - S, L/2 + S] and y in [-S, S], h away.
 *   back: the same x, and depth y in [0, h] down a wall b behind; texture
 *         row H-1 (v = 1) is the strip's own plane.
 * Returns { tex, peak } -- peak is the unnormalised maximum.
 */
function cardTexture(THREE, kind, L, S, h, b) {
  const W = 128, H = 64;
  const halfW = L / 2 + S;
  const vals = new Float32Array(W * H);
  let peak = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = (i / (W - 1) * 2 - 1) * halfW;       // edge texels sample the edges exactly
      const y = kind === 'face' ? (j / (H - 1) * 2 - 1) * S : (1 - j / (H - 1)) * h;
      const e = lineIrradiance(kind, L, x, y, h, b);
      if (e > peak) peak = e;
      const wx = fadeWindow(Math.max(0, Math.abs(x) - L / 2) / S);
      const wy = kind === 'face' ? fadeWindow(Math.abs(y) / S) : fadeWindow(y / h);
      vals[j * W + i] = e * wx * wy;
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let k = 0; k < W * H; k++) {
    data[k * 4] = 255; data[k * 4 + 1] = 255; data[k * 4 + 2] = 255;
    data[k * 4 + 3] = Math.round(255 * (peak > 0 ? vals[k] / peak : 0));
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, peak };
}

// ---- build -----------------------------------------------------------------------

/**
 * Build one strip.
 *
 * @param {Object} THREE   the three.js namespace
 * @param {Object} params  see DEFAULTS
 * @returns {THREE.Group}  userData.stripLight = the resolved params plus
 *   { lights: [...light objects], tube, wash, washes }. Every light carries
 *   userData.stripShare (its share of the strip's total intensity).
 */
export function build(THREE, params) {
  const p = resolveParams(params);
  const L = p.length * CM;
  const D = p.diameter * CM;
  const R = D / 2;
  const f = FACINGS[p.facing];
  const fv = new THREE.Vector3(f[0], f[1], f[2]);
  const q = facingQuaternion(THREE, f);
  const color = new THREE.Color(p.color);

  const g = new THREE.Group();
  g.name = 'stripLight';
  const lights = [];
  let tube = null, wash = null;
  const washes = [];

  // The tube's centre: out from the mounting face by the channel back + radius.
  const back = p.channel && p.technique !== 'A' ? CHANNEL_T : 0;
  const centre = fv.clone().multiplyScalar(back + R);

  // A's and B's lights: a PointLight, or (aim) an unshadowed SpotLight along
  // `facing`. Intensity is set by applyStripState below.
  const punctual = (pos, share) => {
    let l;
    if (p.aim) {
      l = new THREE.SpotLight(color, 0, p.reach * CM, AIM_ANGLE_DEG * Math.PI / 180, AIM_PENUMBRA, 2);
      l.castShadow = false;
      // The target rides with the light, one metre along `facing`.
      l.target.position.copy(fv);
      l.add(l.target);
      l.name = 'strip-light-spot';
    } else {
      l = new THREE.PointLight(color, 0, p.reach * CM, 2);
      l.name = 'strip-light-point';
    }
    l.position.copy(pos);
    l.userData.stripShare = share;
    return l;
  };

  if (p.technique === 'A') {
    // Exactly today's addStrip(): a box [length, height, depth] (default
    // 2.5 x 2.5 cm) and one PointLight at its centre, reach `reach`, decay 2.
    const BH = p.boxSize[0] * CM, BD = p.boxSize[1] * CM;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(L, BH, BD),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, transparent: true, opacity: BASELINE_OPACITY })
    );
    // Its back face on the mounting point, like every other technique.
    m.position.copy(fv).multiplyScalar(f[1] !== 0 ? BH / 2 : BD / 2);
    m.name = 'strip-box';
    m.userData.stripRole = 'tube';
    tube = m;
    g.add(m);
    const pl = punctual(m.position, 1);
    lights.push(pl);
    g.add(pl);
  } else {
    // The frosted diffuser: a round tube along X.
    const geo = new THREE.CylinderGeometry(R, R, L, 20, 1, false);
    geo.rotateZ(-Math.PI / 2); // Y axis -> X axis
    // After the rotation the cylinder's u=0 seam sits at +Z (three builds the
    // side from sin/cos of theta with theta=0 at +Z) and u runs round X. Find
    // the u that faces out: the angle of `facing` in the Y-Z plane.
    // Cylinder vertex: (r sin th, y, r cos th) before rotation; rotateZ(-90deg)
    // maps (x, y, z) -> (y, -x, z), so a side vertex lands at y = -r sin th,
    // z = r cos th. Facing (fy, fz) = (-sin th, cos th) -> th = atan2(-fy, fz).
    let th = Math.atan2(-f[1], f[2]);
    if (th < 0) th += Math.PI * 2;
    const faceU = th / (Math.PI * 2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xf4f2ee, roughness: 1, metalness: 0,
      emissive: color, emissiveIntensity: TUBE_GLOW,
      emissiveMap: tubeGlowTexture(THREE, faceU),
      transparent: true, opacity: 0.92
    });
    mat.userData.finish = 'emissive';
    mat.userData.keep = true;
    mat.userData.dynamic = true;
    const t = new THREE.Mesh(geo, mat);
    t.position.copy(centre);
    t.name = 'strip-diffuser';
    t.userData.stripRole = 'tube';
    tube = t;
    g.add(t);

    if (p.channel) {
      // A U-channel: a back plate on the mounting face and two low side walls,
      // laid out for facing 'down' (mounting face y=0, open toward -Y) in a
      // holder that is then turned onto `facing`.
      const cm = new THREE.MeshStandardMaterial({ color: 0xb9bdc1, roughness: 0.45, metalness: 0.3 });
      cm.userData.finish = 'metal';
      const W = D + 2 * CHANNEL_T;
      const parts = [
        { size: [L, CHANNEL_T, W], off: CHANNEL_T / 2, side: 0 },
        { size: [L, R + CHANNEL_T, CHANNEL_T], off: (R + CHANNEL_T) / 2, side: -1 },
        { size: [L, R + CHANNEL_T, CHANNEL_T], off: (R + CHANNEL_T) / 2, side: 1 }
      ];
      for (const part of parts) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(part.size[0], part.size[1], part.size[2]), cm);
        mesh.position.set(0, -part.off, part.side * (D / 2 + CHANNEL_T / 2));
        mesh.name = 'strip-channel';
        mesh.userData.stripRole = 'channel';
        const holder = new THREE.Group();
        holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), fv);
        holder.add(mesh);
        g.add(holder);
      }
    }

    if (p.technique === 'B') {
      const n = p.n;
      for (let i = 0; i < n; i++) {
        const pl = punctual(new THREE.Vector3(-L / 2 + (i + 0.5) * L / n, 0, 0).addScaledVector(fv, -SETBACK_M), 1 / n);
        lights.push(pl);
        g.add(pl);
      }
    } else if (p.technique === 'C') {
      // Same flux onto the lit side as A: Le = AREA_FLUX * I / area.
      const area = L * D;
      const ra = new THREE.RectAreaLight(color, 0, L, D); // intensity: applyStripState below
      ra.position.copy(fv).multiplyScalar(back + D + 0.0005); // the tube's outer face
      ra.quaternion.copy(q);
      ra.name = 'strip-light-area';
      ra.userData.stripShare = 1;
      ra.userData.areaM2 = area;
      lights.push(ra);
      g.add(ra);
    } else if (p.technique === 'D' && p.washDistance > 0) {
      // The glow cards: unlit, additive, a few mm proud of their surface so
      // they never z-fight. A card's texture is the line source's irradiance
      // over it (cardTexture); its colour, set in applyStripState, is light
      // colour x surface albedo / pi x the absolute irradiance -- what a lit
      // Standard material of that albedo would gain under B or C. So a dark
      // worktop glows dimly and a white wall brightly. What a card cannot
      // know is a DIFFERENT surface inside its area (a black hob set in a grey
      // worktop): that is painted with the card's albedo. The limit of a decal.
      const S = p.washSpread * CM, h = p.washDistance * CM;
      const mk = (w, hh, card, role, albedo) => {
        const wm = new THREE.MeshBasicMaterial({
          color, map: card.tex, transparent: true, opacity: 1,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        });
        wm.userData.finish = 'emissive';
        wm.userData.dynamic = true;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, hh), wm);
        m.name = 'strip-' + role;
        m.userData.stripRole = role;
        m.userData.peak = card.peak;
        m.userData.albedo = new THREE.Color(albedo);
        m.renderOrder = 1;
        washes.push(m);
        g.add(m);
        return m;
      };
      // 1. The surface the strip faces (a worktop, the floor, the ceiling, a wall).
      wash = mk(L + 2 * S, 2 * S, cardTexture(THREE, 'face', L, S, h, 0), 'wash', p.washAlbedo);
      // PlaneGeometry faces +Z; turn it to face back toward the strip (-facing).
      wash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fv.clone().negate());
      wash.position.copy(fv).multiplyScalar(h - 0.003);
      // 2. Optional: the wall BEHIND a down/up-facing strip (the backsplash
      //    under a wall cabinet, the wall above a cove), from the strip's
      //    plane to the lit surface.
      if (p.backWash > 0 && (p.facing === 'down' || p.facing === 'up')) {
        const b = p.backWash * CM;
        const bw = mk(L + 2 * S, h, cardTexture(THREE, 'back', L, S, h, b), 'wash-back', p.backAlbedo);
        // plane +Y -> back toward the mounting plane, so the texture's top
        // row (v = 1) lies in the strip's own plane
        const yAxis = fv.clone().negate(), xAxis = new THREE.Vector3(1, 0, 0);
        bw.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, xAxis.clone().cross(yAxis)));
        bw.position.copy(fv).multiplyScalar(h / 2).add(new THREE.Vector3(0, 0, -b + 0.003));
      }
    }
  }

  g.userData.stripLight = Object.assign({}, p, { lights, tube, wash, washes });
  applyStripState(g, { on: p.on, bri: p.bri, color: p.color });
  return g;
}

/**
 * Pose a built strip for a channel state { on, bri (0-100), color }.
 * Every light's intensity is (its share of the total) x intensity x bri, so
 * B's N lights always sum to A's one. Returns false for a non-strip.
 */
export function applyStripState(group, state) {
  const s = group && group.userData && group.userData.stripLight;
  if (!s || !state) return false;
  const on = state.on !== false;
  const k = on ? clamp(Number(state.bri != null ? state.bri : 100) || 0, 0, 100) / 100 : 0;
  const col = state.color != null ? state.color : s.color;
  const total = s.intensity;
  for (const l of s.lights) {
    l.color.set(col);
    const share = l.userData.stripShare;
    l.intensity = l.isRectAreaLight ? (AREA_FLUX * total * k) / l.userData.areaM2 : total * share * k;
    // NOT l.visible: hiding a light changes the scene's light count, and
    // three recompiles every lit material when that count changes. Off is
    // intensity 0, exactly as syncLights() does it.
  }
  if (s.tube) {
    const m = s.tube.material;
    m.emissive.set(col);
    if (s.technique === 'A') {
      // today's applyAccent(): colour, emissive x1.5, 85% / 15% opacity
      m.color.set(col);
      m.emissiveIntensity = on ? k * BASELINE_GLOW : 0;
      m.opacity = on ? BASELINE_OPACITY : 0.15;
    } else {
      m.emissiveIntensity = on && k > 0 ? TUBE_GLOW * Math.max(TUBE_MIN, k) : 0;
    }
  }
  // D: a Lambertian line with the same half-space flux as B/C (2*pi*I) has
  // radiant intensity 2*I/L per metre on its axis; a card adds albedo/pi x
  // the irradiance that gives -- a lit Standard material's diffuse term.
  const perMetre = 2 * total / (s.length * CM);
  for (const w of s.washes || []) {
    w.material.color.set(col).multiply(w.userData.albedo)
      .multiplyScalar(WASH_GAIN * k * perMetre * w.userData.peak / Math.PI);
    w.visible = k > 0;
  }
  s.state = { on, bri: k * 100, color: col };
  return true;
}

/** Every light object a strip (or a tree of strips) holds. */
export function stripLights(root) {
  const out = [];
  root.traverse(o => { if (o.isLight && o.parent && o.name.indexOf('strip-light') === 0) out.push(o); });
  return out;
}

/**
 * Free everything a strip owns on the GPU: geometries, materials and their
 * textures (the tube's glow map, the D cards' maps) and the lights' shadow
 * resources. Call it when a strip is removed -- a teardown that disposes
 * geometry only leaks the rest. Safe on a tree of strips.
 */
export function dispose(root) {
  if (!root) return;
  const mats = new Set();
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const m = o.material;
    if (m) (Array.isArray(m) ? m : [m]).forEach(x => mats.add(x));
    if (o.isLight && typeof o.dispose === 'function') o.dispose();
  });
  for (const m of mats) {
    for (const key of ['map', 'emissiveMap']) if (m[key]) m[key].dispose();
    m.dispose();
  }
}
