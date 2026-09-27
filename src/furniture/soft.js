/**
 * soft.js - shared soft-form geometry for upholstered furniture.
 *
 * Not a furniture type (it is not in the registry): a small library the
 * builders import for shapes a BoxGeometry cannot make -- rounded boxes,
 * pillows, swept upholstered rails and draped cloth. Pure ESM with THREE
 * injected (no `import 'three'`), so it loads in Node tests, the live scene
 * and the spec pages alike.
 *
 * Every helper returns a plain, INDEXED BufferGeometry with `position` and
 * `normal` only -- no uv, no vertex colours, no groups -- so a part built from
 * it goes through merge.js exactly like a BoxGeometry part (finish bucket,
 * colour from its makeFinish() material). Units are whatever the caller
 * passes; the builders pass metres.
 */

/** Weld coincident vertices of a non-indexed position list into an indexed geometry. */
function weld(THREE, positions, tris) {
  const map = new Map();
  const outPos = [];
  const remap = new Array(positions.length / 3);
  const q = v => Math.round(v * 1e6);
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = q(x) + ',' + q(y) + ',' + q(z);
    let idx = map.get(key);
    if (idx === undefined) {
      idx = outPos.length / 3;
      outPos.push(x, y, z);
      map.set(key, idx);
    }
    remap[i] = idx;
  }
  const index = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = remap[tris[i]], b = remap[tris[i + 1]], c = remap[tris[i + 2]];
    if (a === b || b === c || a === c) continue; // collapsed by the weld
    index.push(a, b, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/**
 * Per-axis sample positions for a rounded box: `bevel` segments across each
 * corner band of width r, and `inner` segments across the flat middle.
 */
function axisSamples(half, r, bevel, inner, cuts) {
  const a = Math.max(0, half - r);
  const out = [];
  for (let i = 0; i <= bevel; i++) out.push(-half + (half - a) * i / bevel);
  if (Array.isArray(cuts)) {
    // Exact positions across the flat middle, replacing the even `inner`
    // split: sorted, de-duplicated, and kept only strictly inside it.
    const inside = cuts.filter(c => Number.isFinite(c) && c > -a + 1e-9 && c < a - 1e-9).sort((x, y) => x - y);
    for (const c of inside) if (Math.abs(c - out[out.length - 1]) > 1e-9) out.push(c);
  } else {
    for (let i = 1; i < inner; i++) out.push(-a + 2 * a * i / inner);
  }
  for (let i = 0; i <= bevel; i++) out.push(a + (half - a) * i / bevel);
  return out;
}

/**
 * A rounded box centred on the origin: every edge and corner rounded with
 * radius r (clamped to half the smallest side).
 *
 * @param {number} w, h, d  full sizes along x, y, z
 * @param {number} r        rounding radius
 * @param {{bevel?: number, inner?: number[], cuts?: Array, omit?: string[], displace?: Function}} [opts]
 *   bevel: segments per rounded band (default 2); inner: [nx, ny, nz]
 *   segments across each flat middle (default [1,1,1]); cuts: [xs, ys, zs],
 *   each null or a list of EXACT sample positions across that axis's flat
 *   middle, replacing its `inner` split (so a tuft dimple can land on a
 *   vertex at any size); omit: faces to leave out, any of '+x' '-x' '+y'
 *   '-y' '+z' '-z' (a face nobody can see, e.g. a mattress bottom inside its
 *   rails); displace(p) may move a vertex {x,y,z} in place (crown, tuft
 *   dimples) -- it is called after rounding, with the vertex's
 *   pre-displacement position.
 * Triangles: 4 * (sx*sy + sy*sz + sx*sz), with s = 2*bevel + inner (or
 * 2*bevel + the kept cuts + 1), less 2 * the grid of each omitted face.
 */
export function roundedBox(THREE, w, h, d, r, opts) {
  const o = opts || {};
  const bevel = Math.max(1, Math.round(o.bevel || 2));
  const inner = o.inner || [1, 1, 1];
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const rr = Math.max(1e-6, Math.min(r, hx, hy, hz));
  const cuts = o.cuts || [];
  const omit = new Set(o.omit || []);
  const ax = axisSamples(hx, rr, bevel, Math.max(1, inner[0]), cuts[0]);
  const ay = axisSamples(hy, rr, bevel, Math.max(1, inner[1]), cuts[1]);
  const az = axisSamples(hz, rr, bevel, Math.max(1, inner[2]), cuts[2]);
  const ix = hx - rr, iy = hy - rr, iz = hz - rr;
  const clamp = (v, m) => Math.max(-m, Math.min(m, v));

  const positions = [];
  const tris = [];
  function round(x, y, z) {
    const cx = clamp(x, ix), cy = clamp(y, iy), cz = clamp(z, iz);
    let dx = x - cx, dy = y - cy, dz = z - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-12) { dx = dx / len * rr; dy = dy / len * rr; dz = dz / len * rr; }
    const p = { x: cx + dx, y: cy + dy, z: cz + dz };
    if (o.displace) o.displace(p);
    return p;
  }
  // One face: a grid over (U, V) on the plane `axis = sign * half`, wound so
  // its normal points along +sign*axis.
  function face(U, V, place, flip) {
    const base = positions.length / 3;
    for (let j = 0; j < V.length; j++) {
      for (let i = 0; i < U.length; i++) {
        const p = place(U[i], V[j]);
        positions.push(p.x, p.y, p.z);
      }
    }
    const nu = U.length;
    for (let j = 0; j < V.length - 1; j++) {
      for (let i = 0; i < nu - 1; i++) {
        const a = base + j * nu + i, b = a + 1, c = a + nu, e = c + 1;
        if (flip) tris.push(a, c, b, b, c, e);
        else tris.push(a, b, c, b, e, c);
      }
    }
  }
  // +y / -y (U = x, V = z)
  if (!omit.has('+y')) face(ax, az, (u, v) => round(u, hy, v), true);
  if (!omit.has('-y')) face(ax, az, (u, v) => round(u, -hy, v), false);
  // +x / -x (U = z, V = y)
  if (!omit.has('+x')) face(az, ay, (u, v) => round(hx, v, u), true);
  if (!omit.has('-x')) face(az, ay, (u, v) => round(-hx, v, u), false);
  // +z / -z (U = x, V = y)
  if (!omit.has('+z')) face(ax, ay, (u, v) => round(u, v, hz), false);
  if (!omit.has('-z')) face(ax, ay, (u, v) => round(u, v, -hz), true);
  return weld(THREE, positions, tris);
}

