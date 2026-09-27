/**
 * merge.js - fold a room's worth of furniture into a handful of draws.
 *
 * A builder returns a THREE.Group of ordinary meshes, one per part, each with
 * its own material. Drawn as-is, a furnished house would add hundreds of
 * draws to every pass. This module flattens each placed group into world
 * space and concatenates the parts into BUCKETS:
 *
 *   opaque parts (matte, gloss, satin, metal -- and a kept mirror or matte
 *   part whose material is exactly the palette's)
 *       -> one vertex-coloured mesh per  side | fadeWallId, for EVERY
 *          finish at once. The finish travels per vertex too: each vertex's
 *          uv points into a tiny palette texture whose green and blue
 *          channels are that finish's roughness and metalness, read through
 *          the material's roughnessMap and metalnessMap (three multiplies
 *          roughness by .g and metalness by .b). So a gloss handle and a
 *          matte carcass on one wall are one draw and still look exactly as
 *          their own palette materials did. ONE material per side (cloned
 *          only for a fade bucket, whose opacity the wall-fade loop drives);
 *          a part's own vertex colours are honoured (multiplied by its colour)
 *   glowing parts (emissive, opaque, untextured: screens, LED edges, bulbs)
 *       -> one UNLIT vertex-coloured MeshBasicMaterial mesh per side | fade.
 *          The part glows at its own emissive colour (plus a share of its
 *          base colour, standing in for the light a lit material would
 *          add), so every screen and LED colour is ONE draw, and the program
 *          has no light loop at all (perf budget B2, task f17a127f)
 *   every other kept part (glass, a translucent globe or beam cone, a
 *   textured sign, a kept part whose material is not a palette one)
 *       -> one mesh per  material signature | fadeWallId, drawn with a clone
 *          of the builder's own material. NOT re-coloured per vertex on
 *          purpose: a vertex-coloured copy of each of these is a NEW shader
 *          program (the vertexColors / vertexAlphas defines), and a program
 *          costs far more than a draw -- it is a synchronous compile on the
 *          first draw on a phone without KHR_parallel_shader_compile (perf
 *          budget: <= 3 new programs). House-wide scope already leaves only
 *          a handful of these.
 *
 * PROGRAMS. The palette and glow materials are created transparent (at
 * opacity 1, writing depth, drawn first among transparent objects via a
 * negative renderOrder), because the wall fade's clone of each MUST be transparent
 * and three.js keys a program on `transparent` (the OPAQUE define). Solid
 * and fading buckets therefore share one program each, instead of two.
 * renderOrder: palette -2, glow -1 (see buildBucketMesh), kept 0.
 *
 * SCOPE. Buckets are HOUSE-wide by default (`scope: 'house'`): the dollhouse
 * camera frames the whole house almost all the time, so per-room buckets buy
 * no frustum culling and cost one draw per room per finish. `scope: 'room'`
 * keeps the old per-room split (the room id is prepended to every key), for
 * measuring the two against each other. A fade bucket is per WALL either way.
 *
 * Glass and every other translucent part fades WITH its item (task f7324d3f:
 * everything mounted on a wall goes when that wall goes, whatever bucket it
 * lands in). Plan amendment A3 kept glass out of the fade because the loop
 * drove opacity back to 1.0, turning a 0.25 pane solid; instead, a fade
 * clone now keeps its builder's opacity and records it as
 * `userData.baseOpacity` (createMaterialSet's forFade), and the loop scales
 * its target by it -- so a pane returns to 0.25, never to 1.
 *
 * The finish and keep tags are read ONLY through partFinish()/partKeep() in
 * ./finishes.js -- the same two functions the contract test reads -- so what
 * is tested and what is drawn cannot drift apart. A part with no usable tag is
 * quantised from its material's numbers, with a warning.
 *
 * Hand-rolled on purpose (no BufferGeometryUtils), like the footsteps merge in
 * home3d-scene.js: every part is converted to non-indexed geometry, so merging
 * is plain array concatenation.
 *
 * Pure ESM with THREE injected; no `import 'three'` (plan amendment A4).
 */
import { FINISH_PARAMS, liveFinishParams, partFinish, partKeep, isKeptFinish } from './finishes.js';

/** Finishes that can go into a vertex-coloured bucket. */
export const OPAQUE_FINISHES = Object.freeze(['matte', 'gloss', 'metal']);

/**
 * Guess a finish from a material's numbers, for a part whose builder did not
 * tag one. The builder contract makes this a bug in the builder, so the
 * caller warns; this only decides what it looks like meanwhile.
 */
