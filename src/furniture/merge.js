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
 *          sharing ONE material per finish (cloned only for a fade bucket,
 *          whose opacity the wall-fade loop drives)
 *   kept parts (glass, mirror, emissive, or anything tagged keep)
 *       -> one mesh per  room | finish | colour | fadeWallId
 *          with a real material, so all the glass of one colour in a room is
 *          one draw and all its screens are one draw
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
      const keep = !!k.keep || !!k.error || isKeptFinish(finish) || textured;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(
        new Float32Array(pos.array.slice(start * 3, (start + count) * 3)), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(
        new Float32Array(nor.array.slice(start * 3, (start + count) * 3)), 3));
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
 * Opaque: `room|finish|fade`. Kept: `room|finish|colour|emissive|fade`.
 * A textured part is its own bucket (it cannot share a material).
 * Glass never carries a fade wall (A3).
 */
export function bucketKey(part, room, fadeWallId) {
  const fade = part.finish === 'glass' || fadeWallId == null ? '-' : String(fadeWallId);
  if (!part.keep) return room + '|' + part.finish + '|' + fade;
  if (part.textured) return room + '|' + part.finish + '|tex:' + part.material.uuid + '|' + fade;
  return room + '|' + part.finish + '|' + hex6(part.color) + '|' + hex6(part.emissive) + '|' + fade;
}

/**
 * Concatenate non-indexed geometries into one. With `withColor`, each part's
 * `rgb` is written into a vertex `color` attribute.
 */
export function concatGeometries(THREE, parts, opts) {
  const withColor = !!(opts && opts.withColor);
  const withNormal = !(opts && opts.positionOnly);
  const withUv = !!(opts && opts.withUv);
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
      const r = p.rgb[0], gg = p.rgb[1], b = p.rgb[2];
      for (let i = 0; i < c; i++) {
        const j = (off + i) * 3;
        col[j] = r; col[j + 1] = gg; col[j + 2] = b;
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
 * The materials the buckets draw with. One shared material per opaque finish
 * (vertex-coloured), one per kept finish+colour, and a CLONE per fade bucket
 * (the fade loop writes opacity and depthWrite on the material it is handed,
 * so a fade bucket must not share with a solid one or with another wall).
 */
export function createMaterialSet(THREE) {
  const shared = new Map();
  const all = new Set();
  function track(m) { all.add(m); return m; }
  function opaque(finish) {
    const key = 'opaque|' + finish;
    if (!shared.has(key)) {
      const m = new THREE.MeshStandardMaterial(Object.assign({ color: 0xffffff, vertexColors: true },
        FINISH_PARAMS[finish] || FINISH_PARAMS.matte));
      m.userData.finish = finish;
      m.userData.furniture = true;
      shared.set(key, track(m));
    }
    return shared.get(key);
  }
  function kept(part) {
    if (part.textured) {
      const m = part.material.clone();
      m.userData = Object.assign({}, m.userData, { finish: part.finish, furniture: true });
      return track(m);
    }
    const key = 'kept|' + part.finish + '|' + hex6(part.color) + '|' + hex6(part.emissive);
    if (!shared.has(key)) {
      const params = Object.assign({ color: part.color }, FINISH_PARAMS[part.finish] || FINISH_PARAMS.matte);
      if (part.emissive) params.emissive = part.emissive;
      const m = new THREE.MeshStandardMaterial(params);
      m.userData.finish = part.finish;
      m.userData.furniture = true;
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
      b = { key, room: t.room, finish: t.part.finish, keep: t.part.keep,
        fadeWallId: t.part.finish === 'glass' ? null : (t.fadeWallId == null ? null : t.fadeWallId),
        first: t.part, parts: [] };
      buckets.set(key, b);
    }
    b.parts.push(t.part);
  });
  const meshes = [];
  buckets.forEach(b => {
    const geo = concatGeometries(THREE, b.parts, { withColor: !b.keep, withUv: b.first.textured });
    let mat = b.keep ? materials.kept(b.first) : materials.opaque(b.finish);
    if (b.fadeWallId != null) mat = materials.forFade(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'furniture:' + b.key;
    // Beauty meshes NEVER cast (plan A1): a caster draws in the sun pass and
    // in every room pass whose frustum it touches. The per-room proxy casts.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    let tris = 0;
    b.parts.forEach(p => { tris += p.triangles; });
    mesh.userData = { furniture: 'beauty', room: b.room, finish: b.finish, keep: b.keep,
      fadeWallId: b.fadeWallId, bucket: b.key, parts: b.parts.length, triangles: tris };
    meshes.push(mesh);
  });
  return meshes;
}
