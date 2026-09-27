#!/usr/bin/env node
/**
 * soft.js: the shared soft-form geometry the upholstered builders use.
 * No framework, no install: `node scripts/test-soft.mjs`.
 *
 * What a screenshot cannot pin down, and a wrong sign would silently break:
 *   1. roundedBox builds to exactly w x h x d, its corners are actually
 *      rounded (the corner vertex is pulled in from the bbox corner), and
 *      every triangle faces OUTWARD (a flipped face is invisible from outside
 *      under back-face culling -- the box would render with holes).
 *   2. pillow is thin at the seam and full at the centre, and faces outward.
 *   3. sweep keeps the profile's thickness along the path, faces away from
 *      the path, and its caps close the ends.
 *   4. clothSheet faces up (+y) for s along +x and t along +z -- the
 *      convention bed.js relies on for the duvet and its print.
 *   5. concatGeometries keeps every input's triangles; prng is deterministic.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const THREE = await imp('vendor/three-r160/three.module.min.js');
const S = await imp('src/furniture/soft.js');

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/**
 * Fraction of triangles whose geometric normal points away from `inside(c)`
 * -- a function giving, for a triangle centroid c, a point known to be on
 * the inner side of that triangle.
 */
function outwardFraction(geo, inside) {
  const p = geo.attributes.position, idx = geo.index;
  const n = idx ? idx.count / 3 : p.count / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let ok = 0, total = 0;
  for (let t = 0; t < n; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2);
    const nrm = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (nrm.lengthSq() < 1e-20) continue;
    const cen = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    const inn = inside(cen);
    total++;
    if (nrm.dot(cen.clone().sub(inn)) > 0) ok++;
  }
  return total ? ok / total : 0;
}

// ---- roundedBox --------------------------------------------------------------
{
  const w = 1.5, h = 0.24, d = 2.0, r = 0.04;
  const g = S.roundedBox(THREE, w, h, d, r, { bevel: 2, inner: [2, 1, 2] });
  g.computeBoundingBox();
  const bb = g.boundingBox;
  check('roundedBox: bbox width == w', near(bb.max.x - bb.min.x, w, 1e-5), bb.max.x - bb.min.x);
  check('roundedBox: bbox height == h', near(bb.max.y - bb.min.y, h, 1e-5), bb.max.y - bb.min.y);
  check('roundedBox: bbox depth == d', near(bb.max.z - bb.min.z, d, 1e-5), bb.max.z - bb.min.z);
  // Corner rounded: no vertex sits at the sharp corner; the one nearest it is
  // pulled in by r*(1 - 1/sqrt(3)) along each axis at best (a sphere corner).
  const p = g.attributes.position;
  let nearest = Infinity;
  for (let i = 0; i < p.count; i++) {
    const dist = Math.hypot(w / 2 - p.getX(i), h / 2 - p.getY(i), d / 2 - p.getZ(i));
    nearest = Math.min(nearest, dist);
  }
  const expect = r * (Math.sqrt(3) - 1); // distance from a box corner to its rounded-corner sphere
  check('roundedBox: the corner is rounded (nearest vertex >= 0.9 * the sphere offset from the sharp corner)',
    nearest >= expect * 0.9, { nearest, expect });
  const frac = outwardFraction(g, () => new THREE.Vector3(0, 0, 0));
  check('roundedBox: every triangle faces outward', frac === 1, frac);
  // triangle formula: s = 2*bevel + inner
  const sx = 6, sy = 5, sz = 6;
  check('roundedBox: triangle count == 4*(sx*sy + sy*sz + sx*sz)', S.triCount(g) === 4 * (sx * sy + sy * sz + sx * sz), S.triCount(g));
  // displace is applied
  const gd = S.roundedBox(THREE, w, h, d, r, { bevel: 2, inner: [2, 1, 2], displace: v => { if (v.y > 0) v.y += 0.015 * (1 - Math.min(1, Math.abs(v.x) / (w / 2))); } });
  gd.computeBoundingBox();
  check('roundedBox: displace moves the top (crown lifts the max y)', gd.boundingBox.max.y > h / 2 + 0.01, gd.boundingBox.max.y);

  // cuts: exact sample positions across a flat middle (a tuft dimple must
  // land on a vertex at any size). Mutation: ignore `cuts` in axisSamples
  // (keep the even `inner` split) -> no top vertex at x = 0.123 / z = -0.4.
  const gc = S.roundedBox(THREE, w, h, d, r, { bevel: 2, inner: [2, 1, 2], cuts: [[0.123, -0.3, 0.123, 9], null, [-0.4]] });
  const pc = gc.attributes.position;
  const topAt = (x, z) => { for (let i = 0; i < pc.count; i++) if (near(pc.getX(i), x, 1e-6) && near(pc.getZ(i), z, 1e-6) && pc.getY(i) > 0) return true; return false; };
  check('roundedBox cuts: a top vertex at every cut crossing', topAt(0.123, -0.4) && topAt(-0.3, -0.4), null);
  // 2 kept x cuts (0.123 de-duplicated, 9 outside the flat middle dropped),
  // 1 z cut: sx = 4 + 3, sy = 5, sz = 4 + 2
  check('roundedBox cuts: replace inner, de-duplicated, outside cuts dropped', S.triCount(gc) === 4 * (7 * 5 + 5 * 6 + 7 * 6), S.triCount(gc));
  gc.computeBoundingBox();
  check('roundedBox cuts: bbox unchanged', near(gc.boundingBox.max.x - gc.boundingBox.min.x, w, 1e-5) && near(gc.boundingBox.max.z - gc.boundingBox.min.z, d, 1e-5));

  // omit: a face left out. Mutation: ignore `omit` -> the count stays whole.
  const go = S.roundedBox(THREE, w, h, d, r, { bevel: 2, inner: [2, 1, 2], omit: ['-y'] });
  check('roundedBox omit -y: drops exactly the bottom grid (2*sx*sz)', S.triCount(go) === S.triCount(g) - 2 * sx * sz, [S.triCount(go), S.triCount(g)]);
  const frac2 = outwardFraction(go, () => new THREE.Vector3(0, 0, 0));
  check('roundedBox omit -y: what is left still faces outward', frac2 === 1, frac2);
}

