/**
 * lib-coplanar.mjs - find pairs of faces in one built furniture item that
 * would z-fight: two triangles from DIFFERENT meshes (or different material
 * slices of one mesh) facing the SAME way, lying within `tol` metres of the
 * same plane, and overlapping in that plane by more than `minArea` m^2.
 *
 * Why this is the rule. A depth buffer cannot order two surfaces that are at
 * (or within a sliver of) the same depth: which one wins flips per pixel and
 * per frame as the camera moves, which is exactly the diagonal dotted
 * "shimmer" on a TV screen flush with its body, or the jagged edge where a
 * mirror pane runs under its door stile. Faces that merely TOUCH along an
 * edge do not fight (they share no pixels), and back-to-back faces (opposite
 * normals) do not either -- one of them is always facing away and culled.
 *
 * `identicalLookExempt` (default true): a pair whose two materials would
 * shade every pixel IDENTICALLY -- same finish, colour, emissive, side,
 * opacity, transparency, vertex colours, roughness, metalness and textures,
 * on meshes that agree on receiveShadow -- is reported separately rather
 * than as a failure. Whichever
 * of the two wins a pixel, the pixel is the same colour, so there is nothing
 * to see (and in the live house both land in one merged draw anyway).
 *
 * Pure: THREE is injected, no DOM.
 */

function triArea2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
}

/** Sutherland-Hodgman: clip polygon `subject` by convex CCW polygon `clip`. */
function clipPolygon(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inp = out;
    out = [];
    const side = p => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    for (let j = 0; j < inp.length; j++) {
      const p = inp[j], q = inp[(j + 1) % inp.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

function ccw(t) {
  return triArea2(t[0], t[1], t[2]) < 0 ? [t[0], t[2], t[1]] : t;
}

/** A string equal for two materials exactly when they shade identically. */
function lookKey(mat, mesh) {
  if (!mat) return 'none';
  const f = (mat.userData && mat.userData.finish) || (mesh && mesh.userData && mesh.userData.finish) || '?';
  const c = mat.color && mat.color.getHexString ? mat.color.getHexString() : '-';
  const e = mat.emissive && mat.emissive.getHexString ? mat.emissive.getHexString() : '-';
  let tex = '';
  for (const k in mat) { const v = mat[k]; if (v && v.isTexture) tex += k + '@' + (v.uuid || 'tex'); }
  return [f, c, e, mat.side || 0, mat.opacity, !!mat.transparent, !!mat.vertexColors, mat.roughness, mat.metalness,
    mesh ? !!mesh.receiveShadow : '-', tex].join('|');
}

/**
 * Every triangle of `group`, in the group's own frame, with its plane.
 * Returns [{ owner, look, name, n:[x,y,z], d, pts:[[x,y,z]x3] }].
 */
export function collectTriangles(THREE, group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const tris = [];
  let owner = 0;
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  group.traverse(o => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    if (o.visible === false) return;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const geo = o.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const count = idx ? idx.count : pos.count;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const groups = (Array.isArray(o.material) && geo.groups && geo.groups.length)
      ? geo.groups : [{ start: 0, count: count, materialIndex: 0 }];
    groups.forEach(g => {
      const mat = mats[g.materialIndex];
      if (!mat || mat.visible === false) return;
      const myOwner = owner++;
      const look = lookKey(mat, o);
      const end = Math.min(count, g.start + g.count);
      for (let i = g.start; i + 2 < end; i += 3) {
        const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
        va.fromBufferAttribute(pos, ia).applyMatrix4(m);
        vb.fromBufferAttribute(pos, ib).applyMatrix4(m);
        vc.fromBufferAttribute(pos, ic).applyMatrix4(m);
        e1.subVectors(vb, va); e2.subVectors(vc, va);
        n.crossVectors(e1, e2);
        const len = n.length();
        if (len < 1e-12) continue; // degenerate
        n.divideScalar(len);
        tris.push({
          owner: myOwner, look, name: o.name || '(unnamed)',
          n: [n.x, n.y, n.z], d: n.dot(va),
          pts: [[va.x, va.y, va.z], [vb.x, vb.y, vb.z], [vc.x, vc.y, vc.z]]
        });
      }
    });
  });
  return tris;
}

/** Project a 3D point onto the 2D basis (u, v) of a plane with normal n. */
function basisFor(n) {
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [n[1] * a[2] - n[2] * a[1], n[2] * a[0] - n[0] * a[2], n[0] * a[1] - n[1] * a[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u[0] /= ul; u[1] /= ul; u[2] /= ul;
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return { u, v };
}

/**
 * Find z-fighting face pairs in `group`.
 * @param {Object} THREE
 * @param {THREE.Object3D} group
 * @param {{tol?: number, minArea?: number, identicalLookExempt?: boolean}} [opts]
 *   tol      plane distance (m) under which two same-facing faces count as
 *            coplanar; default 0.001 (1 mm)
 *   minArea  overlap (m^2) below which a pair is ignored as a touching edge;
 *            default 1e-6 (1 mm^2)
 * @returns {{fights: Array, identical: Array}}  each entry
 *   { a, b, gap (m), area (m^2), normal }  -- a/b are mesh names
 */
export function findCoplanarFights(THREE, group, opts) {
  const o = opts || {};
  const tol = o.tol != null ? o.tol : 0.001;
  const minArea = o.minArea != null ? o.minArea : 1e-6;
  const exempt = o.identicalLookExempt !== false;
  const tris = collectTriangles(THREE, group);
  // Bucket by quantised normal so only same-facing triangles are compared.
  const buckets = new Map();
  tris.forEach(t => {
    const k = t.n.map(c => Math.round(c * 200)).join(',');
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  });
  const fights = [], identical = [];
  const seen = new Set();
  buckets.forEach(list => {
    list.sort((p, q) => p.d - q.d);
    for (let i = 0; i < list.length; i++) {
      const A = list[i];
      for (let j = i + 1; j < list.length && list[j].d - A.d < tol; j++) {
        const B = list[j];
        if (A.owner === B.owner) continue;
        const dot = A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2];
        if (dot < 0.9999) continue;
        const { u, v } = basisFor(A.n);
        const pr = p => [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]];
        const ta = ccw(A.pts.map(pr)), tb = ccw(B.pts.map(pr));
        const inter = clipPolygon(ta, tb);
        if (inter.length < 3) continue;
        const area = polyArea(inter);
        if (area <= minArea) continue;
        const key = Math.min(A.owner, B.owner) + '|' + Math.max(A.owner, B.owner) + '|' + A.n.map(c => Math.round(c * 200)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const rec = { a: A.name, b: B.name, gap: Math.abs(B.d - A.d), area, normal: A.n.map(c => +c.toFixed(3)) };
        if (exempt && A.look === B.look) identical.push(rec);
        else fights.push(rec);
      }
    }
  });
  return { fights, identical };
}
