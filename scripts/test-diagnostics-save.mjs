#!/usr/bin/env node
/**
 * The "Save diagnostic run" endpoint's contract (item 112ec00c).
 * No framework, no install: `node scripts/test-diagnostics-save.mjs`.
 *
 * THREE LAYERS, because the real endpoint is njs inside nginx in a container
 * and this machine may have no Docker:
 *
 *   A. The contract over HTTP, against scripts/dev-server.mjs -- which runs the
 *      SAME validation/naming file nginx does (deploy/njs/diagnostics.js):
 *      off-state 404, 201 with a server-made name, 405/415/400/422/413/429,
 *      the exact-size boundary, filename sanitising (no path escapes the
 *      directory), never-overwrite on a name clash, write-only (no read-back,
 *      no listing), and the /diagnostics routes.
 *   B. The nginx side, statically: the include and the rate-limit zone are
 *      wired, the body cap in the conf equals the contract's, the njs module
 *      is imported and called, the Dockerfile installs every piece, and the
 *      njs file uses nothing Node-only.
 *   C. deploy/entrypoint.sh, run for real in a sandbox (every path it touches
 *      is overridable): OFF by default, ON only for a safe existing absolute
 *      directory, load_module added exactly once, and config.js's
 *      diagnosticsSave flag moving with it.
 *
 * NOT covered, and cannot be here: nginx actually loading njs and running the
 * handler. That runs in CI's docker-dry-run job (see .github/workflows/ci.yml).
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const DS = await imp('scripts/dev-server.mjs');
const C = (await imp('deploy/njs/diagnostics.js')).default;

let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; return; }
  failures++;
  console.error('FAIL ' + name + (detail !== undefined ? ' -- ' + JSON.stringify(detail).slice(0, 400) : ''));
}

function listen(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
function req(srv, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method, headers: headers || {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', e => (e.code === 'ECONNRESET' || e.code === 'EPIPE') ? resolve({ status: 'reset' }) : reject(e));
    if (body != null) r.write(body);
    r.end();
  });
}
const JSONH = { 'Content-Type': 'application/json' };
const doc = (extra) => JSON.stringify(Object.assign({ schema: 'home3d-diagnostics', schemaVersion: 1, summary: ['x'],
  app: { version: '0.50.0' }, save: { deviceId: '11111111-2222-4333-8444-555555555555', appVersion: '0.50.0' } }, extra || {}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'home3d-diag-save-'));
try {
  // ---- A. over HTTP -----------------------------------------------------------------
  const off = await listen(DS.createHandler({ root }));
  let r = await req(off, 'POST', '/api/diagnostics', doc(), JSONH);
  check('off: POST answers a JSON 404', r.status === 404 && r.json && r.json.ok === false && /not enabled/.test(r.json.error), r);
  r = await req(off, 'GET', '/config.js');
  check('off: config.js says diagnosticsSave false', r.status === 200 && /diagnosticsSave"?\s*[:=]\s*false/.test(r.text), r.text.slice(-200));
  r = await req(off, 'GET', '/diagnostics');
  check('/diagnostics serves the page', r.status === 200 && /text\/html/.test(r.headers['content-type']) && /3dHome diagnostics/.test(r.text));
  r = await req(off, 'GET', '/diagnostics/?mode=quick');
  check('/diagnostics/ redirects to /diagnostics, keeping the query', r.status === 301 && r.headers.location === '/diagnostics?mode=quick', r.headers);
  r = await req(off, 'GET', '/.git/config');
  check('dotfiles are not served', r.status === 404);
  r = await req(off, 'GET', '/%2e%2e/%2e%2e/etc/hosts');
  check('encoded traversal is not served', r.status === 404, r.status);
  off.close();

  const dir = path.join(tmp, 'runs');
  fs.mkdirSync(dir);
  let clock = new Date('2026-09-27T18:30:15.123Z');
  const on = await listen(DS.createHandler({ root, saveDir: dir, now: () => clock, limiter: () => true }));
  r = await req(on, 'GET', '/config.js');
  check('on: config.js says diagnosticsSave true', /diagnosticsSave"?\s*[:=]\s*true/.test(r.text));

  r = await req(on, 'POST', '/api/diagnostics', doc(), JSONH);
  const expectName = '2026-09-27T18-30-15.123Z_11111111-2222-4333-8444-555555555555_0.50.0';
  check('on: 201 with the server-made id', r.status === 201 && r.json.ok === true && r.json.id === expectName, r.json);
  check('on: receivedAt is the server clock', r.json.receivedAt === clock.toISOString(), r.json);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, expectName + '.json'), 'utf8'));
  check('on: the stored record keeps the client document', saved.summary[0] === 'x' && saved.save.deviceId.startsWith('1111'));
  check('on: the server adds receivedAt, file and bytes', saved.server.receivedAt === clock.toISOString() &&
    saved.server.file === expectName + '.json' && saved.server.bytes === Buffer.byteLength(doc()), saved.server);

  r = await req(on, 'POST', '/api/diagnostics', doc(), JSONH);
  check('clash: same name gets a -2 suffix', r.status === 201 && r.json.id === expectName + '-2', r.json);
  check('clash: the first file is untouched', JSON.parse(fs.readFileSync(path.join(dir, expectName + '.json'), 'utf8')).server.file === expectName + '.json');

  r = await req(on, 'GET', '/api/diagnostics');
  check('write-only: GET is refused (405), nothing listed', r.status === 405 && r.text.indexOf(expectName) === -1, r);
  r = await req(on, 'GET', '/api/diagnostics/' + expectName + '.json');
  check('write-only: no read-back of a saved run', r.status === 404, r.status);

  r = await req(on, 'POST', '/api/diagnostics', doc(), { 'Content-Type': 'text/plain' });
  check('415 for a non-JSON content type', r.status === 415, r);
  r = await req(on, 'POST', '/api/diagnostics', doc(), { 'Content-Type': 'application/json; charset=utf-8' });
  check('a charset parameter on application/json is fine', r.status === 201, r);
  r = await req(on, 'POST', '/api/diagnostics', '{not json', JSONH);
  check('400 for bad JSON', r.status === 400 && /not valid JSON/.test(r.json.error), r);
  r = await req(on, 'POST', '/api/diagnostics', '[1,2]', JSONH);
  check('400 for a JSON array', r.status === 400, r);
  r = await req(on, 'POST', '/api/diagnostics', '', JSONH);
  check('400 for an empty body', r.status === 400, r);
  r = await req(on, 'POST', '/api/diagnostics', doc({ schemaVersion: 2 }), JSONH);
  check('422 for the wrong schemaVersion', r.status === 422, r);
  r = await req(on, 'POST', '/api/diagnostics', doc({ schemaVersion: '1' }), JSONH);
  check('422 for a string schemaVersion', r.status === 422, r);
  r = await req(on, 'POST', '/api/diagnostics', doc({ schema: 'other' }), JSONH);
  check('422 for the wrong schema id', r.status === 422, r);

  const before = fs.readdirSync(dir).length;
  const pad = n => doc({ pad: 'x'.repeat(n) });
  const base = Buffer.byteLength(pad(0));
  clock = new Date('2026-09-27T18:31:00.000Z');
  r = await req(on, 'POST', '/api/diagnostics', pad(C.MAX_BYTES - base), JSONH);
  check('a body of exactly MAX_BYTES is accepted', r.status === 201, r.status);
  r = await req(on, 'POST', '/api/diagnostics', pad(C.MAX_BYTES - base + 1), JSONH);
  check('MAX_BYTES + 1 is refused 413', r.status === 413 || r.status === 'reset', r.status);
  r = await req(on, 'POST', '/api/diagnostics', pad(300 * 1024), JSONH);
  check('300 KB is refused 413', r.status === 413 || r.status === 'reset', r.status);
  check('refusals write nothing', fs.readdirSync(dir).length === before + 1, fs.readdirSync(dir));

  // Sanitising: nothing the client sends can leave the directory.
  clock = new Date('2026-09-27T18:32:00.000Z');
  r = await req(on, 'POST', '/api/diagnostics', doc({ save: { deviceId: '../../etc/pass wd', appVersion: '../../x/y;rm -rf' } }), JSONH);
  check('hostile id/version: saved', r.status === 201, r);
  check('hostile id/version: sanitised name', r.json.id === '2026-09-27T18-32-00.000Z_etcpasswd_xyrm-rf', r.json.id);
  const all = fs.readdirSync(dir);
  check('hostile id/version: the file is inside the directory', all.indexOf(r.json.id + '.json') !== -1, all);
  check('hostile id/version: nothing written outside', !fs.existsSync(path.join(tmp, 'etc')) && fs.readdirSync(tmp).join() === 'runs', fs.readdirSync(tmp));
  r = await req(on, 'POST', '/api/diagnostics', doc({ save: {}, app: {} }), JSONH);
  check('missing id and version -> "unknown"', r.status === 201 && /_unknown_unknown(-\d+)?$/.test(r.json.id), r.json);
  on.close();

  // Rate limit: nginx's leaky bucket, 6/min burst 3 nodelay.
  let t = 0;
  const lim = DS.createLimiter(6, 3, () => t);
  const limited = await listen(DS.createHandler({ root, saveDir: dir, limiter: lim }));
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await req(limited, 'POST', '/api/diagnostics', doc({ save: { deviceId: 'rl' + i } }), JSONH)).status);
  check('rate limit: 1 + burst 3 pass, the 5th is 429', codes.join() === '201,201,201,201,429', codes);
  t += 10000;
  codes.length = 0;
  codes.push((await req(limited, 'POST', '/api/diagnostics', doc({ save: { deviceId: 'rl9' } }), JSONH)).status);
  codes.push((await req(limited, 'POST', '/api/diagnostics', doc({ save: { deviceId: 'rl10' } }), JSONH)).status);
  check('rate limit: one more after 10 s (6/min), then 429 again', codes.join() === '201,429', codes);
  limited.close();

  // The contract function directly.
  check('check: PUT is 405', C.check('PUT', 'application/json', doc(), 10).status === 405);
  check('check: bytes over the cap are 413 even with a small text', C.check('POST', 'application/json', '{}', C.MAX_BYTES + 1).status === 413);
  check('sanitizeVersion strips leading dots', C.sanitizeVersion('...v1.2') === 'v1.2');
  check('sanitizeId caps at 64', C.sanitizeId('a'.repeat(100)).length === 64);
  check('store refuses a relative directory', C.store('runs', { name: 'a.json', doc: {}, receivedAt: 'x' }, 2).status === 507);

  // ---- B. the nginx side, statically ----------------------------------------------------
  const read = p => fs.readFileSync(path.join(root, p), 'utf8');
  const nginx = read('deploy/nginx.conf');
  const onConf = read('deploy/diagnostics-on.conf');
  const offConf = read('deploy/diagnostics-off.conf');
  const docker = read('Dockerfile');
  const njs = read('deploy/njs/diagnostics.js');
  const serverAt = nginx.indexOf('\nserver {');
  const zoneAt = nginx.search(/^limit_req_zone \$binary_remote_addr zone=home3d_diag:1m rate=6r\/m;$/m);
  check('nginx: rate-limit zone at http level (before server)', zoneAt !== -1 && zoneAt < serverAt);
  check('nginx: the include is inside the server block', nginx.indexOf('include /etc/nginx/home3d-diagnostics.conf;') > serverAt);
  check('nginx: /diagnostics serves diagnostics.html', /location = \/diagnostics \{[^}]*try_files \/diagnostics\.html =404;/.test(nginx));
  check('nginx: /diagnostics/ redirects relatively, keeping the query',
    /location = \/diagnostics\/ \{\s*absolute_redirect off;\s*return 301 \/diagnostics\$is_args\$args;/.test(nginx));
  const capK = (onConf.match(/client_max_body_size (\d+)k;/) || [])[1];
  check('on-conf: body cap equals the contract MAX_BYTES', capK && +capK * 1024 === C.MAX_BYTES, capK);
  const bufK = (onConf.match(/client_body_buffer_size (\d+)k;/) || [])[1];
  check('on-conf: body buffered in memory (buffer >= cap)', bufK && +bufK >= +capK);
  check('on-conf: rate limited on the zone, 429', /limit_req zone=home3d_diag burst=3 nodelay;/.test(onConf) && /limit_req_status 429;/.test(onConf));
  check('on-conf: njs imported and used', /js_import home3d_diag from diagnostics\.js;/.test(onConf) && /js_content home3d_diag\.save;/.test(onConf));
  check('on-conf: directory placeholder present', /set \$home3d_diag_dir "__DIAG_DIR__";/.test(onConf));
  check('on-conf: exactly one location, no listing', (onConf.replace(/#.*$/gm, '').match(/\blocation\b\s*[=~^]?/g) || []).length === 1 && !/autoindex/.test(onConf));
  check('off-conf: a JSON 404', /return 404 '\{"ok":false/.test(offConf));
  const balanced = s => { const t = s.replace(/#.*$/gm, '').replace(/'[^']*'|"[^"]*"/g, ''); return (t.match(/\{/g) || []).length === (t.match(/\}/g) || []).length; };
  check('conf braces balance (nginx.conf, on, off)', balanced(nginx) && balanced(onConf) && balanced(offConf));
  ['deploy/diagnostics-off.conf /etc/nginx/home3d-diagnostics.conf', 'deploy/diagnostics-off.conf /etc/nginx/home3d-diagnostics-off.conf.template',
    'deploy/diagnostics-on.conf  /etc/nginx/home3d-diagnostics-on.conf.template', 'deploy/njs/diagnostics.js   /etc/nginx/njs/diagnostics.js']
    .forEach(line => check('Dockerfile installs ' + line.split(/\s+/)[0], docker.indexOf('COPY ' + line) !== -1));
  check('njs: default export only (njs has no named exports)', /^export default \{/m.test(njs) && !/^export (function|const|var|let) /m.test(njs));
  check('njs: exports the save handler', /save: save/.test(njs));
  check('njs: nothing Node-only', !/\brequire\(|\bprocess\.|\bBuffer\.|\bawait\b|\basync\b|\bclass\b/.test(njs.replace(/\/\*[\s*][\s\S]*?\*\//g, '')));

  // ---- C. the entrypoint, in a sandbox -------------------------------------------------------
  const posix = p => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):/, (m, d) => '/' + d.toLowerCase()).replace(/\\/g, '/') : p);
  function sandbox() {
    const sb = fs.mkdtempSync(path.join(tmp, 'sb-'));
    fs.mkdirSync(path.join(sb, 'web'));
    fs.writeFileSync(path.join(sb, 'web', 'index.html'), '<p>__VERSION__</p>');
    fs.copyFileSync(path.join(root, 'diagnostics.html'), path.join(sb, 'web', 'diagnostics.html'));
    fs.copyFileSync(path.join(root, 'deploy', 'nginx.conf'), path.join(sb, 'default.conf'));
    fs.writeFileSync(path.join(sb, 'nginx.conf'), 'user nginx;\nevents {}\n');
    fs.copyFileSync(path.join(root, 'deploy', 'diagnostics-on.conf'), path.join(sb, 'on.template'));
    fs.copyFileSync(path.join(root, 'deploy', 'diagnostics-off.conf'), path.join(sb, 'off.template'));
    fs.writeFileSync(path.join(sb, 'module.so'), '');
    fs.mkdirSync(path.join(sb, 'runs'));
    return sb;
  }
  function entry(sb, diagDir, extra) {
    const env = Object.assign({}, process.env, {
      HOME3D_WEB_ROOT: posix(path.join(sb, 'web')), HOME3D_NGINX_CONF: posix(path.join(sb, 'default.conf')),
      HOME3D_DIAG_CONF: posix(path.join(sb, 'live.conf')), HOME3D_DIAG_ON_TEMPLATE: posix(path.join(sb, 'on.template')),
      HOME3D_DIAG_OFF_TEMPLATE: posix(path.join(sb, 'off.template')), HOME3D_MAIN_NGINX_CONF: posix(path.join(sb, 'nginx.conf')),
      HOME3D_NJS_MODULE: posix(path.join(sb, 'module.so')), APP_VERSION: '9.9.9'
    }, extra || {});
    delete env.HOME3D_DIAGNOSTICS_DIR;
    delete env.HOME3D_DIAGNOSTICS_SAVE;
    if (diagDir != null) env.HOME3D_DIAGNOSTICS_DIR = diagDir;
    let log = '';
    try { log = execFileSync('sh', [path.join(root, 'deploy', 'entrypoint.sh')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { log = String(e.stdout || '') + String(e.stderr || ''); return { failed: true, log }; }
    const live = fs.existsSync(path.join(sb, 'live.conf')) ? fs.readFileSync(path.join(sb, 'live.conf'), 'utf8') : '';
    return { failed: false, live, main: fs.readFileSync(path.join(sb, 'nginx.conf'), 'utf8'),
      config: fs.readFileSync(path.join(sb, 'web', 'config.js'), 'utf8'),
      diagHtml: fs.readFileSync(path.join(sb, 'web', 'diagnostics.html'), 'utf8') };
  }
  let sb = sandbox();
  let e = entry(sb, null);
  check('entrypoint: runs', !e.failed, e.log);
  if (!e.failed) {
    check('entrypoint unset: off conf installed', /return 404/.test(e.live) && !/js_content/.test(e.live));
    check('entrypoint unset: no load_module', !/load_module/.test(e.main));
    check('entrypoint unset: config.js diagnosticsSave false', /diagnosticsSave: false/.test(e.config), e.config);
    check('entrypoint: diagnostics.html version-stamped', e.diagHtml.indexOf('__VERSION__') === -1 && /three\.module\.min\.js\?v=9\.9\.9/.test(e.diagHtml));
    check('entrypoint: diagnostics.html module imports stamped', /runner\.js\?v=9\.9\.9/.test(e.diagHtml));
  }
  sb = sandbox();
  const good = posix(path.join(sb, 'runs'));
  e = entry(sb, good);
  check('entrypoint on: runs', !e.failed, e.log);
  if (!e.failed) {
    check('entrypoint on: on conf with the directory', /js_content home3d_diag\.save;/.test(e.live) && e.live.indexOf('set $home3d_diag_dir "' + good + '";') !== -1, e.live.slice(-400));
    check('entrypoint on: load_module first line', e.main.split('\n')[0] === 'load_module ' + posix(path.join(sb, 'module.so')) + ';', e.main);
    check('entrypoint on: config.js diagnosticsSave true', /diagnosticsSave: true/.test(e.config));
    const again = entry(sb, good);
    check('entrypoint on twice: load_module added once', (again.main.match(/load_module/g) || []).length === 1, again.main);
  }
  [['relative path', 'runs'], ['.. segment', good + '/../runs'], ['quote injection', good + '";'], ['a $variable', good + '$x'],
    ['missing directory', good + '-nope']].forEach(([why, dir]) => {
    const s2 = sandbox();
    const x = entry(s2, dir);
    check('entrypoint refuses ' + why + ': stays off', !x.failed && /return 404/.test(x.live) && /diagnosticsSave: false/.test(x.config) && !/load_module/.test(x.main), x.log || x.live);
  });
  const s3 = sandbox();
  fs.unlinkSync(path.join(s3, 'module.so'));
  const x3 = entry(s3, posix(path.join(s3, 'runs')));
  check('entrypoint without the njs module: stays off', !x3.failed && /return 404/.test(x3.live) && /diagnosticsSave: false/.test(x3.config));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`test-diagnostics-save: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
