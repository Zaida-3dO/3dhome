#!/usr/bin/env node
// ---------------------------------------------------------------------------
// model-lod.mjs - turn a heavy GLB into a small two-LOD GLB for the `model`
// furniture type (src/furniture/model.js).
//
// OFFLINE TOOL. Not served, not run in CI. It has its own package.json and
// lockfile so a run is reproducible:
//
//   cd scripts/model-lod && npm ci
//   node model-lod.mjs <in.glb> <out.glb> [options]
//
// Options:
//   --drop-node <name>   drop a node (and its mesh) before anything else;
//                        repeatable, or comma-separated. Use it for parts that
//                        are never seen (an under-seat mechanism, a hidden box).
//   --target <n>         full-LOD triangle budget            (default 2500)
//   --low <n>            low-LOD triangle budget             (default 800)
//   --bake vcol|atlas512 how colour survives                  (default vcol)
//                          vcol      sample every base-colour texture at every
//                                    source vertex into COLOR_0, then drop the
//                                    UVs and textures. One primitive, flat
//                                    palette material: joins the renderer's
//                                    merged palette bucket (0 extra draws).
//                          atlas512  shrink up to 4 textures to 256 px and
//                                    pack them 2x2 into one 512 px atlas; UVs
//                                    are remapped into their quadrant. Kept
//                                    for comparison (costs a draw + texture).
//   --gain <k>           multiply baked colours by k (e.g. 1.2 to undo the
//                        darkening of lighting baked into the source maps)
//   --color-weight <w>   how hard the simplifier protects colour edges
//                        (default 0.5)
//
// Output: a GLB whose scene has two root nodes, `full` and `low`. The model
// type uses `low` for detail:'low' and everything else for full. Positions
// are in the source's own units and orientation (every node transform is
// baked in); the model type fits the result to the item's cm envelope.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import crypto from 'node:crypto';
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import jpeg from 'jpeg-js';

function parseArgs(argv) {
  const o = { drop: [], target: 2500, low: 800, bake: 'vcol', gain: 1, colorWeight: 0.5, _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(a + ' needs a value'); return argv[++i]; };
    if (a === '--drop-node') o.drop.push(...next().split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--target') o.target = parseInt(next(), 10);
    else if (a === '--low') o.low = parseInt(next(), 10);
    else if (a === '--bake') o.bake = next();
    else if (a === '--gain') o.gain = parseFloat(next());
    else if (a === '--color-weight') o.colorWeight = parseFloat(next());
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else o._.push(a);
  }
  if (o._.length !== 2) throw new Error('usage: node model-lod.mjs <in.glb> <out.glb> [options]');
  if (!['vcol', 'atlas512'].includes(o.bake)) throw new Error('--bake must be vcol or atlas512');
  return o;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// sRGB (0..1) -> linear, the space glTF vertex colours are in.
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function decodeImage(tex) {
  const mime = tex.getMimeType();
  if (mime !== 'image/jpeg') throw new Error('only JPEG base-colour textures are supported (got ' + mime + ')');
  const img = jpeg.decode(Buffer.from(tex.getImage()), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return { w: img.width, h: img.height, data: img.data };
}

// Bilinear sample, REPEAT wrapping (the glTF default), glTF uv (v down).
function sample(img, u, v) {
  const x = (u - Math.floor(u)) * img.w - 0.5, y = (v - Math.floor(v)) * img.h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const px = (xx, yy) => {
    const xi = ((xx % img.w) + img.w) % img.w, yi = ((yy % img.h) + img.h) % img.h;
    const k = (yi * img.w + xi) * 4;
    return [img.data[k] / 255, img.data[k + 1] / 255, img.data[k + 2] / 255];
  };
  const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = (a[i] * (1 - fx) + b[i] * fx) * (1 - fy) + (c[i] * (1 - fx) + d[i] * fx) * fy;
  }
  return out;
}

// Box-filter shrink to size x size (RGBA).
function shrink(img, size) {
  const out = new Uint8Array(size * size * 4);
  const sx = img.w / size, sy = img.h / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0]; let n = 0;
      for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) {
        for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
          const k = (yy * img.w + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c] += img.data[k + c];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / Math.max(1, n));
    }
  }
  return out;
}

