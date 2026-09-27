/**
 * model.js - a piece of furniture drawn from a glTF binary (.glb) file that
 * lives in the HOUSE PROFILE, not in this repo.
 *
 * Every other type is a builder that makes its geometry from numbers. This
 * one loads it: a house can place a real product model (a decimated vendor
 * model, a scan) that it is not allowed to redistribute, while the engine
 * stays generic and public. See docs/house-profile.md, "Furniture: model".
 *
 * THE CONTRACT, AND THE ONE ADDITION TO IT
 *
 *   build() is SYNCHRONOUS -- it runs inside the time-sliced build
 *   (furniture.js), which cannot wait for the network. So this module also
 *   exports prepare(items, ctx): furniture.js awaits it while the builders
 *   load, in parallel with the scene's precompile and before the first build
 *   slice. prepare() fetches and parses each distinct file ONCE into a
 *   module-level cache of plain typed arrays; build() reads that cache.
 *
 *   A file that is missing, refused by the path guard, unparseable, too slow
 *   or over the triangle cap is remembered as an error; build() then throws
 *   it, and furniture.js logs one line and skips just that item.
 *
 * THE ENVELOPE. params.width/depth/height (cm) are the item's footprint and
 * height, exactly as for a built type. The model is fitted into them:
 * rotated by `yaw` (degrees, anticlockwise seen from above -- use it when
 * the file's front is not glTF's +z), then translated so x is centred, the
 * bottom is at y = 0 and the BACK at z = 0 (the builder frame), and scaled:
 *   fit 'stretch'  each axis scaled to its own dimension (Sweet Home 3D's
 *                  behaviour when a model is resized), so the bbox IS the
 *                  envelope;
 *   fit 'contain'  one uniform scale, the largest that fits; x-centred,
 *                  bottom and back still at 0.
 *
 * MATERIALS. The file's own materials are NOT used. Every primitive draws
 * with a palette material from finishes.js (params.finish), so the renderer
 * can merge it:
 *   - a primitive with vertex colours (COLOR_0) -> vertexColors on a palette
 *     material: it joins the house's merged palette bucket. 0 extra draws,
 *     0 extra programs. This is the path a decimated model should take
 *     (scripts/model-lod bakes textures into vertex colours);
 *   - a primitive with a base-colour texture -> the palette material plus
 *     that map, tagged keep: one extra draw per distinct texture (shared by
 *     every item using the file);
 *   - otherwise the file's base colour (or params.color, which overrides
 *     every primitive's colour and tints vertex colours).
 *
 * LEVELS OF DETAIL. A root node named `low` is used for detail 'low'; every
 * other root node is the full model. A file with no `low` node serves both.
 *
 * Pure ESM with THREE injected. GLTFLoader (vendored, r160) is imported
 * lazily and only here, and only when a house actually uses `model`.
 */
import { makeFinish } from './finishes.js';

export const TYPE = 'model';

export const DEFAULTS = Object.freeze({
  src: null,          // profile-relative path to a .glb, e.g. "assets/models/chair/lod.glb"
  width: 60,          // cm
  depth: 60,          // cm
  height: 60,         // cm
  fit: 'stretch',     // 'stretch' | 'contain'
  yaw: 0,             // degrees, anticlockwise from above, applied before fitting
  finish: 'matte',
  color: null,        // '#rrggbb' to override the file's colours
  maxTriangles: 5000  // refuse a file heavier than this (per LOD)
});

/**
 * Same shape as the loader's texture/overlay guards: profile-relative, no
 * leading slash, no '..', no scheme, no backslash -- and .glb only (a .gltf
 * names further files, which would each need guarding). Also rejects a
 * percent-encoded '%2e' (case-insensitive): the WHATWG URL parser decodes
 * '%2e%2e' to '..' before collapsing dot-segments, so a literal-only '..'
 * check is not enough on its own -- see the containment check below for the
 * second, independent layer.
 */
export const MODEL_PATH_RE = /^(?![/])(?!.*\.\.)(?!.*%2e)(?![a-z][a-z0-9+.-]*:)[^\\]+\.glb$/i;

