/*
 * diagnostics.js - the "Save diagnostic run" endpoint (item 112ec00c).
 *
 * ONE FILE, TWO RUNTIMES. nginx loads it with njs (js_import, see
 * deploy/diagnostics-on.conf) and calls `save(r)`. scripts/dev-server.mjs
 * imports the SAME file under Node and calls `check()` / `store()` with the
 * same arguments, so the local preview exercises the exact contract the
 * container enforces. Keep it to the JavaScript both engines run: ES2015-ish,
 * `export default` only (njs has no named exports), and only the `fs`
 * functions the two share (writeFileSync with a flag).
 *
 * THE CONTRACT (docs/diagnostics.md repeats it; keep the two in step):
 *
 *   POST only                               else 405
 *   Content-Type: application/json          else 415
 *   body <= MAX_BYTES (256 KB)              else 413  (nginx's client_max_body_size
 *                                                      rejects first; this is the backstop)
 *   parses as a JSON object                 else 400
 *   schema "home3d-diagnostics" and
 *   schemaVersion === SCHEMA_VERSION        else 422
 *   write succeeds                          else 507
 *   -> 201 {"ok":true,"id":"<file name without .json>","receivedAt":"<ISO>"}
 *
 *   WRITE-ONLY: there is no read, list or delete over HTTP. Runs are read by
 *   agents on the host.
 *   SERVER-GENERATED NAMES: <receivedAt ISO, ':' -> '-'>_<device id>_<version>.json,
 *   the id reduced to [A-Za-z0-9-] (64 max) and the version to [A-Za-z0-9._+-]
 *   (40 max, and no leading dot). Nothing the client sends can add a '/', so
 *   nothing can leave the directory. Created with the exclusive flag ('wx'):
 *   an existing file is never overwritten; a clash gets a -2, -3 ... suffix.
 *   The server adds its own block to the stored record:
 *     "server": {"receivedAt": ISO, "file": name, "bytes": n}
 */

import fs from 'fs';

var SCHEMA = 'home3d-diagnostics';
var SCHEMA_VERSION = 1;
var MAX_BYTES = 262144;

function sanitizeId(v) {
  var s = String(v == null ? '' : v).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
  return s || 'unknown';
}

function sanitizeVersion(v) {
  var s = String(v == null ? '' : v).replace(/[^A-Za-z0-9._+-]/g, '').replace(/^\.+/, '').slice(0, 40);
  return s || 'unknown';
}

function stamp(date) {
  return date.toISOString().replace(/:/g, '-');
}

function fileNameFor(doc, date) {
  var save = doc && typeof doc.save === 'object' && doc.save ? doc.save : {};
  var app = doc && typeof doc.app === 'object' && doc.app ? doc.app : {};
  return stamp(date) + '_' + sanitizeId(save.deviceId) + '_' + sanitizeVersion(save.appVersion || app.version) + '.json';
}

/*
 * Validate a request. Pure: no I/O.
 * Returns {status, error} for a refusal, or {status: 201, doc, name, receivedAt}.
 */
function check(method, contentType, bodyText, bodyBytes, now) {
  if (method !== 'POST') return { status: 405, error: 'POST only' };
  var ct = String(contentType || '').toLowerCase();
  if (ct.split(';')[0].trim() !== 'application/json') return { status: 415, error: 'Content-Type must be application/json' };
  if (!(bodyBytes >= 0) || bodyBytes > MAX_BYTES) return { status: 413, error: 'body larger than ' + MAX_BYTES + ' bytes' };
  if (typeof bodyText !== 'string' || !bodyText.length) return { status: 400, error: 'empty body' };
  var doc;
  try { doc = JSON.parse(bodyText); } catch (e) { return { status: 400, error: 'body is not valid JSON' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { status: 400, error: 'body must be a JSON object' };
  if (doc.schema !== SCHEMA || doc.schemaVersion !== SCHEMA_VERSION) {
    return { status: 422, error: 'expected schema "' + SCHEMA + '" version ' + SCHEMA_VERSION };
  }
  var date = now || new Date();
  return { status: 201, doc: doc, name: fileNameFor(doc, date), receivedAt: date.toISOString() };
}

/*
 * Write a checked record into `dir`. Never overwrites. Returns
 * {status: 201, body} or {status: 507, error}.
 */
function store(dir, ok, bodyBytes) {
  if (!dir || dir.charAt(0) !== '/' && !/^[A-Za-z]:[\\/]/.test(dir)) return { status: 507, error: 'save directory is not configured' };
  var base = ok.name.slice(0, -5);
  for (var i = 1; i <= 20; i++) {
    var name = i === 1 ? ok.name : base + '-' + i + '.json';
    var rec = ok.doc;
    rec.server = { receivedAt: ok.receivedAt, file: name, bytes: bodyBytes };
    try {
      fs.writeFileSync(dir.replace(/[\\/]+$/, '') + '/' + name, JSON.stringify(rec), { flag: 'wx', mode: 420 });
      return { status: 201, body: { ok: true, id: name.slice(0, -5), receivedAt: ok.receivedAt } };
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;
      return { status: 507, error: 'could not write the run' };
    }
  }
  return { status: 507, error: 'too many runs with the same name' };
}

function reply(r, status, obj) {
  r.headersOut['Content-Type'] = 'application/json';
  r.headersOut['Cache-Control'] = 'no-store';
  r.return(status, JSON.stringify(obj));
}

/* The nginx handler (js_content). */
function save(r) {
  var buf = r.requestBuffer;
  var bytes = buf ? buf.length : (r.requestText ? r.requestText.length : 0);
  var text = buf ? buf.toString('utf8') : (r.requestText || '');
  var ok = check(r.method, r.headersIn['Content-Type'], text, bytes, new Date());
  if (ok.status !== 201) { reply(r, ok.status, { ok: false, error: ok.error }); return; }
  var res = store(r.variables.home3d_diag_dir, ok, bytes);
  if (res.status !== 201) {
    r.error('home3d diagnostics: ' + res.error);
    reply(r, res.status, { ok: false, error: res.error });
    return;
  }
  reply(r, 201, res.body);
}

export default { save: save, check: check, store: store, fileNameFor: fileNameFor,
  sanitizeId: sanitizeId, sanitizeVersion: sanitizeVersion,
  SCHEMA: SCHEMA, SCHEMA_VERSION: SCHEMA_VERSION, MAX_BYTES: MAX_BYTES };