export function quantiseFinish(mat) {
  if (!mat) return 'matte';
  if (mat.transparent && mat.opacity < 0.9) return 'glass';
  const em = mat.emissive;
  if (em && (em.r + em.g + em.b) > 0.05) return 'emissive';
  const metal = typeof mat.metalness === 'number' ? mat.metalness : 0;
  const rough = typeof mat.roughness === 'number' ? mat.roughness : 1;
  if (metal >= 0.95 && rough <= 0.1) return 'mirror';
  if (metal >= 0.5) return 'metal';
  if (rough < 0.5) return 'gloss';
  return 'matte';
}

function hasTexture(mat) {
  if (!mat) return false;
  for (const k in mat) {
    const v = mat[k];
    if (v && v.isTexture) return true;
  }
  return false;
}

const paletteSigCache = new Map();
/** Is `mat` indistinguishable from makeFinish(finish) (up to colour and side)? */
export function isPaletteMaterial(THREE, mat, finish) {
  if (!mat || !mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) return false;
  if (!Object.prototype.hasOwnProperty.call(FINISH_PARAMS, finish) || finish === 'glass') return false;
  const key = finish + '|' + (mat.side || 0) + '|' + (mat.vertexColors ? 1 : 0);
  if (!paletteSigCache.has(key)) {
    const ref = new THREE.MeshStandardMaterial(Object.assign({}, FINISH_PARAMS[finish]));
    ref.side = mat.side || 0;
    ref.vertexColors = !!mat.vertexColors;
    paletteSigCache.set(key, tintSignature(ref));
    ref.dispose();
  }
  return tintSignature(mat) === paletteSigCache.get(key);
}

function hex6(n) { return ('000000' + (n >>> 0).toString(16)).slice(-6); }

// Material properties that change how a kept part LOOKS, and so decide which
// parts may share one material. Anything not listed is either irrelevant to
// the picture or covered by `type`.
const SIGNATURE_PROPS = [
  'type', 'opacity', 'transparent', 'side', 'depthWrite', 'depthTest', 'blending',
  'alphaTest', 'vertexColors', 'flatShading', 'wireframe', 'toneMapped', 'fog',
  'roughness', 'metalness', 'emissiveIntensity', 'transmission', 'thickness', 'ior',
  'clearcoat', 'clearcoatRoughness', 'sheen', 'specularIntensity', 'reflectivity',
  'envMapIntensity', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits',
  'colorWrite', 'premultipliedAlpha', 'dithering', 'shininess'
];
const COLOR_PROPS = ['color', 'emissive', 'specular', 'specularColor', 'sheenColor', 'attenuationColor'];

/**
 * A string that is equal for two materials exactly when they would draw the
 * same. Kept parts are bucketed by it, so equivalent materials merge and any
 * difference -- a translucent beam against an opaque lens of the same colour,
 * a double-sided globe against a front-sided one -- keeps them apart.
 */
export function materialSignature(mat) {
  if (!mat) return 'none';
  const out = [];
  SIGNATURE_PROPS.forEach(k => {
    const v = mat[k];
    if (v !== undefined && typeof v !== 'object' && typeof v !== 'function') out.push(k + '=' + v);
  });
  COLOR_PROPS.forEach(k => {
    const v = mat[k];
    if (v && v.isColor) out.push(k + '=' + v.getHexString());
  });
  for (const k in mat) {
    const v = mat[k];
    if (v && v.isTexture) out.push(k + '@' + v.uuid);
  }
  return out.join(';');
}

/**
 * Flatten one placed group into world-space parts.
 *
 * The group's matrixWorld must be current (the caller positions it and calls
 * updateMatrixWorld(true)). Every returned geometry is a NEW non-indexed
 * BufferGeometry with `position` and `normal` only, in world space; the
 * builder's own geometry is left untouched for the caller to dispose.
 *
 * @returns {{parts: Array<Object>, warnings: string[]}}
 *   part = { geometry, finish, keep, color, emissive, material, textured, triangles }
 */
