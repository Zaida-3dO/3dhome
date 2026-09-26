/**
 * merge.js - fold a room's worth of furniture into a handful of draws.
 *
 * A builder returns a THREE.Group of ordinary meshes, one per part, each with
 * its own material. Drawn as-is, a furnished house would add hundreds of
 * draws to every pass. This module flattens each placed group into world
 * space and concatenates the parts into BUCKETS:
 *
 *   opaque parts (matte, gloss, metal)
 *       -> one vertex-coloured mesh per  room | finish | fadeWallId
 *          sharing ONE material per finish and side (cloned only for a
 *          fade bucket, whose opacity the wall-fade loop drives); a part's
 *          own vertex colours are honoured (multiplied by its colour)
 *   kept parts (glass, mirror, emissive, anything tagged keep, and any
 *   part whose material is textured or translucent)
 *       -> one mesh per  room | material signature | fadeWallId, drawn with
 *          a clone of the BUILDER'S OWN material. Parts share a bucket only
 *          when their materials are equivalent (same type, colour, opacity,
 *          side, depthWrite, emissive, maps, ...), so a translucent beam
 *          cone stays translucent and a double-sided globe keeps its back
 *          faces, while all of a room's identical screens are still one draw
 *
 * Glass NEVER fades with a wall (plan amendment A3): the fade loop drives
 * opacity back to 1.0, which would make glass opaque. A glass part's
 * fadeWallId is forced to null here, so no caller can register one.
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
import { FINISH_PARAMS, partFinish, partKeep, isKeptFinish } from './finishes.js';

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
      const keep = !!k.keep || !!k.error || isKeptFinish(finish) || textured || translucent;
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
      parts.push({
        geometry: g,
        finish: finish,
        keep: keep,
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
 * The bucket a part goes into.
 * Opaque: `room|finish[|side]|fade`. Kept: `room|finish|materialSignature|fade`
 * (a textured part's signature carries its maps' uuids).
 * Glass never carries a fade wall (A3).
 */
export function bucketKey(part, room, fadeWallId) {
  const fade = neverFades(part) || fadeWallId == null ? '-' : String(fadeWallId);
  if (!part.keep) return room + '|' + part.finish + (part.side ? '|side' + part.side : '') + '|' + fade;
  const sig = part.signature || (part.material ? materialSignature(part.material) : hex6(part.color) + '|' + hex6(part.emissive));
  return room + '|' + part.finish + '|' + sig + '|' + fade;
}

/**
 * Concatenate non-indexed geometries into one. With `withColor`, each part's
 * `rgb` is written into a vertex `color` attribute.
 */
export function concatGeometries(THREE, parts, opts) {
  const withColor = !!(opts && opts.withColor);
  const withNormal = !(opts && opts.positionOnly);
  const withUv = !!(opts && opts.withUv);
  // 'multiply': the part's vertex colours times its rgb (an opaque bucket
  // carries the material colour per vertex). 'raw': the vertex colours as
  // they are (a kept bucket whose cloned material multiplies by its colour).
  const colorMode = (opts && opts.colorMode) || 'multiply';
  let n = 0;
  parts.forEach(p => { n += p.geometry.attributes.position.count; });
  const pos = new Float32Array(n * 3);
  const nor = withNormal ? new Float32Array(n * 3) : null;
  const col = withColor ? new Float32Array(n * 3) : null;
  const uv = withUv ? new Float32Array(n * 2) : null;
  let off = 0;
  parts.forEach(p => {
    const g = p.geometry, c = g.attributes.position.count;
    pos.set(g.attributes.position.array, off * 3);
    if (nor) nor.set(g.attributes.normal.array, off * 3);
    if (uv && g.attributes.uv) uv.set(g.attributes.uv.array, off * 2);
    if (col) {
      const r = colorMode === 'raw' ? 1 : p.rgb[0];
      const gg = colorMode === 'raw' ? 1 : p.rgb[1];
      const b = colorMode === 'raw' ? 1 : p.rgb[2];
      for (let i = 0; i < c; i++) {
        const j = (off + i) * 3;
        const v = p.vcol;
        col[j] = r * (v ? v[i * 3] : 1);
        col[j + 1] = gg * (v ? v[i * 3 + 1] : 1);
        col[j + 2] = b * (v ? v[i * 3 + 2] : 1);
      }
    }
    off += c;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nor) out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * A part that must never join a wall fade: glass (plan A3) and anything else
 * translucent. The fade loop drives opacity back to 1.0, which would turn a
 * 0.16 beam cone or a 0.55 globe solid.
 */
export function neverFades(part) {
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
  function opaque(finish, side) {
    const key = 'opaque|' + finish + '|' + (side || 0);
    if (!shared.has(key)) {
      const m = new THREE.MeshStandardMaterial(Object.assign({ color: 0xffffff, vertexColors: true },
        FINISH_PARAMS[finish] || FINISH_PARAMS.matte));
      if (side) m.side = side;
      m.userData.finish = finish;
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
  function forFade(m) {
    const c = m.clone();
    c.transparent = true;
    c.opacity = 1;
    c.userData = Object.assign({}, m.userData, { fade: true });
    return track(c);
  }
  return { opaque, kept, forFade, all };
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
export function buildBuckets(THREE, tagged, materials) {
  const buckets = new Map();
  tagged.forEach(t => {
    const key = bucketKey(t.part, t.room, t.fadeWallId);
    let b = buckets.get(key);
    if (!b) {
      b = { key, room: t.room, finish: t.part.finish, keep: t.part.keep, side: t.part.side,
        fadeWallId: neverFades(t.part) ? null : (t.fadeWallId == null ? null : t.fadeWallId),
        first: t.part, parts: [] };
      buckets.set(key, b);
    }
    b.parts.push(t.part);
  });
  const meshes = [];
  buckets.forEach(b => {
    // Opaque buckets always carry colour per vertex (material colour times
    // any vertex colours). A kept bucket carries vertex colours only when its
    // builder's material uses them, and then raw: the cloned material still
    // multiplies by its own colour.
    const keptVc = b.keep && !!b.first.material.vertexColors;
    const geo = concatGeometries(THREE, b.parts, {
      withColor: !b.keep || keptVc, colorMode: b.keep ? 'raw' : 'multiply', withUv: b.first.textured
    });
    let mat = b.keep ? materials.kept(b.first) : materials.opaque(b.finish, b.side);
    if (b.fadeWallId != null) mat = materials.forFade(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'furniture:' + b.key;
    // Beauty meshes NEVER cast (plan A1): a caster draws in the sun pass and
    // in every room pass whose frustum it touches. The per-room proxy casts.
    mesh.castShadow = false;
    const translucent = neverFades(b.first);
    // A translucent part (a glass globe, a beam cone) would catch a shadow
    // as a dark smear across its own surface; it receives none.
    mesh.receiveShadow = !translucent;
    let tris = 0;
    b.parts.forEach(p => { tris += p.triangles; });
    mesh.userData = { furniture: 'beauty', room: b.room, finish: b.finish, keep: b.keep,
      fadeWallId: b.fadeWallId, bucket: b.key, parts: b.parts.length, triangles: tris, translucent };
    meshes.push(mesh);
  });
  return meshes;
}
