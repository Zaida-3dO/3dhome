/**
 * page-io.js - the /diagnostics page's side effects, behind an injected
 * `win` so scripts/test-diagnostics-page-io.mjs can drive every failure path
 * (item 112ec00c).
 *
 *   getDeviceIdentity  a random device id, generated once and kept in
 *                      localStorage, plus the remembered device name. Storage
 *                      can be absent, disabled (private mode) or throwing
 *                      (some embedded webviews); every access is wrapped, and
 *                      an id that could not be stored is reported as
 *                      `persistent: false` rather than pretending.
 *   copyText           the async Clipboard API, then the legacy execCommand
 *                      path; reports which one worked, or why neither did, so
 *                      the page can fall back to a selectable textarea.
 *   saveRun            POST the result to the save endpoint; a clear error for
 *                      every non-2xx the endpoint can return.
 */

// The app's CURRENT adaptive record (the v2 key since task e7e10870).
import { STATE_PREFIX as STATE_KEY_PREFIX, saveState } from '../adaptive-quality.js';

export const ID_KEY = 'home3d.diagnostics.deviceId';
export const NAME_KEY = 'home3d.diagnostics.deviceName';

function storage(win) {
  try { return win.localStorage || null; } catch (e) { return null; }
}

function uuid(win) {
  try { if (win.crypto && typeof win.crypto.randomUUID === 'function') return win.crypto.randomUUID(); } catch (e) { /* fall through */ }
  const b = new Uint8Array(16);
  try { win.crypto.getRandomValues(b); } catch (e) { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let sessionId = null;

/** @returns {{deviceId: string, persistent: boolean, deviceName: string}} */
export function getDeviceIdentity(win) {
  const s = storage(win);
  let id = null, name = '';
  try { id = s ? s.getItem(ID_KEY) : null; } catch (e) { id = null; }
  try { name = (s ? s.getItem(NAME_KEY) : '') || ''; } catch (e) { name = ''; }
  if (id && ID_RE.test(id)) return { deviceId: id, persistent: true, deviceName: name };
  id = sessionId || uuid(win);
  let persistent = false;
  try {
    if (s) { s.setItem(ID_KEY, id); persistent = s.getItem(ID_KEY) === id; }
  } catch (e) { persistent = false; }
  if (!persistent) sessionId = id;   // at least stable for this page's life
  return { deviceId: id, persistent, deviceName: name };
}

/** Remember the device name (trimmed, <= 60 chars). Returns whether it stuck. */
export function setDeviceName(win, name) {
  const v = String(name || '').trim().slice(0, 60);
  const s = storage(win);
  try { if (!s) return false; if (v) s.setItem(NAME_KEY, v); else s.removeItem(NAME_KEY); return true; } catch (e) { return false; }
}

/** @returns {Promise<{ok: boolean, method?: string, error?: string}>} */
export async function copyText(win, text) {
  const errs = [];
  const nav = win.navigator || {};
  if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try { await nav.clipboard.writeText(text); return { ok: true, method: 'Clipboard API' }; }
    catch (e) { errs.push('Clipboard API: ' + (e && e.message ? e.message : e)); }
  } else errs.push('no Clipboard API');
  const doc = win.document;
  if (doc && typeof doc.execCommand === 'function' && doc.body) {
    let ta = null;
    try {
      ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      doc.body.appendChild(ta);
      ta.select();
      if (ta.setSelectionRange) ta.setSelectionRange(0, text.length);
      const ok = doc.execCommand('copy');
      if (ok) return { ok: true, method: 'execCommand' };
      errs.push('execCommand returned false');
    } catch (e) { errs.push('execCommand: ' + (e && e.message ? e.message : e)); }
    finally { if (ta && ta.parentNode) ta.parentNode.removeChild(ta); }
  } else errs.push('no execCommand');
  return { ok: false, error: errs.join('; ') };
}

const MESSAGES = {
  404: 'the save endpoint is not enabled on this server',
  405: 'the server refused the method',
  413: 'the result is larger than the server accepts',
  415: 'the server wants application/json',
  422: 'the server rejected the result format',
  429: 'too many saves in a short time; wait a minute and try again',
  507: 'the server could not write the file'
};

/** POST the result. @returns {Promise<{ok: boolean, id?: string, error?: string}>} */
export async function saveRun(win, url, doc) {
  let res;
  try {
    res = await win.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc), credentials: 'same-origin', cache: 'no-store' });
  } catch (e) {
    return { ok: false, error: 'network error: ' + (e && e.message ? e.message : e) };
  }
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (res.ok && body && typeof body.id === 'string') return { ok: true, id: body.id, receivedAt: body.receivedAt || null };
  const detail = body && body.error ? body.error : (MESSAGES[res.status] || 'unexpected response');
  return { ok: false, error: 'HTTP ' + res.status + ': ' + detail };
}

/**
 * "Apply recommended level" (binding addition #1, optional part): write a
 * level into the app's OWN adaptive-quality record for this device, in the
 * app's own format (adaptive-quality.js saveState), so the NEXT load of the
 * 3D view builds it. The previous raw value is returned so the page can show
 * it and undo exactly. A block or ratio cap from the old record is dropped
 * with it: they described the old level. The app keeps measuring afterwards
 * and will step down again by itself if the device cannot hold it.
 *
 * @returns {{ok: boolean, previousRaw: ?string, error?: string}}
 */
export function applyStoredLevel(win, key, level) {
  const s = storage(win);
  if (!s || typeof key !== 'string' || key.indexOf(STATE_KEY_PREFIX) !== 0 || !Number.isInteger(level)) {
    return { ok: false, previousRaw: null, error: s ? 'bad key or level' : 'storage unavailable' };
  }
  let prev = null;
  try { prev = s.getItem(key); } catch (e) { return { ok: false, previousRaw: null, error: 'storage unreadable' }; }
  // The app's own writer, so the format (and its version) cannot drift.
  if (saveState(s, key, { level, blocked: null, dprCap: null, strike: null, settled: null })) return { ok: true, previousRaw: prev };
  return { ok: false, previousRaw: prev, error: 'storage refused the write' };
}

/** Undo applyStoredLevel: put the previous raw value back (or remove the key). */
export function restoreStoredLevel(win, key, previousRaw) {
  const s = storage(win);
  try {
    if (!s) return false;
    if (previousRaw == null) s.removeItem(key); else s.setItem(key, previousRaw);
    return true;
  } catch (e) { return false; }
}