export function flattenGroup(THREE, group, opts) {
  const o = opts || {};
  const warnings = [];
  const parts = [];
  group.updateMatrixWorld(true);
  group.traverse(obj => {
    if (!obj.isMesh || !obj.geometry || !obj.geometry.attributes || !obj.geometry.attributes.position) return;
    if (obj.visible === false) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    // Split a multi-material mesh by its groups, so each slice is tagged by
    // its own material.
    let src = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone();
    const slices = (Array.isArray(obj.material) && src.groups && src.groups.length)
      ? src.groups.map(g => ({ start: g.start, count: g.count, mat: mats[g.materialIndex] }))
      : [{ start: 0, count: src.attributes.position.count, mat: mats[0] }];
    src.applyMatrix4(obj.matrixWorld);
    if (!src.attributes.normal) src.computeVertexNormals();
    const pos = src.attributes.position, nor = src.attributes.normal;
    slices.forEach(sl => {
      const mat = sl.mat;
      if (!mat || mat.visible === false) return;
      const total = pos.count;
      const start = Math.max(0, Math.min(total, sl.start));
      const count = Math.max(0, Math.min(total - start, sl.count === Infinity ? total - start : sl.count));
      if (count < 3) return;
      let { finish, error } = partFinish(obj, mat);
      if (error) {
        finish = quantiseFinish(mat);
        warnings.push((o.label ? o.label + ': ' : '') + error + ' -- quantised to "' + finish + '"');
      }
      const k = partKeep(obj, mat);
      if (k.error) warnings.push((o.label ? o.label + ': ' : '') + k.error + ' -- keeping the part');
      const textured = hasTexture(mat);
      // A translucent part cannot go into an opaque vertex-coloured bucket
      // (that bucket is opaque), whatever finish it claims.
      const translucent = !!mat.transparent && mat.opacity < 1;
      let keep = !!k.keep || !!k.error || isKeptFinish(finish) || textured || translucent;
      // A kept part whose material is EXACTLY a palette material (a mirror
      // from makeFinish, a matte part a builder tagged keep) draws the same
      // in the palette bucket as on its own, so it goes there.
      if (keep && !k.error && !textured && !translucent && finish !== 'emissive' &&
          isPaletteMaterial(THREE, mat, finish)) {
        keep = false;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array(pos.array.slice(start * 3, (start + count) * 3)), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(
        new Float32Array(nor.array.slice(start * 3, (start + count) * 3)), 3));
      // The part's own vertex colours, when its material uses them.
      let vcol = null;
      const ca = src.attributes.color;
      if (mat.vertexColors && ca && ca.itemSize >= 3) {
        vcol = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          vcol[i * 3] = ca.getX(start + i);
          vcol[i * 3 + 1] = ca.getY(start + i);
          vcol[i * 3 + 2] = ca.getZ(start + i);
        }
      }
      if (textured && src.attributes.uv) {
        g.setAttribute('uv', new THREE.BufferAttribute(
          new Float32Array(src.attributes.uv.array.slice(start * 2, (start + count) * 2)), 2));
      }
      const ei = typeof mat.emissiveIntensity === 'number' ? mat.emissiveIntensity : 1;
      parts.push({
        geometry: g,
        finish: finish,
        keep: keep,
        translucent: translucent,
        opacity: typeof mat.opacity === 'number' ? mat.opacity : 1,
        // Linear emissive radiance (colour x intensity), for a glow bucket.
        emissiveRgb: mat.emissive ? [mat.emissive.r * ei, mat.emissive.g * ei, mat.emissive.b * ei] : null,
        color: mat.color ? mat.color.getHex() : 0xcccccc,
        // Linear components, for the vertex colour attribute (vertex colours
        // are read as linear, exactly as material.color is stored).
        rgb: mat.color ? [mat.color.r, mat.color.g, mat.color.b] : [0.6, 0.6, 0.6],
        emissive: mat.emissive ? mat.emissive.getHex() : 0,
        side: mat.side || 0,
        vcol: vcol,
        signature: keep ? materialSignature(mat) : null,
        material: mat,
        textured: textured,
        triangles: count / 3
      });
    });
    src.dispose();
  });
  return { parts: parts, warnings: warnings };
}

/**
 * How a part is drawn -- which of the three bucket classes it joins (see the
 * header):
 *   'opaque'  not kept: a palette finish, vertex-coloured, shared material
 *   'glow'    finish 'emissive', opaque, untextured: unlit MeshBasic
 *   'kept'    anything else: the builder's material as it is
 */
export function bucketClass(part) {
  if (!part.keep) return 'opaque';
  if (part.finish === 'emissive' && !part.textured && !part.translucent) return 'glow';
  return 'kept';
}

/**
 * A material signature with colour and opacity left out -- what
 * isPaletteMaterial compares, since a palette bucket carries colour per
 * vertex.
 */