/**
 * A pillow centred on the origin: w along x, d along z, h the full puffed
 * thickness along y at the centre, pinching to a seam (zero thickness) at
 * the edge -- the shape a filled fabric case actually takes. The mid-edges
 * are drawn in slightly so the corners read as the case's sewn corners.
 * seg x seg quads per side: 4 * seg^2 - 4 triangles (the flat seam corners dropped).
 */
export function pillow(THREE, w, h, d, seg) {
  const n = Math.max(2, Math.round(seg || 4));
  const positions = [];
  const tris = [];
  const rows = n + 1;
  for (const side of [1, -1]) {
    const base = positions.length / 3;
    for (let j = 0; j <= n; j++) {
      const v = -1 + 2 * j / n;
      for (let i = 0; i <= n; i++) {
        const u = -1 + 2 * i / n;
        const puff = Math.pow(Math.max(0, 1 - u * u), 0.45) * Math.pow(Math.max(0, 1 - v * v), 0.45);
        const pinchX = 1 - 0.07 * (1 - v * v);
        const pinchZ = 1 - 0.07 * (1 - u * u);
        positions.push(u * w / 2 * pinchX, side * puff * h / 2, v * d / 2 * pinchZ);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = base + j * rows + i, b = a + 1, c = a + rows, e = c + 1;
        // The two outer corner triangles lie flat in the seam plane (all
        // three vertices on the zero-thickness seam): a fin with no volume,
        // coincident top and bottom. Drop them; the neighbours close it.
        const corner = (i === 0 && j === 0) || (i === n - 1 && j === n - 1);
        const t1 = side > 0 ? [a, c, b] : [a, b, c];
        const t2 = side > 0 ? [b, c, e] : [b, e, c];
        if (!(corner && i === 0)) tris.push(...t1);
        if (!(corner && i === n - 1)) tris.push(...t2);
      }
    }
  }
  return weld(THREE, positions, tris);
}

/**
 * Sweep a closed 2D profile along an open polyline path.
 *
 * `profile` is a list of [a, b] points going ANTI-CLOCKWISE when a is drawn
 * to the right and b up. `a` is the offset along the path's left-hand
 * normal... more usefully: for plane 'xz' (a floor-plan path; b is height y)
 * a is the horizontal offset to the path's RIGHT; for plane 'xy' (a path in
 * an upright wall plane; b is depth z) a is the in-plane offset to the
 * path's RIGHT. Either way the builders pass a profile whose outward side is
 * where they want it; tests assert normals point away from the path.
 *
 * @param {Array<[number,number]>} profile  closed cross-section
 * @param {Array<[number,number]>} path     2D path points (x,z) or (x,y)
 * @param {{plane?: 'xz'|'xy', caps?: boolean}} [opts]
 */