/** How long prepare() waits for one file before giving up on it (ms). */
export const LOAD_TIMEOUT_MS = 10000;

const cache = new Map();   // absolute url -> { promise, asset, error }

/** Forget every loaded file (tests). */
export function clearModelCache() { cache.clear(); }

/**
 * The absolute URL for `src` under `assetBase`, or an error string.
 * @returns {{url?: string, error?: string}}
 */
export function resolveModelUrl(src, assetBase) {
  if (typeof src !== 'string' || src === '') return { error: 'has no params.src' };
  if (!MODEL_PATH_RE.test(src)) {
    return { error: 'params.src "' + src + '" is not a profile-relative .glb path' };
  }
  // assetBase is the profile directory as the loader fetched it (e.g.
  // "houses/demo/", relative to the page), so the file is base + src,
  // resolved against the page.
  const base = typeof assetBase === 'string' ? assetBase : '';
  const anchor = typeof location !== 'undefined' && location.href ? location.href : 'http://localhost/';
  let url;
  try {
    url = new URL(base + src, anchor).href;
  } catch (e) {
    return { url: base + src };
  }
  // Second, independent layer: even with the %2e literal rejected above,
  // require the resolved URL to still sit inside assetBase. Belt-and-braces
  // against any other percent-encoding or normalisation quirk the regex
  // does not anticipate -- containment is checked on the RESOLVED url, which
  // is the thing that is actually fetched.
  try {
    // './' against the resolved base drops any query, hash and last path
    // segment: with an empty assetBase the base is the page's DIRECTORY
    // (e.g. /app/ for /app/index.html?house=x), not the page URL itself --
    // otherwise nothing could ever start with it.
    const baseHref = new URL('./', new URL(base, anchor)).href;
    if (!url.startsWith(baseHref)) {
      return { error: 'params.src "' + src + '" resolves outside the profile directory' };
    }
  } catch (e) {
    // base itself failed to parse -- fall through and let the caller's fetch
    // fail naturally rather than mask it as a different kind of error.
  }
  return { url };
}

/**
 * Turn a parsed glTF (GLTFLoader's result) into plain data, so the cache is
 * independent of the THREE instance that parsed it (the live page and the
 * spec pages inject different ones). Every node transform is baked in.
 *
 * @returns {{full: Array<Prim>, low: ?Array<Prim>}}
 *   Prim = { position: Float32Array, normal: ?Float32Array, uv: ?Float32Array,
 *            color: ?Float32Array (linear rgb), index: ?Uint32Array,
 *            baseColor: [r,g,b] (linear), image: ?Object, triangles }
 */