export function tintSignature(mat) {
  if (!mat) return 'none';
  const out = [];
  SIGNATURE_PROPS.forEach(k => {
    if (k === 'opacity') return;
    const v = mat[k];
    if (v !== undefined && typeof v !== 'object' && typeof v !== 'function') out.push(k + '=' + v);
  });
  COLOR_PROPS.forEach(k => {
    if (k === 'color') return;
    const v = mat[k];
    if (v && v.isColor) out.push(k + '=' + v.getHexString());
  });
  return out.join(';');
}

/**
 * The bucket a part goes into. The fade wall is always last -- for EVERY
 * class, glass and translucent parts included (see the header).
 *   opaque  `palette[|side]|fade`   (every opaque finish together)
 *   glow    `glow[|side]|fade`
 *   kept    `finish|<materialSignature>|fade`  (a texture's uuid is in it)
 * With `scope: 'room'`, `room|` is prepended to every key.
 */
export function bucketKey(part, room, fadeWallId, scope) {
  const fade = fadeWallId == null ? '-' : String(fadeWallId);
  const pre = scope === 'room' ? room + '|' : '';
  const side = part.side ? '|side' + part.side : '';
  const cls = bucketClass(part);
  if (cls === 'opaque') return pre + 'palette' + side + '|' + fade;
  if (cls === 'glow') return pre + 'glow' + side + '|' + fade;
  const sig = part.signature || (part.material ? materialSignature(part.material) : hex6(part.color) + '|' + hex6(part.emissive));
  return pre + part.finish + '|' + sig + '|' + fade;
}

/**
 * How much of a glowing part's BASE colour its unlit bucket adds on top of
 * its emissive colour. A lit MeshStandard screen shows emissive + lit
 * albedo; this share stands in for the albedo term. Chosen by screenshot
 * comparison against the lit material (see the PR).
 */
export const GLOW_BASE_SHARE = 1.0;

/** The palette texture's texels, one per finish, in FINISHES order. */
export const PALETTE_FINISHES = Object.freeze(Object.keys(FINISH_PARAMS));

/** The u coordinate of a finish's texel (texel centre). */
export function paletteU(finish) {
  const i = Math.max(0, PALETTE_FINISHES.indexOf(finish));
  return (i + 0.5) / PALETTE_FINISHES.length;
}

/**
 * The palette as a 1-pixel-high RGBA texture: G = roughness, B = metalness
 * (the channels three's roughnessMap and metalnessMap read). Nearest
 * filtering, no mipmaps, linear data -- a texel is looked up, never blended.
 */
export function makePaletteTexture(THREE) {
  const n = PALETTE_FINISHES.length;
  const data = new Uint8Array(n * 4);
  PALETTE_FINISHES.forEach((f, i) => {
    const p = liveFinishParams(f);   // a mirror has nothing to reflect here: see finishes.js
    data[i * 4] = 255;
    data[i * 4 + 1] = Math.round((typeof p.roughness === 'number' ? p.roughness : 1) * 255);
    data[i * 4 + 2] = Math.round((typeof p.metalness === 'number' ? p.metalness : 0) * 255);
    data[i * 4 + 3] = 255;
  });
  const t = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  t.name = 'furniture-finish-palette';
  return t;
}

/**
 * Concatenate non-indexed geometries into one. With `withColor`, each part's
 * `rgb` is written into a vertex `color` attribute.
 */
