#!/usr/bin/env node
/**
 * dev-server.mjs - a local static server for the 3dHome tree, with the
 * /diagnostics save endpoint behind the same origin (item 112ec00c).
 *
 * No dependencies, no install: `node scripts/dev-server.mjs`.
 *
 *   --port <n>        default 8792
 *   --root <dir>      the tree to serve (default: this repo)
 *   --save-dir <dir>  switch the save endpoint ON, writing runs here
 *                     (absent: OFF, exactly like the container's default)
 *   --host <addr>     default 127.0.0.1 (never listens on the LAN unless asked)
 *   --max-files <n>   storage cap in runs (default 500), as HOME3D_DIAGNOSTICS_MAX_FILES
 *   --max-bytes <n>   storage cap in bytes (default 100 MB), as HOME3D_DIAGNOSTICS_MAX_BYTES
 *
 * WHY IT EXISTS. The app's real server is nginx in a container, and the save
 * endpoint is an njs handler inside it. Docker is not available everywhere
 * this app is previewed, so this mirrors the container's contract for a
 * localhost preview:
 *
 *   - the SAME validation and naming code: it imports deploy/njs/diagnostics.js,
 *     the file nginx runs, and calls its check() and store();
 *   - the same bounds nginx adds around it: a 256 KB body cap answered 413
 *     before the body is read in full, and limit_req's leaky bucket (6/min,
 *     burst 3, nodelay) answered 429, and the total storage cap answered 507;
 *   - the same routes: /diagnostics serves diagnostics.html, /diagnostics/
 *     redirects to /diagnostics (query kept), POST /api/diagnostics saves or
 *     answers the off-state JSON 404;
 *   - config.js carries diagnosticsSave, as deploy/generate-config.sh writes it.
 *
 * What it does NOT mirror: nginx's cache headers (everything here is
 * no-store), gzip, CSP. It is a preview server, not a deployment target.
 * scripts/test-diagnostics-save.mjs tests the contract against it.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = (await import(pathToFileURL(path.join(REPO, 'deploy', 'njs', 'diagnostics.js')).href)).default;

export const RATE_PER_MIN = 6;
export const BURST = 3;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8'
};

/** nginx limit_req's leaky bucket, per key: excess = max(0, prev - rate*elapsed + 1), refused above burst. */
export function createLimiter(ratePerMin = RATE_PER_MIN, burst = BURST, now = () => Date.now()) {
  const nodes = new Map();
  return function allow(key) {
    const t = now();
    const n = nodes.get(key);
    if (!n) { nodes.set(key, { excess: 0, last: t }); return true; }
    const excess = Math.max(0, n.excess - (ratePerMin / 60000) * (t - n.last) + 1);
    if (excess > burst) return false;
    n.excess = excess; n.last = t;
    return true;
  };
}

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' }, extra || {}));
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json');

function configJs(root, saveOn) {
  const flag = '\n;(window.HOME3D_CONFIG = window.HOME3D_CONFIG || {}).diagnosticsSave = ' + (saveOn ? 'true' : 'false') + ';\n';
  const file = path.join(root, 'config.js');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8') + flag;
  let base = {};
  for (const name of ['config.json', 'config.example.json']) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) {
      try { base = JSON.parse(fs.readFileSync(p, 'utf8')); break; } catch (e) { /* fall through */ }
    }
  }
  delete base._comment; delete base._fields;
  base.source = 'dev-server';
  base.diagnosticsSave = !!saveOn;
  return '/* served by scripts/dev-server.mjs */\nwindow.HOME3D_CONFIG = ' + JSON.stringify(base, null, 2) + ';\n';
}

/**
 * Build the request handler. Exported so the contract test can run it on an
 * ephemeral port with its own save directory and clock.
 */
export function createHandler(opts) {
  const root = path.resolve(opts.root || REPO);
  const saveDir = opts.saveDir ? path.resolve(opts.saveDir) : null;
  const limiter = opts.limiter || createLimiter();
  // The storage cap, as HOME3D_DIAGNOSTICS_MAX_FILES / _MAX_BYTES set it in the
  // container (defaults 500 runs / 100 MB), enforced by the same store().
  const limits = { maxFiles: opts.maxFiles > 0 ? opts.maxFiles : contract.DEFAULT_MAX_FILES,
    maxBytes: opts.maxBytes > 0 ? opts.maxBytes : contract.DEFAULT_MAX_BYTES };

  function save(req, res) {
    if (!saveDir) {
      json(res, 404, { ok: false, error: 'saving diagnostic runs is not enabled on this server' });
      req.resume();
      return;
    }
    if (!limiter(req.socket.remoteAddress || 'local')) {
      send(res, 429, '429 Too Many Requests\n');
      req.resume();
      return;
    }
    const declared = parseInt(req.headers['content-length'], 10);
    if (Number.isFinite(declared) && declared > contract.MAX_BYTES) {
      send(res, 413, '413 Request Entity Too Large\n', 'text/plain', { Connection: 'close' });
      req.destroy();
      return;
    }
    const chunks = [];
    let bytes = 0, over = false;
    req.on('data', c => {
      if (over) return;
      bytes += c.length;
      if (bytes > contract.MAX_BYTES) { over = true; send(res, 413, '413 Request Entity Too Large\n', 'text/plain', { Connection: 'close' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const buf = Buffer.concat(chunks);
      const ok = contract.check(req.method, req.headers['content-type'], buf.toString('utf8'), buf.length, opts.now ? opts.now() : new Date());
      if (ok.status !== 201) { json(res, ok.status, { ok: false, error: ok.error }); return; }
      const r = contract.store(saveDir, ok, buf.length, limits);
      if (r.status !== 201) { json(res, r.status, { ok: false, error: r.error }); return; }
      json(res, 201, r.body);
    });
  }

  return function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { send(res, 400, 'bad request'); return; }
    const p = url.pathname;
    if (p === '/api/diagnostics') { save(req, res); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'method not allowed'); return; }
    if (p === '/diagnostics/') { send(res, 301, '', 'text/plain', { Location: '/diagnostics' + url.search }); return; }
    if (p === '/config.js') { send(res, 200, configJs(root, !!saveDir), 'text/javascript; charset=utf-8'); return; }
    if (p === '/healthz') { send(res, 200, 'ok\n'); return; }
    let rel;
    try { rel = decodeURIComponent(p); } catch (e) { send(res, 400, 'bad path'); return; }
    if (rel === '/diagnostics') rel = '/diagnostics.html';
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel.split('/').some(seg => seg.startsWith('.'))) { send(res, 404, 'not found'); return; }
    const file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) { send(res, 404, 'not found'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { send(res, 404, 'not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  };
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = parseInt(arg('port', '8792'), 10);
  const host = arg('host', '127.0.0.1');
  const root = arg('root', REPO);
  const saveDir = arg('save-dir', null);
  if (saveDir && !fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
  const maxFiles = parseInt(arg('max-files', '0'), 10);
  const maxBytes = parseInt(arg('max-bytes', '0'), 10);
  http.createServer(createHandler({ root, saveDir, maxFiles, maxBytes })).listen(port, host, () => {
    console.log('3dHome dev server on http://' + (host === '127.0.0.1' ? 'localhost' : host) + ':' + port + '/  (root ' + root + ')');
    console.log('  diagnostics: http://localhost:' + port + '/diagnostics');
    console.log('  save endpoint: ' + (saveDir ? 'ON -> ' + path.resolve(saveDir) : 'OFF (pass --save-dir <dir> to enable)'));
  });
}