export function gltfToAsset(gltf) {
  const scene = gltf && (gltf.scene || (gltf.scenes && gltf.scenes[0]));
  if (!scene) throw new Error('the file has no scene');
  scene.updateMatrixWorld(true);
  const full = [], low = [];
  let hasLow = false;
  // A GLB's root nodes are the scene's children; a file whose only root is
  // a wrapper is still honoured, because `low` is looked up among ancestors.
  scene.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    let isLow = false;
    for (let n = obj; n && n !== scene; n = n.parent) {
      if (n.name === 'low') { isLow = true; break; }
    }
    if (isLow) hasLow = true;
    const g = obj.geometry;
    const pos = g.attributes.position;
    if (!pos) return;
    const m = obj.matrixWorld.elements;
    const count = pos.count;
    const position = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      position[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      position[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      position[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    let normal = null;
    const nor = g.attributes.normal;
    if (nor) {
      // Inverse-transpose of the upper 3x3.
      const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], gg = m[2], h = m[6], k = m[10];
      const A = e * k - f * h, B = -(d * k - f * gg), C = d * h - e * gg;
      const det = a * A + b * B + c * C || 1;
      const inv = [A, -(b * k - c * h), b * f - c * e, B, a * k - c * gg, -(a * f - c * d), C, -(a * h - b * gg), a * e - b * d]
        .map(v => v / det);
      normal = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const x = nor.getX(i), y = nor.getY(i), z = nor.getZ(i);
        const nx = inv[0] * x + inv[3] * y + inv[6] * z;
        const ny = inv[1] * x + inv[4] * y + inv[7] * z;
        const nz = inv[2] * x + inv[5] * y + inv[8] * z;
        const l = Math.hypot(nx, ny, nz) || 1;
        normal[i * 3] = nx / l; normal[i * 3 + 1] = ny / l; normal[i * 3 + 2] = nz / l;
      }
    }
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const map = mat && mat.map && mat.map.image ? mat.map : null;
    let uv = null;
    if (map && g.attributes.uv) {
      const u = g.attributes.uv;
      uv = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) { uv[i * 2] = u.getX(i); uv[i * 2 + 1] = u.getY(i); }
    }
    let color = null;
    const col = g.attributes.color;
    if (col && mat && mat.vertexColors) {
      color = new Float32Array(count * 3);
      // getX() de-normalises a normalised (byte/short) attribute.
      for (let i = 0; i < count; i++) { color[i * 3] = col.getX(i); color[i * 3 + 1] = col.getY(i); color[i * 3 + 2] = col.getZ(i); }
    }
    const index = g.index ? Uint32Array.from(g.index.array) : null;
    const triangles = (index ? index.length : count) / 3;
    const prim = {
      position, normal, uv, color, index, triangles,
      baseColor: mat && mat.color ? [mat.color.r, mat.color.g, mat.color.b] : [0.8, 0.8, 0.8],
      image: map ? map.image : null
    };
    (isLow ? low : full).push(prim);
  });
  if (!full.length) throw new Error('the file has no full-detail mesh');
  return { full, low: hasLow ? low : null };
}

/**
 * A .glb is allowed because it is meant to be self-contained -- unlike a
 * .gltf, which routinely names sibling files. But the GLB *container* can
 * still carry buffers[].uri / images[].uri pointing OUTSIDE the file (a
 * relative path resolved against the profile directory, or an absolute
 * https:// URL); GLTFLoader will happily fetch either. That would silently
 * reopen exactly the "a file names further files" hole the .glb-only rule
 * exists to close. So this reads the GLB's JSON chunks by hand and refuses
 * any external (non-`data:`) uri BEFORE handing the bytes to GLTFLoader.
 *
 * GLB layout (see the Binary glTF spec): a 12-byte header (magic uint32,
 * version uint32, total length uint32), then one or more chunks, each an
 * 8-byte header (chunkLength uint32, chunkType uint32) followed by that many
 * bytes. A JSON chunk's type is the ASCII bytes "JSON" read little-endian
 * (0x4e4f534a).
 *
 * FAIL CLOSED. Every shape this cannot fully vouch for is refused, not
 * passed on to GLTFLoader, because GLTFLoader accepts more than the spec:
 *   - bytes whose magic is not "glTF" -- GLTFLoader.parse then falls back
 *     to JSON.parse of the whole buffer, i.e. a renamed .gltf;
 *   - a version other than 2, or a declared length past the end of the file;
 *   - a chunk that overruns the declared length, or a trailing partial
 *     chunk header;
 *   - no JSON chunk, or one that is not a JSON object.
 * And EVERY chunk is walked (the same bound GLTFLoader walks: the declared
 * length), and every JSON chunk is checked -- GLTFLoader uses the LAST JSON
 * chunk it meets, wherever it sits, so checking only the first one (or only
 * the chunk at offset 12) would let a benign decoy through.
 *
 * @returns {?string} a human-readable reason to refuse the file, or null
 */