export function concatGeometries(THREE, parts, opts) {
  const withColor = !!(opts && opts.withColor);
  const withNormal = !(opts && opts.positionOnly);
  const withUv = !!(opts && opts.withUv);
  // Each vertex's uv picks its part's finish out of the palette texture.
  const paletteUv = !!(opts && opts.paletteUv);
  // 'multiply': the part's vertex colours times its rgb (an opaque bucket
  // carries the material colour per vertex). 'raw': the vertex colours as
  // they are (a kept bucket whose cloned material multiplies by its colour).
  // 'glow': emissive radiance plus GLOW_BASE_SHARE of the base colour (an
  // unlit glow bucket).
  const colorMode = (opts && opts.colorMode) || 'multiply';
  const cs = 3;
  let n = 0;
  parts.forEach(p => { n += p.geometry.attributes.position.count; });
  const pos = new Float32Array(n * 3);
  const nor = withNormal ? new Float32Array(n * 3) : null;
  const col = withColor ? new Float32Array(n * cs) : null;
  const uv = (withUv || paletteUv) ? new Float32Array(n * 2) : null;
  let off = 0;
  parts.forEach(p => {
    const g = p.geometry, c = g.attributes.position.count;
    pos.set(g.attributes.position.array, off * 3);
    if (nor) nor.set(g.attributes.normal.array, off * 3);
    if (uv && paletteUv) {
      const u = paletteU(p.finish);
      for (let i = 0; i < c; i++) { uv[(off + i) * 2] = u; uv[(off + i) * 2 + 1] = 0.5; }
    } else if (uv && g.attributes.uv) uv.set(g.attributes.uv.array, off * 2);
    if (col) {
      let r = 1, gg = 1, b = 1;
      if (colorMode === 'multiply') { r = p.rgb[0]; gg = p.rgb[1]; b = p.rgb[2]; }
      const glow = colorMode === 'glow';
      const e = glow ? (p.emissiveRgb || [0, 0, 0]) : null;
      for (let i = 0; i < c; i++) {
        const j = (off + i) * cs;
        const v = p.vcol;
        if (glow) {
          col[j] = e[0] + GLOW_BASE_SHARE * p.rgb[0] * (v ? v[i * 3] : 1);
          col[j + 1] = e[1] + GLOW_BASE_SHARE * p.rgb[1] * (v ? v[i * 3 + 1] : 1);
          col[j + 2] = e[2] + GLOW_BASE_SHARE * p.rgb[2] * (v ? v[i * 3 + 2] : 1);
        } else {
          col[j] = r * (v ? v[i * 3] : 1);
          col[j + 1] = gg * (v ? v[i * 3 + 1] : 1);
          col[j + 2] = b * (v ? v[i * 3 + 2] : 1);
        }
      }
    }
    off += c;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nor) out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, cs));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * A translucent part: glass and anything else drawn below opacity 1. It is
 * never a shadow caster and never receives a shadow. It DOES fade with its
 * item's wall, from its own opacity (see the header).
 */
export function isTranslucent(part) {
  if (!part) return false;
  if (part.finish === 'glass') return true;
  const m = part.material;
  return !!(m && m.transparent && m.opacity < 1);
}

/**
 * The materials the buckets draw with.
 *
 *   opaque  ONE shared vertex-coloured material per finish and side, from the
 *           closed palette (FINISH_PARAMS).
 *   kept    a CLONE OF THE BUILDER'S OWN MATERIAL, one per material
 *           signature. Nothing is rebuilt from the palette: type, opacity,
 *           transparent, side, depthWrite, emissive/emissiveIntensity and maps
 *           all survive exactly as the builder set them.
 *   fade    a clone per fade bucket (the fade loop writes opacity and
 *           depthWrite on the material it is handed, so a fade bucket must not
 *           share with a solid one or with another wall).
 */
export function createMaterialSet(THREE) {
  const shared = new Map();
  const all = new Set();
  function track(m) { all.add(m); return m; }
  let palette = null;
  const textures = [];
  // ONE palette material per side, for every opaque finish (see the header).
  function opaque(side) {
    const key = 'opaque|' + (side || 0);
    if (!shared.has(key)) {
      if (!palette) { palette = makePaletteTexture(THREE); textures.push(palette); }
      // transparent at opacity 1: see PROGRAMS in the header.
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true,
        roughness: 1, metalness: 1, roughnessMap: palette, metalnessMap: palette,
        transparent: true, opacity: 1, depthWrite: true });
      if (side) m.side = side;
      m.userData.finish = 'palette';
      m.userData.furniture = true;
      shared.set(key, track(m));
    }
    return shared.get(key);
  }
  function kept(part) {
    const key = 'kept|' + part.finish + '|' + (part.signature || materialSignature(part.material));
    if (!shared.has(key)) {
      const m = part.material.clone();
      m.userData = Object.assign({}, m.userData, { finish: part.finish, furniture: true });
      shared.set(key, track(m));
    }
    return shared.get(key);
  }
  // One unlit vertex-coloured material per side for every glowing part.
  function glow(side) {
    const key = 'glow|' + (side || 0);
    if (!shared.has(key)) {
      const m = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true,
        transparent: true, opacity: 1, depthWrite: true });
      if (side) m.side = side;
      m.userData.finish = 'emissive';
      m.userData.furniture = true;
      m.userData.glow = true;
      shared.set(key, track(m));
    }
    return shared.get(key);
  }
  // The clone keeps the builder's own opacity and depthWrite, and records
  // them: the wall-fade loop fades FROM them and returns TO them (a 0.25
  // glass pane comes back at 0.25, not 1). Palette and glow are 1 / true.
  function forFade(m) {
    const c = m.clone();
    c.transparent = true;
    c.userData = Object.assign({}, m.userData, { fade: true,
      baseOpacity: typeof m.opacity === 'number' ? m.opacity : 1, baseDepthWrite: m.depthWrite !== false });
    return track(c);
  }
  return { opaque, kept, glow, forFade, all, textures };
}