export function sweep(THREE, profile, path, opts) {
  const o = opts || {};
  const plane = o.plane || 'xz';
  const positions = [];
  const tris = [];
  const np = profile.length;
  const n = path.length;
  // Per path point: its right-hand normal, mitred between the two segments
  // (the bisector of the unit in/out directions, scaled by 1/cos of the
  // half-turn so the swept wall keeps its thickness round a corner).
  const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  const normals = path.map((p, i) => {
    const din = i > 0 ? unit(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) : null;
    const dout = i < n - 1 ? unit(path[i + 1][0] - p[0], path[i + 1][1] - p[1]) : null;
    const d0 = din || dout, d1 = dout || din;
    const [tx, ty] = unit(d0[0] + d1[0], d0[1] + d1[1]);
    const scale = 1 / Math.max(0.5, tx * d0[0] + ty * d0[1]);
    return [ty * scale, -tx * scale];
  });
  for (let i = 0; i < n; i++) {
    const [px, py] = path[i];
    const [nx, ny] = normals[i];
    for (let k = 0; k < np; k++) {
      const [a, b] = profile[k];
      if (plane === 'xz') positions.push(px + nx * a, b, py + ny * a);
      else positions.push(px + nx * a, py + ny * a, b);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < np; k++) {
      const k2 = (k + 1) % np;
      const a = i * np + k, b = i * np + k2, c = (i + 1) * np + k, e = (i + 1) * np + k2;
      if (plane === 'xz') tris.push(a, b, c, b, e, c);
      else tris.push(a, c, b, b, c, e);
    }
  }
  const g = weld(THREE, positions, tris);
  if (!o.caps) return g;
  // Flat caps (a fan from the profile centroid) at both ends, as separate
  // vertices so the cap stays flat-shaded against the rounded sides.
  const pos = Array.from(g.attributes.position.array);
  const idx = Array.from(g.index.array);
  const cen = profile.reduce((s, p) => [s[0] + p[0] / np, s[1] + p[1] / np], [0, 0]);
  const put = (i, a, b) => {
    const [px, py] = path[i];
    const [nx, ny] = normals[i];
    if (plane === 'xz') pos.push(px + nx * a, b, py + ny * a);
    else pos.push(px + nx * a, py + ny * a, b);
    return pos.length / 3 - 1;
  };
  for (const end of [0, n - 1]) {
    // The cap must face away from the path: -tangent at the start, +tangent
    // at the end. Wind the first fan triangle, measure, flip if needed.
    const other = end === 0 ? path[1] : path[n - 2];
    const out = unit(path[end][0] - other[0], path[end][1] - other[1]);
    const c = put(end, cen[0], cen[1]);
    const ring = profile.map(p => put(end, p[0], p[1]));
    const v = i => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const A = v(c), B = v(ring[0]), C = v(ring[1]);
    const u1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], u2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const nrm = [u1[1] * u2[2] - u1[2] * u2[1], u1[2] * u2[0] - u1[0] * u2[2], u1[0] * u2[1] - u1[1] * u2[0]];
    const along = plane === 'xz' ? nrm[0] * out[0] + nrm[2] * out[1] : nrm[0] * out[0] + nrm[1] * out[1];
    const flip = along < 0;
    for (let k = 0; k < np; k++) {
      const a = ring[k], b = ring[(k + 1) % np];
      if (flip) idx.push(c, b, a); else idx.push(c, a, b);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  out.computeVertexNormals();
  return out;
}

/**
 * A cloth surface: a grid over cloth coordinates (s, t) mapped to 3D by
 * `map(s, t) -> {x, y, z}`. With s increasing along +x and t along +z the
 * face normal points up (+y) -- i.e. the side the map puts "outside".
 * Returns the geometry; the caller keeps `map` to place anything that must
 * follow the cloth (a print, a hem).
 */
export function clothSheet(THREE, map, sList, tList) {
  const positions = [];
  const tris = [];
  const ns = sList.length;
  for (let j = 0; j < tList.length; j++) {
    for (let i = 0; i < ns; i++) {
      const p = map(sList[i], tList[j]);
      positions.push(p.x, p.y, p.z);
    }
  }
  for (let j = 0; j < tList.length - 1; j++) {
    for (let i = 0; i < ns - 1; i++) {
      const a = j * ns + i, b = a + 1, c = a + ns, e = c + 1;
      tris.push(a, c, b, b, c, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(tris);
  g.computeVertexNormals();
  return g;
}

/**
 * Concatenate indexed or non-indexed geometries (position + normal only)
 * into one indexed geometry, e.g. 36 black keys as ONE mesh. Each input's
 * own transform must already be baked in (geometry.translate/rotate).
 */
export function concatGeometries(THREE, geos) {
  const pos = [], nor = [], idx = [];
  for (const g of geos) {
    const base = pos.length / 3;
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      if (n) nor.push(n.getX(i), n.getY(i), n.getZ(i)); else nor.push(0, 1, 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) idx.push(base + i);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setIndex(idx);
  return out;
}

/** Triangle count of a geometry (indexed or not). */
export function triCount(geo) {
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
}

/** A small deterministic PRNG (mulberry32), so a print is identical every build. */
export function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