function findExternalGlbUri(buf) {
  const bad = why => 'is not a well-formed binary glTF (' + why + ') -- refused';
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 12) return bad('shorter than a GLB header');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) return bad('no "glTF" magic');
  if (dv.getUint32(4, true) !== 2) return bad('version ' + dv.getUint32(4, true) + ', not 2');
  const total = dv.getUint32(8, true);
  if (total < 12 || total > buf.byteLength) return bad('declared length ' + total + ' but the file has ' + buf.byteLength + ' bytes');
  // Inline only if GLTFLoader itself would treat it as inline: its own test
  // is /^data:.*,.*$/i (`.` does not match a newline), and anything else --
  // `data:/../x.bin`, `data:x<newline>,...` -- it resolves against the file's own
  // directory and FETCHES. A uri present but not a string is refused too.
  const isExternal = uri => uri !== undefined && !(typeof uri === 'string' && /^data:.*,.*$/i.test(uri));
  const decoder = new TextDecoder('utf-8');
  let jsonChunks = 0;
  for (let at = 12; at < total;) {
    if (at + 8 > total) return bad('truncated chunk header');
    const chunkLength = dv.getUint32(at, true);
    const chunkType = dv.getUint32(at + 4, true);
    const start = at + 8;
    if (start + chunkLength > total) return bad('a chunk runs past the end of the file');
    if (chunkType === 0x4e4f534a) {
      jsonChunks++;
      let json;
      try {
        json = JSON.parse(decoder.decode(new Uint8Array(buf, start, chunkLength)));
      } catch (e) {
        return bad('unparseable JSON chunk');
      }
      if (!json || typeof json !== 'object' || Array.isArray(json)) return bad('JSON chunk is not an object');
      for (const kind of ['buffers', 'images']) {
        // Every value, not only an array's: GLTFLoader indexes json[kind][i],
        // which reads a plain object {"0": {...}} just as well (code review r3).
        const arr = json[kind] && typeof json[kind] === 'object' ? Object.values(json[kind]) : [];
        for (const entry of arr) {
          if (entry && isExternal(entry.uri)) {
            return kind + '[].uri "' + entry.uri + '" is external -- a .glb must be self-contained (data: URIs only)';
          }
        }
      }
    }
    at = start + chunkLength;
  }
  if (!jsonChunks) return bad('no JSON chunk');
  return null;
}

/** The default loader: fetch + the vendored GLTFLoader. Resolves to a parsed glTF. */
async function defaultLoadGltf(url) {
  const mod = await import('../../vendor/three-r160/addons/loaders/GLTFLoader.js');
  const res = await fetch(url);
  if (!res.ok) throw new Error('could not be loaded (HTTP ' + res.status + ')');
  const buf = await res.arrayBuffer();
  const refusal = findExternalGlbUri(buf);
  if (refusal) throw new Error(refusal);
  const loader = new mod.GLTFLoader();
  const dir = url.slice(0, url.lastIndexOf('/') + 1);
  return new Promise((resolve, reject) => loader.parse(buf, dir, resolve,
    e => reject(new Error('could not be parsed (' + (e && e.message ? e.message : e) + ')'))));
}

function withTimeout(p, ms, what) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(what + ' took longer than ' + ms + ' ms')), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/**
 * Load every distinct file these items name, once. Never rejects: a failure
 * is stored against the file and surfaces when an item using it is built.
 *
 * @param {Array<Object>} items   compiled furniture items of type 'model'
 * @param {{loadGltf?: function(string): Promise<Object>, timeoutMs?: number}} [ctx]
 */
export async function prepare(items, ctx) {
  const o = ctx || {};
  const load = o.loadGltf || defaultLoadGltf;
  const timeout = o.timeoutMs != null ? o.timeoutMs : LOAD_TIMEOUT_MS;
  const jobs = [];
  (items || []).forEach(item => {
    const params = (item && item.params) || {};
    const r = resolveModelUrl(params.src, item && item.assetBase);
    if (!r.url || cache.has(r.url)) return;
    const entry = { promise: null, asset: null, error: null };
    entry.promise = withTimeout(Promise.resolve().then(() => load(r.url)), timeout, params.src)
      .then(gltf => { entry.asset = gltfToAsset(gltf); })
      .catch(e => { entry.error = String(e && e.message ? e.message : e); });
    cache.set(r.url, entry);
    jobs.push(entry.promise);
  });
  await Promise.all(jobs);
}

// One THREE.Texture per (THREE instance, image), so every item using a file
// shares one texture -- and therefore one kept bucket (its uuid is in the key).
const textures = new WeakMap();
function textureFor(THREE, image) {
  let m = textures.get(THREE);
  if (!m) { m = new WeakMap(); textures.set(THREE, m); }
  let t = m.get(image);
  if (!t) {
    t = new THREE.Texture(image);
    t.flipY = false;                                  // glTF's convention
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    m.set(image, t);
  }
  return t;
}