// 4x4 column-major matrix helpers (glTF's layout).
function mulPoint(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}
function normalMatrix(m) {
  // inverse-transpose of the upper 3x3
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d
  ].map(v => v / det);
  // inv is row-major inverse; its transpose applied to n:
  return (x, y, z) => {
    const nx = inv[0] * x + inv[3] * y + inv[6] * z;
    const ny = inv[1] * x + inv[4] * y + inv[7] * z;
    const nz = inv[2] * x + inv[5] * y + inv[8] * z;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };
}

/** Gather every kept primitive, transforms baked, as plain arrays. */
function gather(doc, drop) {
  const prims = [];
  const dropped = [];
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  scene.traverse(node => {
    const mesh = node.getMesh();
    if (!mesh) return;
    // A dropped node drops its own mesh; ancestors are checked by name too.
    for (let n = node; n; n = n.getParentNode()) {
      if (drop.includes(n.getName())) { dropped.push(node.getName()); return; }
    }
    const m = node.getWorldMatrix();
    const nm = normalMatrix(m);
    mesh.listPrimitives().forEach(p => {
      const pos = p.getAttribute('POSITION'), nor = p.getAttribute('NORMAL'), uv = p.getAttribute('TEXCOORD_0');
      const count = pos.getCount();
      const P = new Float32Array(count * 3), N = new Float32Array(count * 3), U = uv ? new Float32Array(count * 2) : null;
      const t = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        pos.getElement(i, t);
        P.set(mulPoint(m, t[0], t[1], t[2]), i * 3);
        if (nor) { nor.getElement(i, t); N.set(nm(t[0], t[1], t[2]), i * 3); }
        if (U) { uv.getElement(i, t); U[i * 2] = t[0]; U[i * 2 + 1] = t[1]; }
      }
      const idx = p.getIndices();
      const I = idx ? Uint32Array.from(idx.getArray()) : Uint32Array.from({ length: count }, (_, i) => i);
      const mat = p.getMaterial();
      prims.push({
        node: node.getName(), P, N, U, I, count,
        factor: mat ? mat.getBaseColorFactor() : [1, 1, 1, 1],
        texture: mat ? mat.getBaseColorTexture() : null
      });
    });
  });
  return { prims, dropped };
}

/** Weld vertices that share a position (and uv, when kept). Attributes are averaged. */
function weld(P, N, C, U, I) {
  const count = P.length / 3;
  const map = new Map();
  const remap = new Uint32Array(count);
  const outP = [], outN = [], outC = [], outU = [], hits = [];
  const q = v => Math.round(v * 1e5);
  for (let i = 0; i < count; i++) {
    let key = q(P[i * 3]) + ',' + q(P[i * 3 + 1]) + ',' + q(P[i * 3 + 2]);
    if (U) key += '|' + q(U[i * 2]) + ',' + q(U[i * 2 + 1]);
    let j = map.get(key);
    if (j === undefined) {
      j = hits.length; map.set(key, j); hits.push(0);
      outP.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      outN.push(0, 0, 0);
      if (C) outC.push(0, 0, 0);
      if (U) outU.push(U[i * 2], U[i * 2 + 1]);
    }
    remap[i] = j;
    hits[j]++;
    for (let c = 0; c < 3; c++) outN[j * 3 + c] += N[i * 3 + c];
    if (C) for (let c = 0; c < 3; c++) outC[j * 3 + c] += C[i * 3 + c];
  }
  for (let j = 0; j < hits.length; j++) {
    const l = Math.hypot(outN[j * 3], outN[j * 3 + 1], outN[j * 3 + 2]) || 1;
    for (let c = 0; c < 3; c++) outN[j * 3 + c] /= l;
    if (C) for (let c = 0; c < 3; c++) outC[j * 3 + c] /= hits[j];
  }
  const outI = new Uint32Array(I.length);
  for (let k = 0; k < I.length; k++) outI[k] = remap[I[k]];
  return {
    P: new Float32Array(outP), N: new Float32Array(outN),
    C: C ? new Float32Array(outC) : null, U: U ? new Float32Array(outU) : null, I: outI
  };
}