// ---- pillow ------------------------------------------------------------------
{
  const w = 0.72, h = 0.12, d = 0.5;
  const g = S.pillow(THREE, w, h, d, 4);
  g.computeBoundingBox();
  const bb = g.boundingBox;
  check('pillow: full thickness h at the centre', near(bb.max.y - bb.min.y, h, 1e-5), bb.max.y - bb.min.y);
  const p = g.attributes.position;
  let seamMax = 0;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(Math.abs(p.getX(i)) - w / 2) < 1e-4) seamMax = Math.max(seamMax, Math.abs(p.getY(i)));
  }
  check('pillow: the side seam is pinched to zero thickness', seamMax < 1e-6, seamMax);
  check('pillow: triangles == 4*seg^2 - 4 (flat seam corners dropped)', S.triCount(g) === 60, S.triCount(g));
  const frac = outwardFraction(g, () => new THREE.Vector3(0, 0, 0));
  check('pillow: every triangle faces outward', frac === 1, frac);
}

// ---- sweep -------------------------------------------------------------------
{
  // A 0.06 wide rail, 0.35 tall, with a round top, swept along a U in xz.
  const prof = [[-0.03, 0], [0.03, 0], [0.03, 0.32], [0.02, 0.342], [0, 0.35], [-0.02, 0.342], [-0.03, 0.32]];
  const U = [[-0.8, 0.1], [-0.8, 2.0], [-0.7, 2.1], [0.7, 2.1], [0.8, 2.0], [0.8, 0.1]];
  const g = S.sweep(THREE, prof, U, { plane: 'xz' });
  g.computeBoundingBox();
  const bb = g.boundingBox;
  check('sweep xz: height from the profile', near(bb.max.y, 0.35, 1e-5) && near(bb.min.y, 0, 1e-5), [bb.min.y, bb.max.y]);
  check('sweep xz: side rail thickness held (x extent = 1.6 + 0.06)', near(bb.max.x - bb.min.x, 1.66, 1e-4), bb.max.x - bb.min.x);
  // Outward = away from the path centreline at the same height.
  function nearestOnPath(c) {
    let best = null, bd = Infinity;
    for (let i = 0; i < U.length - 1; i++) {
      const [ax, az] = U[i], [bx, bz] = U[i + 1];
      const vx = bx - ax, vz = bz - az;
      const t = Math.max(0, Math.min(1, ((c.x - ax) * vx + (c.z - az) * vz) / (vx * vx + vz * vz)));
      const px = ax + vx * t, pz = az + vz * t;
      const dd = Math.hypot(c.x - px, c.z - pz);
      if (dd < bd) { bd = dd; best = new THREE.Vector3(px, 0.2, pz); }
    }
    return best;
  }
  const frac = outwardFraction(g, nearestOnPath);
  check('sweep xz: >= 97% of triangles face away from the path (the rest are profile-corner slivers)', frac >= 0.97, frac);
  const gc = S.sweep(THREE, prof, U, { plane: 'xz', caps: true });
  check('sweep: caps add 2 * profile.length triangles', S.triCount(gc) === S.triCount(g) + 2 * prof.length, [S.triCount(gc), S.triCount(g)]);
  // The caps are the last 2 * profile.length triangles: each must face away
  // from the path along its end tangent (-z at the start, which runs +z;
  // -z at the end too, since the U comes back down toward z = 0.1).
  {
    const p = gc.attributes.position, idx = gc.index;
    const nt = idx.count / 3;
    let good = 0;
    for (let t = nt - 2 * prof.length; t < nt; t++) {
      const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, idx.getX(t * 3 + k)));
      const nrm = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0]));
      if (nrm.z < 0) good++;
    }
    check('sweep caps: every cap triangle faces out of the open end (-z at both ends of this U)', good === 2 * prof.length, good);
  }

  // plane 'xy': an inverted U in an upright plane, profile depth along z.
  const profXY = [[-0.035, 0], [0.035, 0], [0.035, 0.06], [0.01, 0.1], [-0.01, 0.1], [-0.035, 0.06]];
  const inv = [[-0.75, 0.03], [-0.75, 1.1], [-0.7, 1.15], [0.7, 1.15], [0.75, 1.1], [0.75, 0.03]];
  const gx = S.sweep(THREE, profXY, inv, { plane: 'xy', caps: true });
  gx.computeBoundingBox();
  check('sweep xy: depth from the profile (z 0..0.1)', near(gx.boundingBox.min.z, 0, 1e-5) && near(gx.boundingBox.max.z, 0.1, 1e-5));
  function nearestXY(c) {
    let best = null, bd = Infinity;
    for (let i = 0; i < inv.length - 1; i++) {
      const [ax, ay] = inv[i], [bx, by] = inv[i + 1];
      const vx = bx - ax, vy = by - ay;
      const t = Math.max(0, Math.min(1, ((c.x - ax) * vx + (c.y - ay) * vy) / (vx * vx + vy * vy)));
      const px = ax + vx * t, py = ay + vy * t;
      const dd = Math.hypot(c.x - px, c.y - py);
      if (dd < bd) { bd = dd; best = new THREE.Vector3(px, py, 0.05); }
    }
    return best;
  }
  const fx = outwardFraction(gx, nearestXY);
  check('sweep xy: >= 97% of triangles face away from the path', fx >= 0.97, fx);
}

