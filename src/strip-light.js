/**
 * strip-light.js - a linear LED strip that reads as ONE long, smooth source.
 *
 * Today (home3d-scene.js addStrip) a strip is an emissive box plus ONE
 * PointLight at its centre: the surface below it gets a round blob, not a
 * line. This module builds a strip four ways behind one `technique` option so
 * they can be compared side by side (specs/StripLightSpec.html) before any of
 * them goes into the house:
 *
 *   'A' baseline    exactly today's look: an emissive, 85%-opaque box and one
 *                   PointLight at its centre (reach 2.5 m, decay 2).
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
 *   'D' zero-light  NO light objects: the diffuser tube plus an additive glow
 *                   card ("wash") on the surface the strip faces. Costs no
 *                   fragment uniforms at all -- the low-tier / phone option.
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
 * built strip (every light, the tube, the wash) without a rebuild -- the same
 * channel state light-parts.js takes, so the house's syncLights() can drive
 * one shared brightness and colour for every strip.
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
  length: 100,          // cm; the real house ranges 10..340
  diameter: 1.6,        // cm; the diffuser tube (A: the box's height and depth)
  channel: true,        // aluminium U-channel behind the tube (B/C/D)
  facing: 'down',
  n: 6,                 // B: lights along the strip (clamped to 1..MAX_N)
  intensity: 0.3,       // the strip's TOTAL light at bri 100 (today's accent: 0.3)
  reach: 250,           // cm; the point lights' cut-off (today's default 2.5 m)
  color: '#ffb45a',
  bri: 100,
  on: true,
  washDistance: 0,      // cm; D: distance to the surface the strip faces (0 = no card)
  washSpread: 25,       // cm; D: how far the glow reaches either side of the line
  backWash: 0           // cm; D, facing down/up: distance to a wall BEHIND the strip (0 = none)
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
/** C: radiance x area = AREA_FLUX x the point light's intensity (flux match onto the lit side). */
export const AREA_FLUX = 2;
/** D: the glow fades past the strip's ends over this share of washSpread. */
export const END_FADE = 0.4;
/** D: the wash card's peak strength at bri 100 and total intensity 0.3. */
export const WASH_GAIN = 0.55;

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
  return p;
}

/** How many light objects of each type a strip with these params builds. */
export function lightCounts(params) {
  const p = resolveParams(params);
  return {
    point: p.technique === 'A' ? 1 : p.technique === 'B' ? p.n : 0,
    rectArea: p.technique === 'C' ? 1 : 0
  };
}