/** Simplify to <= target triangles; returns compacted arrays and what it achieved. */
function simplify(mesh, target, colorWeight) {
  const S = MeshoptSimplifier;
  const tris = mesh.I.length / 3;
  if (tris <= target) return Object.assign({ method: 'none' }, mesh);
  // Attributes the error metric protects: normals always, colour when baked.
  const stride = mesh.C ? 6 : 3;
  const attrs = new Float32Array((mesh.P.length / 3) * stride);
  for (let i = 0; i < mesh.P.length / 3; i++) {
    attrs.set(mesh.N.subarray(i * 3, i * 3 + 3), i * stride);
    if (mesh.C) attrs.set(mesh.C.subarray(i * 3, i * 3 + 3), i * stride + 3);
  }
  const weights = mesh.C ? [0.25, 0.25, 0.25, colorWeight, colorWeight, colorWeight] : [0.25, 0.25, 0.25];
  let [idx] = S.simplifyWithAttributes(mesh.I, mesh.P, 3, attrs, stride, weights, null, target * 3, 1.0, ['Prune']);
  let method = 'attributes';
  if (idx.length / 3 > target) {
    [idx] = S.simplifySloppy(idx, mesh.P, 3, null, target * 3, 1.0);
    method = 'attributes+sloppy';
  }
  // Compact: keep only the vertices the new index buffer uses.
  const used = new Map();
  const order = [];
  const outI = new Uint32Array(idx.length);
  for (let k = 0; k < idx.length; k++) {
    let j = used.get(idx[k]);
    if (j === undefined) { j = order.length; used.set(idx[k], j); order.push(idx[k]); }
    outI[k] = j;
  }
  const pick = (arr, n) => {
    if (!arr) return null;
    const out = new Float32Array(order.length * n);
    order.forEach((v, j) => out.set(arr.subarray(v * n, v * n + n), j * n));
    return out;
  };
  return { P: pick(mesh.P, 3), N: pick(mesh.N, 3), C: pick(mesh.C, 3), U: pick(mesh.U, 2), I: outI, method };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  return (async () => {
    await MeshoptSimplifier.ready;
    const inBuf = fs.readFileSync(o._[0]);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const src = await io.readBinary(new Uint8Array(inBuf));
    const { prims, dropped } = gather(src, o.drop);
    if (o.drop.length && !dropped.length) throw new Error('--drop-node matched nothing: ' + o.drop.join(', '));
    const srcTris = prims.reduce((s, p) => s + p.I.length / 3, 0);

    // ---- colour ------------------------------------------------------------
    const images = new Map();   // texture -> decoded
    const decoded = t => { if (!images.has(t)) images.set(t, decodeImage(t)); return images.get(t); };
    let atlas = null;
    const atlasSlot = new Map(); // texture -> quadrant index
    if (o.bake === 'atlas512') {
      const texs = Array.from(new Set(prims.map(p => p.texture).filter(Boolean)));
      if (texs.length > 4) throw new Error('atlas512 packs at most 4 textures (found ' + texs.length + ')');
      atlas = new Uint8Array(512 * 512 * 4).fill(255);
      texs.forEach((t, q) => {
        atlasSlot.set(t, q);
        const small = shrink(decoded(t), 256);
        const ox = (q % 2) * 256, oy = Math.floor(q / 2) * 256;
        for (let y = 0; y < 256; y++) atlas.set(small.subarray(y * 256 * 4, (y + 1) * 256 * 4), ((oy + y) * 512 + ox) * 4);
      });
    }

    // One merged mesh (vcol), or textured + flat (atlas512).
    const groups = o.bake === 'vcol' ? [prims] : [prims.filter(p => p.texture), prims.filter(p => !p.texture)];
    const merged = groups.filter(g => g.length).map(group => {
      const textured = o.bake === 'atlas512' && !!group[0].texture;
      let n = 0, m = 0;
      group.forEach(p => { n += p.count; m += p.I.length; });
      const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
      const C = o.bake === 'vcol' ? new Float32Array(n * 3) : null;
      const U = textured ? new Float32Array(n * 2) : null;
      const I = new Uint32Array(m);
      let vo = 0, io2 = 0;
      let flat = null;
      group.forEach(p => {
        P.set(p.P, vo * 3); N.set(p.N, vo * 3);
        for (let k = 0; k < p.I.length; k++) I[io2 + k] = p.I[k] + vo;
        const f = p.factor;
        if (C) {
          const img = p.texture ? decoded(p.texture) : null;
          for (let i = 0; i < p.count; i++) {
            const s = img && p.U ? sample(img, p.U[i * 2], p.U[i * 2 + 1]).map(srgbToLinear) : [1, 1, 1];
            for (let c = 0; c < 3; c++) C[(vo + i) * 3 + c] = Math.min(1, s[c] * f[c] * o.gain);
          }
        }
        if (U) {
          const q = atlasSlot.get(p.texture);
          const ox = (q % 2) * 0.5, oy = Math.floor(q / 2) * 0.5;
          for (let i = 0; i < p.count; i++) {
            const u = p.U[i * 2], v = p.U[i * 2 + 1];
            if (u < -1e-4 || u > 1 + 1e-4 || v < -1e-4 || v > 1 + 1e-4) {
              throw new Error('atlas512: node ' + p.node + ' has UVs outside [0,1] (' + u + ', ' + v + ') -- cannot pack');
            }
            U[(vo + i) * 2] = ox + Math.min(1, Math.max(0, u)) * 0.5;
            U[(vo + i) * 2 + 1] = oy + Math.min(1, Math.max(0, v)) * 0.5;
          }
        }
        if (!textured && o.bake === 'atlas512') flat = f;
        vo += p.count; io2 += p.I.length;
      });
      return { mesh: weld(P, N, C, U, I), textured, flat };
    });

    // Budget split across groups by triangle share.
    const total = merged.reduce((s, g) => s + g.mesh.I.length / 3, 0);
    const lods = { full: [], low: [] };
    for (const [name, budget] of [['full', o.target], ['low', o.low]]) {
      merged.forEach(g => {
        const share = Math.max(12, Math.floor(budget * (g.mesh.I.length / 3) / total));
        lods[name].push(Object.assign({ textured: g.textured, flat: g.flat }, simplify(g.mesh, share, o.colorWeight)));
      });
    }

    // ---- write -------------------------------------------------------------
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene('model');
    let atlasTex = null;
    if (atlas) {
      // Encode the atlas as JPEG (quality 85).
      const jpg = jpeg.encode({ data: Buffer.from(atlas), width: 512, height: 512 }, 85).data;
      atlasTex = doc.createTexture('atlas').setImage(new Uint8Array(jpg)).setMimeType('image/jpeg');
    }
    const report = { input: o._[0], inputSha256: sha256(inBuf), dropped, sourceTriangles: srcTris, bake: o.bake, gain: o.gain, lods: {} };
    for (const name of ['full', 'low']) {
      const mesh = doc.createMesh(name);
      let tris = 0, verts = 0; const methods = [];
      lods[name].forEach(l => {
        const mat = doc.createMaterial(name + (l.textured ? '-tex' : ''))
          .setBaseColorFactor(l.flat ? [l.flat[0], l.flat[1], l.flat[2], 1] : [1, 1, 1, 1])
          .setMetallicFactor(0).setRoughnessFactor(0.8);
        if (l.textured) mat.setBaseColorTexture(atlasTex);
        const prim = doc.createPrimitive().setMaterial(mat)
          .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(l.P).setBuffer(buffer))
          .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(l.N).setBuffer(buffer))
          .setIndices(doc.createAccessor().setType('SCALAR')
            .setArray(l.P.length / 3 < 65536 ? Uint16Array.from(l.I) : l.I).setBuffer(buffer));
        if (l.C) prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(l.C).setBuffer(buffer));
        if (l.U) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(l.U).setBuffer(buffer));
        mesh.addPrimitive(prim);
        tris += l.I.length / 3; verts += l.P.length / 3; methods.push(l.method);
      });
      scene.addChild(doc.createNode(name).setMesh(mesh));
      report.lods[name] = { triangles: tris, vertices: verts, method: methods.join('+') };
    }
    doc.getRoot().setDefaultScene(scene);
    const out = await new NodeIO().writeBinary(doc);
    fs.writeFileSync(o._[1], out);
    report.output = o._[1];
    report.outputBytes = out.byteLength;
    report.outputSha256 = sha256(out);
    console.log(JSON.stringify(report, null, 2));
  })();
}

main().catch(e => { console.error('model-lod: ' + (e && e.message ? e.message : e)); process.exit(1); });