// ---- clothSheet --------------------------------------------------------------
{
  const g = S.clothSheet(THREE, (s, t) => ({ x: s, y: 0.5 - 0.05 * s * s, z: t }), [-1, -0.5, 0, 0.5, 1], [0, 1, 2]);
  const frac = outwardFraction(g, c => new THREE.Vector3(c.x, c.y - 1, c.z));
  check('clothSheet: faces up for s along +x, t along +z', frac === 1, frac);
  check('clothSheet: (ns-1)*(nt-1)*2 triangles', S.triCount(g) === 16, S.triCount(g));
}

// ---- concat + prng -------------------------------------------------------------
{
  const a = new THREE.BoxGeometry(1, 1, 1).translate(2, 0, 0);
  const b = new THREE.BoxGeometry(1, 1, 1);
  const c = S.concatGeometries(THREE, [a, b]);
  check('concat: triangles add up', S.triCount(c) === 24, S.triCount(c));
  c.computeBoundingBox();
  check('concat: transforms kept', near(c.boundingBox.max.x, 2.5, 1e-6));
  const r1 = S.prng(42), r2 = S.prng(42), r3 = S.prng(43);
  const s1 = [r1(), r1(), r1()], s2 = [r2(), r2(), r2()], s3 = [r3(), r3(), r3()];
  check('prng: same seed, same sequence', s1.every((v, i) => v === s2[i]));
  check('prng: different seed, different sequence', s1.some((v, i) => v !== s3[i]));
  check('prng: in [0,1)', s1.concat(s3).every(v => v >= 0 && v < 1));
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