/**
 * Build the bucket meshes for a list of tagged parts.
 *
 * @param {Object} THREE
 * @param {Array<{part, room, fadeWallId}>} tagged
 * @param {Object} materials  createMaterialSet()
 * @returns {Array<THREE.Mesh>}  userData: { furniture: 'beauty', room, finish,
 *          fadeWallId, bucket, parts, triangles }
 */
export function buildBuckets(THREE, tagged, materials, opts) {
  const scope = opts && opts.scope === 'room' ? 'room' : 'house';
  const meshes = [];
  groupBuckets(tagged, scope).forEach(b => meshes.push(buildBucketMesh(THREE, b, materials)));
  return meshes;
}

/** Group tagged parts by bucketKey: Map<key, bucket>, in first-seen order. */
export function groupBuckets(tagged, scope) {
  const buckets = new Map();
  tagged.forEach(t => {
    const key = bucketKey(t.part, t.room, t.fadeWallId, scope);
    let b = buckets.get(key);
    if (!b) {
      const cls = bucketClass(t.part);
      b = { key, room: scope === 'room' ? t.room : null, rooms: new Set(), cls,
        finish: cls === 'opaque' ? 'palette' : t.part.finish, keep: t.part.keep, side: t.part.side,
        fadeWallId: t.fadeWallId == null ? null : t.fadeWallId,
        first: t.part, parts: [] };
      buckets.set(key, b);
    }
    b.rooms.add(t.room);
    if (b.cls === 'opaque') (b.finishes = b.finishes || new Set()).add(t.part.finish);
    b.parts.push(t.part);
  });
  return buckets;
}

/** One bucket's mesh (see the header for the four classes). */
export function buildBucketMesh(THREE, b, materials) {
  let geo, mat;
  if (b.cls === 'opaque') {
    // Material colour times any vertex colours, per vertex.
    geo = concatGeometries(THREE, b.parts, { withColor: true, colorMode: 'multiply', paletteUv: true });
    mat = materials.opaque(b.side);
  } else if (b.cls === 'glow') {
    geo = concatGeometries(THREE, b.parts, { withColor: true, colorMode: 'glow' });
    mat = materials.glow(b.side);
  } else {
    // A textured bucket carries vertex colours only when its builder's
    // material uses them, and then raw: the cloned material still multiplies
    // by its own colour.
    const keptVc = !!b.first.material.vertexColors;
    geo = concatGeometries(THREE, b.parts, { withColor: keptVc, colorMode: 'raw', withUv: b.first.textured });
    mat = materials.kept(b.first);
  }
  if (b.fadeWallId != null) mat = materials.forFade(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'furniture:' + b.key;
  // Palette and glow materials are transparent at opacity 1 (see PROGRAMS):
  // draw them FIRST among transparent objects, so glass, a sheer curtain or
  // a fading wall in front still blends over them. Glow AFTER the palette:
  // a screen or an LED sits on (sometimes flush with) its body, and on a tie
  // in depth the later draw wins -- the other order stripes the screen with
  // the body behind it.
  if (b.cls === 'opaque') mesh.renderOrder = -2;
  else if (b.cls === 'glow') mesh.renderOrder = -1;
  // Beauty meshes NEVER cast (plan A1): a caster draws in the sun pass and
  // in every room pass whose frustum it touches. The per-room proxy casts.
  mesh.castShadow = false;
  const translucent = isTranslucent(b.first);
  // A translucent part (a glass globe, a beam cone) would catch a shadow
  // as a dark smear across its own surface; it receives none. Nor does an
  // unlit glow, which has no lighting for a shadow to take away.
  mesh.receiveShadow = !translucent && b.cls !== 'glow';
  let tris = 0;
  b.parts.forEach(p => { tris += p.triangles; });
  mesh.userData = { furniture: 'beauty', room: b.room, rooms: Array.from(b.rooms), cls: b.cls, finish: b.finish,
    finishes: b.finishes ? Array.from(b.finishes) : [b.finish],
    keep: b.keep, fadeWallId: b.fadeWallId, bucket: b.key, parts: b.parts.length, triangles: tris, translucent };
  return mesh;
}
