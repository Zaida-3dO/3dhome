#!/usr/bin/env node
// ---------------------------------------------------------------------------
// make-test-model.mjs - writes houses/demo/models/test-armchair.glb, the
// public demo and test file for the `model` furniture type.
//
//   node scripts/make-test-model.mjs [out.glb]
//
// No dependencies (node:zlib only), so the file can always be regenerated.
// The model is a blocky armchair made of boxes, authored here, and dedicated
// to the public domain (CC0 1.0) -- see houses/demo/models/README.md.
//
// It deliberately exercises every path model.js has:
//   - root node `full`: a vertex-coloured primitive (COLOR_0; the frame, arms
//     and legs) AND a textured primitive (a seat cushion with a 16 px
//     checker PNG) -- the palette-bucket path and the kept-texture path;
//   - root node `low`: fewer boxes, vertex-coloured only (detail 'low');
//   - a node transform (the whole chair sits under a translated parent), so
//     baking transforms is tested too.
// Front faces +z, y up, metres: about 0.80 W x 0.78 D x 0.82 H.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || path.join(root, 'houses/demo/models/test-armchair.glb');

// A box as 24 vertices (flat normals) / 12 triangles.
function box(x0, y0, z0, x1, y1, z1, rgb, uv) {
  const P = [], N = [], C = [], U = [], I = [];
  const faces = [
    [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
    [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]]
  ];
  faces.forEach(([n, q], f) => {
    const b = f * 4;
    q.forEach((p, k) => {
      P.push(...p); N.push(...n);
      if (rgb) C.push(...rgb);
      if (uv) U.push(k === 1 || k === 2 ? 1 : 0, k >= 2 ? 0 : 1);
    });
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { P, N, C, U, I };
}
function merge(parts) {
  const o = { P: [], N: [], C: [], U: [], I: [] };
  parts.forEach(p => {
    const base = o.P.length / 3;
    o.P.push(...p.P); o.N.push(...p.N); o.C.push(...p.C); o.U.push(...p.U);
    o.I.push(...p.I.map(i => i + base));
  });
  return o;
}
// Linear-space colours (glTF vertex colours are linear).
const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const rgb = hex => [0, 1, 2].map(i => lin(parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255));
const FRAME = rgb('#4b6a8c'), ARM = rgb('#5d7ea3'), LEG = rgb('#2b2b2b');

const W = 0.80, D = 0.78, H = 0.82, ARM_W = 0.14, SEAT = 0.42, BACK_D = 0.16;
const legs = [[-W / 2 + 0.03, 0.03], [W / 2 - 0.07, 0.03], [-W / 2 + 0.03, D - 0.07], [W / 2 - 0.07, D - 0.07]]
  .map(([x, z]) => box(x, 0, z, x + 0.04, 0.10, z + 0.04, LEG));
const fullFrame = merge([
  box(-W / 2 + ARM_W, 0.10, 0, W / 2 - ARM_W, SEAT - 0.08, D, FRAME),        // seat base
  box(-W / 2 + ARM_W, 0.10, 0, W / 2 - ARM_W, H, BACK_D, FRAME),              // back
  box(-W / 2, 0.10, 0, -W / 2 + ARM_W, 0.62, D, ARM),                         // left arm
  box(W / 2 - ARM_W, 0.10, 0, W / 2, 0.62, D, ARM),                           // right arm
  ...legs
]);
const cushion = box(-W / 2 + ARM_W + 0.01, SEAT - 0.08, BACK_D, W / 2 - ARM_W - 0.01, SEAT, D - 0.01, null, true);
const lowFrame = merge([
  box(-W / 2, 0, 0, W / 2, SEAT, D, FRAME),
  box(-W / 2 + ARM_W, SEAT, 0, W / 2 - ARM_W, H, BACK_D, FRAME)
]);

// A 16 x 16 two-tone checker PNG, written by hand (RGB, no filter).
function checkerPng() {
  const S = 16, rows = [];
  for (let y = 0; y < S; y++) {
    const row = [0];
    for (let x = 0; x < S; x++) {
      const on = ((x >> 2) + (y >> 2)) % 2 === 0;
      row.push(...(on ? [0xd9, 0xc7, 0x9e] : [0xb8, 0xa2, 0x76]));
    }
    rows.push(...row);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- GLB writer -------------------------------------------------------------
const bin = [];
let binLen = 0;
const bufferViews = [], accessors = [];
function addView(buf, target) {
  const pad = (4 - (binLen % 4)) % 4;
  if (pad) { bin.push(Buffer.alloc(pad)); binLen += pad; }
  bufferViews.push(Object.assign({ buffer: 0, byteOffset: binLen, byteLength: buf.length }, target ? { target } : {}));
  bin.push(buf); binLen += buf.length;
  return bufferViews.length - 1;
}
function addAccessor(arr, type, componentType, target, withBounds) {
  const typed = componentType === 5126 ? new Float32Array(arr) : new Uint16Array(arr);
  const view = addView(Buffer.from(typed.buffer), target);
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
  const acc = { bufferView: view, componentType, count: arr.length / n, type };
  if (withBounds) {
    acc.min = [0, 1, 2].map(k => Math.min(...arr.filter((_, i) => i % 3 === k)));
    acc.max = [0, 1, 2].map(k => Math.max(...arr.filter((_, i) => i % 3 === k)));
  }
  accessors.push(acc);
  return accessors.length - 1;
}
function primitive(m, material) {
  const attributes = {
    POSITION: addAccessor(m.P, 'VEC3', 5126, 34962, true),
    NORMAL: addAccessor(m.N, 'VEC3', 5126, 34962)
  };
  if (m.C.length) attributes.COLOR_0 = addAccessor(m.C, 'VEC3', 5126, 34962);
  if (m.U.length) attributes.TEXCOORD_0 = addAccessor(m.U, 'VEC2', 5126, 34962);
  return { attributes, indices: addAccessor(m.I, 'SCALAR', 5123, 34963), material };
}
const png = checkerPng();
const imageView = addView(png);
const json = {
  asset: { version: '2.0', generator: '3dhome scripts/make-test-model.mjs', copyright: 'CC0 1.0 (public domain dedication)' },
  scene: 0,
  scenes: [{ name: 'test-armchair', nodes: [0, 1] }],
  nodes: [
    { name: 'full', children: [2] },
    { name: 'low', mesh: 1 },
    // A translated child: bake-the-transform is exercised (and fitting
    // removes the offset again).
    { name: 'chair', mesh: 0, translation: [0.25, 0, -0.1] }
  ],
  materials: [
    { name: 'frame', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
    { name: 'cushion', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } }
  ],
  textures: [{ source: 0, sampler: 0 }],
  samplers: [{ magFilter: 9728, minFilter: 9728 }],
  images: [{ bufferView: imageView, mimeType: 'image/png' }],
  meshes: [
    { name: 'full', primitives: [primitive(fullFrame, 0), primitive(cushion, 1)] },
    { name: 'low', primitives: [primitive(lowFrame, 0)] }
  ],
  accessors, bufferViews,
  buffers: [{ byteLength: 0 }]
};
const binBuf = Buffer.concat(bin);
const binPadded = Buffer.concat([binBuf, Buffer.alloc((4 - (binBuf.length % 4)) % 4)]);
json.buffers[0].byteLength = binPadded.length;
let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPadded.length, 8);
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
const glb = Buffer.concat([header, ch(jsonBuf.length, 0x4e4f534a), jsonBuf, ch(binPadded.length, 0x004e4942), binPadded]);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, glb);
const tris = m => m.I.length / 3;
console.log('wrote ' + path.relative(root, out) + ': ' + glb.length + ' bytes; full ' +
  (tris(fullFrame) + tris(cushion)) + ' tris (' + tris(cushion) + ' textured), low ' + tris(lowFrame) + ' tris');
