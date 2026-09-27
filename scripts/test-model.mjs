#!/usr/bin/env node
/**
 * The `model` furniture type (src/furniture/model.js) and the one contract
 * addition it needs (an optional async prepare() awaited by
 * loadFurnitureModules). No framework, no install:
 * `node scripts/test-model.mjs`.
 *
 * Runs the REAL vendored GLTFLoader (r160) against the REAL demo file
 * houses/demo/models/test-armchair.glb, fetched over a real local HTTP
 * server, so the fetch -> parse -> plain-data -> build -> merge chain is the
 * one the browser runs. The loader's bare `import 'three'` is resolved to the
 * vendored module by a module-resolve hook (the browser uses the importmap).
 *
 * WHAT THIS GUARDS
 *   1. The path guard: only profile-relative .glb paths resolve.
 *   2. One fetch per file, however many items use it; a failed file is ONE
 *      warning and a skip, and the rest of the furniture still builds.
 *   3. The envelope: the built bbox IS width x depth x height, back at z=0,
 *      bottom at y=0, x centred -- for stretch, contain and every yaw.
 *   4. detail 'low' uses the `low` node; the triangle cap refuses a file.
 *   5. Merging: vertex-coloured parts join the palette bucket (no extra
 *      draw); a textured part is ONE kept bucket shared by every instance.
 *   6. disposeFurniture frees the map; prepare() is awaited, never rejects.
 *   7. The loader stamps assetBase on compiled furniture.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = rel => pathToFileURL(path.join(root, rel)).href;
const threeUrl = url('vendor/three-r160/three.module.min.js');
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s, c, n) { if (s === "three") return { url: ' + JSON.stringify(threeUrl) +
  ', shortCircuit: true }; return n(s, c); }'));
// GLTFLoader reads self.URL and decodes images with createImageBitmap. Node
// has URL and Blob; a stand-in bitmap is enough (nothing is drawn).
globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 16, height: 16, close() {} });

const THREE = await import(threeUrl);
const M = await import(url('src/furniture/model.js'));
const F = await import(url('src/furniture.js'));
const { HouseLoader } = await import(url('src/house-loader.js'));

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail) : ''));
}
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
async function quietlyAsync(fn) {
  const warnings = [];
  const w = console.warn;
  console.warn = (...m) => warnings.push(m.map(String).join(' '));
  try { return { value: await fn(), warnings }; } finally { console.warn = w; }
}
function quietly(fn) {
  const warnings = [];
  const w = console.warn;
  console.warn = (...m) => warnings.push(m.map(String).join(' '));
  try { return { value: fn(), warnings }; } finally { console.warn = w; }
}

// ---- a local server for houses/demo, counting requests -----------------------
const hits = {};
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  hits[p] = (hits[p] || 0) + 1;
  const file = path.join(root, p);
  if (!file.startsWith(path.join(root, 'houses')) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
  res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port + '/';
// resolveModelUrl anchors on location.href, as in the page.
globalThis.location = { href: origin + 'index.html' };
const BASE = 'houses/demo/';
const SRC = 'models/test-armchair.glb';

try {
  // ---- 1. path guard -------------------------------------------------------
  {
    ['../x.glb', '/x.glb', 'http://evil/x.glb', 'https://evil/x.glb', 'data:x.glb', 'x.gltf', 'x.js',
      'a/../b.glb', 'a\\b.glb', '', null, 'C:/x.glb'].forEach(bad => {
      check('guard refuses ' + JSON.stringify(bad), !!M.resolveModelUrl(bad, BASE).error, M.resolveModelUrl(bad, BASE));
    });
    const ok = M.resolveModelUrl(SRC, BASE);
    check('guard accepts a profile-relative .glb', ok.url === origin + BASE + SRC, ok);
    check('guard accepts upper-case .GLB', !M.resolveModelUrl('a/B.GLB', BASE).error);
  }

  // ---- 2. prepare: one fetch per file, real GLTFLoader ------------------------
  const item = (id, params, extra) => Object.assign({ id, room: 'r', type: 'model', origin: 'centre', x: 100, y: 100,
    rotationDeg: 0, elevation: 0, fade: 'never', priority: 'normal', assetBase: BASE,
    params: Object.assign({ src: SRC, width: 80, depth: 78, height: 82 }, params) }, extra || {});
  M.clearModelCache();
  {
    const r = await quietlyAsync(() => M.prepare([item('a'), item('b'), item('c', { width: 40 })]));
    check('one fetch for three items using one file', hits['/' + BASE + SRC] === 1, hits);
    check('prepare of a good file warns nothing', r.warnings.length === 0, r.warnings);
  }

  // ---- 3/4. build: envelope, yaw, fit, detail, cap ------------------------------
  function bbox(group) {
    group.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(group);
  }
  function envelopeOk(name, params, detail) {
    const p = Object.assign({}, M.DEFAULTS, { src: SRC, width: 80, depth: 78, height: 82 }, params);
    const g = M.build(THREE, p, { detail: detail || 'full', assetBase: BASE });
    const b = bbox(g);
    const eps = 1e-4;
    if (p.fit === 'contain') {
      check(name + ': contain fits inside', b.max.x - b.min.x <= p.width / 100 + eps &&
        b.max.y - b.min.y <= p.height / 100 + eps && b.max.z - b.min.z <= p.depth / 100 + eps, b);
      const s = [(b.max.x - b.min.x) / (p.width / 100), (b.max.y - b.min.y) / (p.height / 100), (b.max.z - b.min.z) / (p.depth / 100)];
      check(name + ': contain touches one dimension', Math.max(...s) > 1 - 1e-3, s);
    } else {
      check(name + ': width', near(b.max.x - b.min.x, p.width / 100), b.max.x - b.min.x);
      check(name + ': height', near(b.max.y - b.min.y, p.height / 100), b.max.y - b.min.y);
      check(name + ': depth', near(b.max.z - b.min.z, p.depth / 100), b.max.z - b.min.z);
    }
    check(name + ': back at z = 0', near(b.min.z, 0), b.min.z);
    check(name + ': bottom at y = 0', near(b.min.y, 0), b.min.y);
    check(name + ': x centred', near(b.min.x + b.max.x, 0), [b.min.x, b.max.x]);
    return g;
  }
  [0, 90, 180, 270, 33].forEach(yaw => envelopeOk('stretch yaw ' + yaw, { yaw }));
  {
    // A 200-wide envelope for an ~80-wide chair: contain must NOT stretch it
    // (stretch would also "fit inside" by being exactly the envelope).
    const b = bbox(envelopeOk('contain', { fit: 'contain', width: 200 }));
    const s = bbox(envelopeOk('stretch at 200', { width: 200 }));
    check('contain keeps the proportions (not stretched to 200)', b.max.x - b.min.x < 1.5, b.max.x - b.min.x);
    check('contain: height is the binding dimension here', near(b.max.y - b.min.y, 0.82), b.max.y - b.min.y);
    check('stretch at 200 is 200 wide', near(s.max.x - s.min.x, 2), s.max.x - s.min.x);
  }
  envelopeOk('low detail', {}, 'low');
  {
    // The chair's back is authored at -z. At yaw 0 the tall part (the back)
    // must be at the BACK of the envelope (small z); at yaw 180 at the front.
    const topZ = yaw => {
      const g = M.build(THREE, Object.assign({}, M.DEFAULTS, { src: SRC, width: 80, depth: 78, height: 82, yaw }), { assetBase: BASE });
      g.updateMatrixWorld(true);
      let z = 0, n = 0;
      const v = new THREE.Vector3();
      g.traverse(o => {
        if (!o.isMesh) return;
        const a = o.geometry.attributes.position;
        for (let i = 0; i < a.count; i++) {
          v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld);
          if (v.y > 0.7) { z += v.z; n++; }
        }
      });
      return z / n;
    };
    check('yaw 0 keeps the back at the back', topZ(0) < 0.2, topZ(0));
    check('yaw 180 turns the back to the front', topZ(180) > 0.58, topZ(180));
  }
  {
    const tris = (g) => { let t = 0; g.traverse(o => { if (o.isMesh) t += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return t; };
    const p = Object.assign({}, M.DEFAULTS, { src: SRC });
    check('full detail = the full node (108 tris)', tris(M.build(THREE, p, { detail: 'full', assetBase: BASE })) === 108);
    check('low detail = the `low` node (24 tris)', tris(M.build(THREE, p, { detail: 'low', assetBase: BASE })) === 24);
    let err = null;
    try { M.build(THREE, Object.assign({}, p, { maxTriangles: 100 }), { assetBase: BASE }); } catch (e) { err = e.message; }
    check('maxTriangles refuses a heavier file', !!err && /over maxTriangles 100/.test(err), err);
    err = null;
    try { M.build(THREE, Object.assign({}, p, { maxTriangles: 100 }), { detail: 'low', assetBase: BASE }); } catch (e) { err = e.message; }
    check('...but not its low node', err === null, err);
  }
  {
    // Materials: palette finishes, vertex colours on, the cushion textured + kept.
    const g = M.build(THREE, Object.assign({}, M.DEFAULTS, { src: SRC, finish: 'gloss' }), { assetBase: BASE });
    const mats = [];
    g.traverse(o => { if (o.isMesh) mats.push(o.material); });
    check('two primitives in the full node', mats.length === 2, mats.length);
    check('every material carries the palette finish', mats.every(m => m.userData.finish === 'gloss'));
    const vc = mats.filter(m => m.vertexColors), tx = mats.filter(m => m.map);
    check('one vertex-coloured material', vc.length === 1 && !vc[0].map && !vc[0].userData.keep);
    check('one textured material, kept', tx.length === 1 && tx[0].userData.keep === true && tx[0].map.flipY === false);
    const g2 = M.build(THREE, Object.assign({}, M.DEFAULTS, { src: SRC }), { assetBase: BASE });
    let map2 = null;
    g2.traverse(o => { if (o.isMesh && o.material.map) map2 = o.material.map; });
    check('the texture is shared across builds', map2 === tx[0].map);
  }

  // ---- 2 (cont.). failures: one warning, a skip, the rest builds ----------------
  {
    M.clearModelCache();
    const items = [
      item('good1'), item('good2', { width: 50 }),
      item('missing', { src: 'models/nope.glb' }),
      item('bad-path', { src: '../escape.glb' }),
      Object.assign(item('boxy'), { type: 'box', params: { width: 40, depth: 40, height: 40 } })
    ];
    const r = await quietlyAsync(async () => {
      const builders = await F.loadFurnitureModules(items);
      return F.buildFurnitureSync(THREE, items, builders, { tx: x => x / 100, tz: y => y / 100, quality: { tier: 'ultra' } });
    });
    const res = r.value;
    check('good items and the box built', !!res.byId.good1 && !!res.byId.good2 && !!res.byId.boxy, Object.keys(res.byId));
    check('missing and bad-path skipped', !res.byId.missing && !res.byId['bad-path'] && res.stats.skipped === 2, res.stats);
    const missingWarn = r.warnings.filter(w => w.includes('"missing"'));
    check('a missing file is exactly one warning', missingWarn.length === 1 && /HTTP 404/.test(missingWarn[0]), r.warnings);
    const pathWarn = r.warnings.filter(w => w.includes('"bad-path"'));
    check('a refused path is exactly one warning', pathWarn.length === 1 && /profile-relative/.test(pathWarn[0]), r.warnings);
    // 5. Buckets: two chairs + a box = ONE palette bucket + ONE kept (cushion) bucket.
    const cls = res.beauty.map(m => m.userData.cls).sort();
    check('two instances + a box: one palette bucket and one kept bucket', JSON.stringify(cls) === '["kept","opaque"]', cls);
    const kept = res.beauty.find(m => m.userData.cls === 'kept');
    check('the kept bucket holds both cushions', kept && kept.userData.parts === 2, kept && kept.userData);
    check('the kept bucket keeps its uv', kept && !!kept.geometry.attributes.uv);
    const pal = res.beauty.find(m => m.userData.cls === 'opaque');
    // Vertex colours survive the merge: the frame's blue is in the bucket.
    let blue = false;
    const c = pal.geometry.attributes.color;
    for (let i = 0; i < c.count && !blue; i++) if (c.getZ(i) > c.getX(i) * 1.5 && c.getZ(i) > 0.1) blue = true;
    check('the frame vertex colours reach the palette bucket', blue);
    // 6. dispose frees the map.
    let disposed = 0;
    kept.material.map.addEventListener('dispose', () => disposed++);
    F.disposeFurniture(res);
    check('disposeFurniture disposes the model texture', disposed === 1, disposed);
  }

  // ---- 5 (cont.). a vertex-colour-only model adds NO beauty draw ----------------
  {
    M.clearModelCache();
    const loadGltf = async () => {
      const scene = new THREE.Group();
      const g = new THREE.BoxGeometry(1, 1, 1);
      const cols = new Float32Array(g.attributes.position.count * 3).fill(0.5);
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true })));
      return { scene };
    };
    const items = [item('vc', { src: 'models/vc.glb' }), Object.assign(item('boxy'), { type: 'box', params: {} })];
    const res = (await quietlyAsync(async () => {
      const builders = await F.loadFurnitureModules(items, { prepareCtx: { loadGltf } });
      return F.buildFurnitureSync(THREE, items, builders, { tx: x => x / 100, tz: y => y / 100, quality: { tier: 'ultra' } });
    })).value;
    check('a vertex-coloured model shares the box palette bucket (1 beauty draw)', res.beauty.length === 1 && !!res.byId.vc,
      res.beauty.map(m => m.userData.bucket));
  }

  // ---- slow file: the per-file timeout ------------------------------------------
  {
    M.clearModelCache();
    const never = () => new Promise(() => {});
    await M.prepare([item('slow', { src: 'models/slow.glb' })], { loadGltf: never, timeoutMs: 20 });
    let err = null;
    try { M.build(THREE, Object.assign({}, M.DEFAULTS, { src: 'models/slow.glb' }), { assetBase: BASE }); } catch (e) { err = e.message; }
    check('a file that never arrives times out and fails its item', !!err && /longer than 20 ms/.test(err), err);
  }

  // ---- 6. loadFurnitureModules awaits prepare(), never rejects -------------------
  {
    const registry = { a: { path: 'a.js', key: null, spec: null }, b: { path: 'b.js', key: null, spec: null }, c: { path: 'c.js', key: null, spec: null } };
    let prepared = null;
    const mods = {
      a: { TYPE: 'a', DEFAULTS: { width: 1, depth: 1, height: 1 }, build: () => new THREE.Group(),
        prepare: async its => { await new Promise(r => setTimeout(r, 5)); prepared = its.map(i => i.id); } },
      b: { TYPE: 'b', DEFAULTS: { width: 1, depth: 1, height: 1 }, build: () => new THREE.Group(),
        prepare: async () => { throw new Error('boom'); } },
      c: { TYPE: 'c', DEFAULTS: { width: 1, depth: 1, height: 1 }, build: () => new THREE.Group() }
    };
    const importer = u => Promise.resolve(mods[u.match(/\/(\w)\.js/)[1]]);
    const items = [{ id: 'x', type: 'a' }, { id: 'y', type: 'b' }, { id: 'z', type: 'a' }, { id: 'w', type: 'c' }];
    const r = await quietlyAsync(() => F.loadFurnitureModules(items, { registry, importer, baseUrl: 'http://h/src/furniture/' }));
    check('prepare() was awaited with only its own items', JSON.stringify(prepared) === '["x","z"]', prepared);
    check('a rejecting prepare() does not reject the load', r.value instanceof Map && r.value.size === 3, r.value);
    check('...and says so once', r.warnings.filter(w => /"b": prepare\(\) failed: boom/.test(w)).length === 1, r.warnings);
    check('a builder without prepare() has none', !('prepare' in r.value.get('c')));
    const hang = { d: { path: 'd.js', key: null, spec: null } };
    mods.d = { TYPE: 'd', DEFAULTS: { width: 1, depth: 1, height: 1 }, build: () => new THREE.Group(), prepare: () => new Promise(() => {}) };
    const r2 = await quietlyAsync(() => F.loadFurnitureModules([{ id: 'q', type: 'd' }],
      { registry: hang, importer, baseUrl: 'http://h/src/furniture/', prepareTimeoutMs: 20 }));
    check('a hanging prepare() times out', r2.value.size === 1 && r2.warnings.some(w => /longer than 20 ms/.test(w)), r2.warnings);
  }

  // ---- 7. the loader stamps assetBase -------------------------------------------
  {
    const demo = JSON.parse(fs.readFileSync(path.join(root, 'houses/demo/geometry.json'), 'utf8'));
    const h = quietly(() => HouseLoader.compile(demo, 'houses/demo')).value;
    const arm = h.furniture.find(f => f.type === 'model');
    check('the demo house places a model item', !!arm);
    check('compiled furniture carries assetBase = the profile dir', arm && arm.assetBase === 'houses/demo/', arm && arm.assetBase);
  }

  // The committed demo file is exactly what the generator writes.
  {
    const tmp = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'model-')), 't.glb');
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [path.join(root, 'scripts/make-test-model.mjs'), tmp]);
    check('houses/demo/models/test-armchair.glb matches scripts/make-test-model.mjs',
      Buffer.compare(fs.readFileSync(tmp), fs.readFileSync(path.join(root, BASE, SRC))) === 0);
  }
} finally {
  server.close();
}

console.log((failures ? 'FAILED' : 'ok') + ' -- ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