function hexFromLinear(THREE, rgb) {
  return new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2]).getHex();
}

/**
 * Build the item. Throws when its file failed to load (the caller skips it).
 * @param {Object} THREE
 * @param {Object} params   DEFAULTS + the item's params
 * @param {{detail?: 'full'|'low', assetBase?: string}} [opts]
 */
export function build(THREE, params, opts) {
  const p = Object.assign({}, DEFAULTS, params);
  const o = opts || {};
  const r = resolveModelUrl(p.src, o.assetBase);
  if (r.error) throw new Error(r.error);
  const entry = cache.get(r.url);
  if (!entry) throw new Error(p.src + ' was not prepared (no prepare() call named it)');
  if (entry.error) throw new Error(p.src + ' ' + entry.error);
  if (!entry.asset) throw new Error(p.src + ' is still loading');

  const low = o.detail === 'low';
  const prims = low && entry.asset.low ? entry.asset.low : entry.asset.full;
  const tris = prims.reduce((s, q) => s + q.triangles, 0);
  if (tris > p.maxTriangles) {
    throw new Error(p.src + ' has ' + tris + ' triangles at ' + (low && entry.asset.low ? 'low' : 'full') +
      ' detail, over maxTriangles ' + p.maxTriangles + ' -- decimate it (scripts/model-lod)');
  }

  // Bounds after yaw, straight from the plain arrays.
  const yaw = (typeof p.yaw === 'number' ? p.yaw : 0) * Math.PI / 180;
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  prims.forEach(q => {
    const a = q.position;
    for (let i = 0; i < a.length; i += 3) {
      // three's rotation.y: x' = x cos + z sin, z' = -x sin + z cos
      const x = a[i] * cs + a[i + 2] * sn, y = a[i + 1], z = -a[i] * sn + a[i + 2] * cs;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
  });
  const W = p.width * 0.01, H = p.height * 0.01, D = p.depth * 0.01;
  const bx = x1 - x0 || 1, by = y1 - y0 || 1, bz = z1 - z0 || 1;
  let sx = W / bx, sy = H / by, sz = D / bz;
  if (p.fit === 'contain') { const s = Math.min(sx, sy, sz); sx = sy = sz = s; }

  const root = new THREE.Group();
  root.name = 'model';
  const fitted = new THREE.Group();   // T * S, applied to the yawed model
  fitted.scale.set(sx, sy, sz);
  fitted.position.set(-(x0 + x1) / 2 * sx, -y0 * sy, -z0 * sz);
  const yawed = new THREE.Group();
  yawed.rotation.y = yaw;
  fitted.add(yawed);
  root.add(fitted);

  const override = typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color) ? p.color : null;
  prims.forEach(q => {
    const g = new THREE.BufferGeometry();
    // The cached arrays are SHARED, never copied: flattenGroup (merge.js)
    // clones before it transforms, and nothing here writes to them.
    g.setAttribute('position', new THREE.BufferAttribute(q.position, 3));
    if (q.normal) g.setAttribute('normal', new THREE.BufferAttribute(q.normal, 3));
    if (q.index) g.setIndex(new THREE.BufferAttribute(q.index, 1));
    let mat;
    if (q.color) {
      g.setAttribute('color', new THREE.BufferAttribute(q.color, 3));
      mat = makeFinish(THREE, p.finish, override || 0xffffff);
      mat.vertexColors = true;
    } else if (q.image && q.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(q.uv, 2));
      mat = makeFinish(THREE, p.finish, override || hexFromLinear(THREE, q.baseColor));
      mat.map = textureFor(THREE, q.image);
      mat.userData.keep = true;
    } else {
      mat = makeFinish(THREE, p.finish, override || hexFromLinear(THREE, q.baseColor));
    }
    if (!q.normal) g.computeVertexNormals();
    yawed.add(new THREE.Mesh(g, mat));
  });
  return root;
}