/** Fragment uniform vectors (upper bound, see UNIFORM_VECTORS) these params add. */
export function uniformVectors(params) {
  const c = lightCounts(params);
  return c.point * UNIFORM_VECTORS.point + c.rectArea * UNIFORM_VECTORS.rectArea;
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
 * The wash card's alpha: a "stadium" falloff round a line segment -- full
 * along the strip's length, fading smoothly to nothing `spread` either side
 * of it and past its ends. Size in texels; `lineFrac` is the share of the
 * card's long side the strip itself covers.
 */
function washTexture(THREE, lineFrac, vertical) {
  const W = 128, H = 32;
  const data = new Uint8Array(W * H * 4);
  const half = lineFrac / 2;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = (i + 0.5) / W - 0.5, y = (j + 0.5) / H;
      // distance (in "fade" units) past the segment's ends...
      const dxN = Math.max(0, Math.abs(x) - half) / Math.max(1e-6, 0.5 - half);
      // ...and across it: centred on the line, or (vertical) falling away
      // from the top edge (v = 1, next to the strip) to the bottom.
      const dyN = vertical ? 1 - y : Math.abs(y - 0.5) / 0.5;
      const d = Math.min(1, Math.hypot(dxN, dyN));
      const a = Math.pow(1 - d, 2);  // soft, like 1/r^2 flattened by the diffuser
      const o = (j * W + i) * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = Math.round(255 * a);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---- build -----------------------------------------------------------------------

/**
 * Build one strip.
 *
 * @param {Object} THREE   the three.js namespace
 * @param {Object} params  see DEFAULTS
 * @returns {THREE.Group}  userData.stripLight = the resolved params plus
 *   { lights: [...light objects], tube, wash }. Every light carries
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

  if (p.technique === 'A') {
    // Exactly today's addStrip(): a box [length, d, d] and one PointLight at
    // its centre, reach `reach`, decay 2.
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(L, D, D),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, transparent: true, opacity: BASELINE_OPACITY })
    );
    m.position.copy(centre);
    m.name = 'strip-box';
    m.userData.stripRole = 'tube';
    tube = m;
    g.add(m);
    const pl = new THREE.PointLight(color, 0, p.reach * CM, 2); // intensity: applyStripState below
    pl.position.copy(centre);
    pl.name = 'strip-light-point';
    pl.userData.stripShare = 1;
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
        const pl = new THREE.PointLight(color, 0, p.reach * CM, 2); // intensity / n: applyStripState below
        pl.position.set(-L / 2 + (i + 0.5) * L / n, 0, 0).addScaledVector(fv, -SETBACK_M);
        pl.name = 'strip-light-point';
        pl.userData.stripShare = 1 / n;
        lights.push(pl);
        g.add(pl);
      }
    } else if (p.technique === 'C') {
      // Same light onto the lit side as A: a point light of intensity I sends
      // 2*pi*I into the half-space in front; a one-sided Lambertian rectangle
      // of radiance Le and area A sends pi*Le*A. Le = AREA_FLUX * I / A with
      // AREA_FLUX = 2 matches them (the mean-irradiance rule light-merge.js
      // uses for merged lights).
      const area = L * D;
      const ra = new THREE.RectAreaLight(color, 0, L, D); // intensity / area: applyStripState below
      ra.position.copy(fv).multiplyScalar(back + D + 0.0005); // the tube's outer face
      ra.quaternion.copy(q);
      ra.name = 'strip-light-area';
      ra.userData.stripShare = 1;
      ra.userData.areaM2 = area;
      lights.push(ra);
      g.add(ra);
    } else if (p.technique === 'D' && p.washDistance > 0) {
      // The glow cards. Additive and unlit, so they brighten whatever they
      // lie on at no lighting cost; a few mm proud of the surface so they
      // never z-fight. Past the strip's ends the glow fades over END_FADE of
      // the spread (a strip throws little light beyond its own ends).
      const spread = Math.max(1, p.washSpread) * CM;
      const endFade = END_FADE * spread;
      const mk = (w, h, tex, role) => {
        const wm = new THREE.MeshBasicMaterial({
          color, map: tex, transparent: true, opacity: 1,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        });
        wm.userData.finish = 'emissive';
        wm.userData.dynamic = true;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wm);
        m.name = 'strip-' + role;
        m.userData.stripRole = role;
        m.renderOrder = 1;
        washes.push(m);
        g.add(m);
        return m;
      };
      // 1. The surface the strip faces (a worktop, the floor, the ceiling).
      const cw = L + 2 * endFade;
      wash = mk(cw, 2 * spread + D, washTexture(THREE, L / cw, false), 'wash');
      // PlaneGeometry faces +Z; turn it to face back toward the strip (-facing).
      wash.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fv.clone().negate());
      wash.position.copy(fv).multiplyScalar(p.washDistance * CM - 0.003);
      // 2. Optional: the wall BEHIND a down/up-facing strip (the backsplash
      //    under a wall cabinet, the wall above a cove), from the strip's
      //    plane to the lit surface, brightest next to the strip.
      if (p.backWash > 0 && (p.facing === 'down' || p.facing === 'up')) {
        const bh = p.washDistance * CM;
        // On a wall the light spreads sideways about as far as it travels
        // down it, so the back card fades past the ends over half its height.
        const bwW = L + 2 * Math.max(endFade, bh / 2);
        const bw = mk(bwW, bh, washTexture(THREE, L / bwW, true), 'wash-back');
        // plane +Y -> back toward the mounting plane, so v=1 (bright) is by the strip
        const yAxis = fv.clone().negate(), xAxis = new THREE.Vector3(1, 0, 0);
        bw.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, xAxis.clone().cross(yAxis)));
        bw.position.copy(fv).multiplyScalar(bh / 2).add(new THREE.Vector3(0, 0, -p.backWash * CM + 0.003));
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
  for (const w of s.washes || []) {
    w.material.color.set(col).multiplyScalar(WASH_GAIN * k * (total / DEFAULTS.intensity));
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
