#!/usr/bin/env node
/**
 * Edit-mode drafts (src/profile-draft.js) and their export
 * (src/profile-export.js). No framework, no install:
 *   node scripts/test-profile-draft.mjs
 *   node scripts/test-profile-draft.mjs --write <dir>
 *       also writes an EDITED demo export (a view on a room, a furniture
 *       item and a curtain) over the two JSON files in <dir> -- a temp COPY
 *       of houses/demo, so its textures and models resolve -- for CI's
 *       house-profiles job to run `validate-house.py --strict` on. <dir>
 *       must be outside the repo.
 *
 * WHAT THIS GUARDS
 *   1. A draft is NEVER applied under ?preview=true, ?embed=1 or in an
 *      iframe, even with one stored (bootDraft); it is applied otherwise.
 *   2. The draft holds exactly { houseId, baseHash, geometry, rooms, savedAt }:
 *      a token passed alongside is dropped, and a token-shaped value inside a
 *      document is refused -- in the draft and in the export.
 *   3. A malformed / other-house / unreadable draft reads as none.
 *   4. "Use this view": a camera pose -> profile `view` -> compiled by the
 *      loader's own compileFocusView is the SAME pose (to 1e-6 rad, 0.1 mm).
 *   5. setOwnerView writes the view on the right room / furniture / curtain,
 *      raises schemaVersion to 1.4, and clearOwnerView removes it.
 *   6. Export of the unedited demo is byte-identical to the served files;
 *      an edited export round-trips through HouseLoader.compile with the view.
 *   7. baseHash changes when either served file changes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const readRaw = rel => fs.readFileSync(path.join(root, rel), 'utf8');

let passes = 0, failures = 0;
function check(name, ok, detail) {
  if (ok) { passes++; console.log('  ok   ' + name); }
  else { failures++; console.error('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail).slice(0, 600) : '')); }
}
function throws(fn) { try { fn(); return false; } catch (e) { return true; } }

const D = await imp('src/profile-draft.js');
const { exportProfile } = await imp('src/profile-export.js');
const { compileFocusView } = await imp('src/camera-focus.js');
const { HouseLoader } = await imp('src/house-loader.js');

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}

const geoText = readRaw('houses/demo/geometry.json');
const roomsText = readRaw('houses/demo/rooms.json');
const served = { geometryText: geoText, roomsText, hash: D.baseHashOf(geoText, roomsText) };
// A fake HA token: JWT-shaped, built at runtime so no token-like literal sits in the repo.
const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_TOKEN = [b64url({ typ: 'JWT', alg: 'HS256' }), b64url({ iss: 'demo-test-token' }), Buffer.from('demo_signature_not_real').toString('base64url')].join('.');

console.log('1. where a draft may apply');
{
  const st = memStorage();
  D.writeDraft(st, { houseId: 'demo', baseHash: served.hash, geometry: JSON.parse(geoText), rooms: JSON.parse(roomsText) });
  check('standalone page: the stored draft applies', !!D.bootDraft(st, 'demo', { isPreview: false, isEmbed: false, isFramed: false }));
  check('?preview=true: never', D.bootDraft(st, 'demo', { isPreview: true }) === null);
  check('?embed=1 (HA popup): never', D.bootDraft(st, 'demo', { isEmbed: true }) === null);
  check('inside an iframe (wall-tablet embed): never', D.bootDraft(st, 'demo', { isFramed: true }) === null);
  check('another house: none', D.bootDraft(st, 'other', {}) === null);
  check('draftAllowed mirrors it', D.draftAllowed({}) && !D.draftAllowed({ isPreview: true }) && !D.draftAllowed({ isEmbed: true }) && !D.draftAllowed({ isFramed: true }));
}

console.log('2. nothing but the two documents goes in');
{
  const st = memStorage();
  const cfg = { house: 'demo', url: 'http://homeassistant.local:8123', token: FAKE_TOKEN };
  // The worst case: a caller hands the whole config in beside the documents.
  const d = D.writeDraft(st, Object.assign({}, cfg, { houseId: 'demo', baseHash: 'x', geometry: JSON.parse(geoText), rooms: JSON.parse(roomsText) }));
  check('stored draft has exactly the five fields', JSON.stringify(Object.keys(d).sort()) === JSON.stringify(['baseHash', 'geometry', 'houseId', 'rooms', 'savedAt']), Object.keys(d));
  const raw = st.getItem(D.draftKey('demo'));
  check('the token is nowhere in storage', !raw.includes(FAKE_TOKEN) && !raw.includes('"token"'));
  const t = exportProfile(served, d);
  check('the token is nowhere in the export', !t.geometry.includes(FAKE_TOKEN) && !t.rooms.includes(FAKE_TOKEN));
  const poisoned = JSON.parse(roomsText);
  poisoned.homeAssistant.note = FAKE_TOKEN;
  check('a token-shaped value in a document is refused by the draft', throws(() => D.writeDraft(memStorage(), { houseId: 'demo', geometry: JSON.parse(geoText), rooms: poisoned })));
  check('... and by the export', throws(() => exportProfile(served, { geometry: JSON.parse(geoText), rooms: poisoned })));
  check('findTokenLike names the path', JSON.stringify(D.findTokenLike(poisoned)) === '["homeAssistant.note"]', D.findTokenLike(poisoned));
  check('the real demo profile has nothing token-shaped', D.findTokenLike(JSON.parse(geoText)).length === 0 && D.findTokenLike(JSON.parse(roomsText)).length === 0);
}

console.log('3. a bad draft reads as none');
{
  const st = memStorage();
  st.setItem(D.draftKey('demo'), '{not json');
  check('unparseable', D.readDraft(st, 'demo') === null);
  st.setItem(D.draftKey('demo'), JSON.stringify({ houseId: 'demo', geometry: [] }));
  check('geometry not an object', D.readDraft(st, 'demo') === null);
  st.setItem(D.draftKey('demo'), JSON.stringify({ houseId: 'other', geometry: {} }));
  check('another house\'s draft under this key', D.readDraft(st, 'demo') === null);
  const blocked = { getItem() { throw new Error('SecurityError'); } };
  check('storage that throws', D.readDraft(blocked, 'demo') === null && D.bootDraft(null, 'demo', {}) === null);
  D.clearDraft(st, 'demo');
  check('clearDraft removes it', st.getItem(D.draftKey('demo')) === null);
}

console.log('4. pose -> view -> pose is the same pose');
{
  const geo = JSON.parse(geoText);
  const ct = geo.coordinateTransform;
  const tx = x => (x - ct.originX) * ct.scale, tz = y => (y - ct.originY) * ct.scale;
  const pose = { th: 7.123456789, ph: 0.987654321, r: 6.54321, tgt: [1.23456, 0.876543, -0.54321], fov: 37.5 };
  const v = D.poseToFocusView(pose, ct);
  const back = compileFocusView(v, tx, tz);
  const dth = Math.abs(D.wrapAngle(back.th - pose.th));
  check('azimuth (folded into (-pi, pi]) to 1e-6', dth < 1e-6 && v.azimuth > -Math.PI && v.azimuth <= Math.PI, { dth, v });
  check('polar to 1e-6, distance to 0.1 mm, fov', Math.abs(back.ph - pose.ph) < 1e-6 && Math.abs(back.r - pose.r) < 1e-4 && back.fov === 37.5);
  check('target (plan cm through the transform) to 0.1 mm', back.tgt.every((c, k) => Math.abs(c - pose.tgt[k]) < 1e-4), back.tgt);
  check('targetHeight is the target\'s height in cm', Math.abs(v.targetHeight - 87.65) < 0.01, v.targetHeight);
}

console.log('5. writing and clearing a view');
{
  const geo = JSON.parse(geoText);
  const view = { azimuth: 0.5, polar: 0.9, distance: 5, target: [100, 120], targetHeight: 80, fov: 45 };
  const room = geo.rooms[1].id, item = geo.furniture[2].id, curtain = (geo.curtains || [])[0].id;
  let g = D.setOwnerView(geo, { kind: 'room', id: room }, view);
  check('room view set (input untouched)', g.rooms[1].view.distance === 5 && geo.rooms[1].view === undefined);
  check('schemaVersion raised to 1.4', g.schemaVersion === '1.4' && geo.schemaVersion !== '1.4');
  g = D.setOwnerView(g, { kind: 'furniture', id: item }, view);
  g = D.setOwnerView(g, { kind: 'curtain', id: curtain }, view);
  check('furniture and curtain views set', g.furniture[2].view.fov === 45 && g.curtains[0].view.fov === 45);
  check('an unknown owner throws', throws(() => D.setOwnerView(geo, { kind: 'room', id: 'nope' }, view)));
  const newer = Object.assign(JSON.parse(geoText), { schemaVersion: '1.9' });
  check('a newer schemaVersion is never lowered', D.setOwnerView(newer, { kind: 'room', id: room }, view).schemaVersion === '1.9');
  const c = D.clearOwnerView(g, { kind: 'room', id: room });
  check('clearOwnerView removes just that one', c.rooms[1].view === undefined && c.furniture[2].view && g.rooms[1].view);
  check('version compare', D.compareVersions('1.10', '1.4') > 0 && D.compareVersions('1.3', '1.4') < 0 && D.compareVersions('1.4', '1.4') === 0);
}

console.log('6. export');
{
  const st = memStorage();
  const d = D.writeDraft(st, { houseId: 'demo', baseHash: served.hash, geometry: JSON.parse(geoText), rooms: JSON.parse(roomsText) });
  const t = exportProfile(served, D.readDraft(st, 'demo'));
  check('unedited demo: geometry.json byte-identical to the served file', t.geometry === geoText);
  check('unedited demo: rooms.json byte-identical to the served file', t.rooms === roomsText);
  check('a draft with no rooms doc exports the served rooms.json as-is', exportProfile(served, { geometry: d.geometry, rooms: null }).rooms === roomsText);

  const geo = JSON.parse(geoText);
  const view = D.poseToFocusView({ th: 0.8, ph: 0.95, r: 4.2, tgt: [0.5, 0.9, 0.4], fov: 45 }, geo.coordinateTransform);
  let g = D.setOwnerView(geo, { kind: 'room', id: geo.rooms[0].id }, view);
  g = D.setOwnerView(g, { kind: 'furniture', id: geo.furniture[0].id }, view);
  g = D.setOwnerView(g, { kind: 'curtain', id: geo.curtains[0].id }, view);
  const edited = exportProfile(served, { geometry: g, rooms: d.rooms });
  check('edited export parses back to the draft', JSON.stringify(JSON.parse(edited.geometry)) === JSON.stringify(g));
  // Lines of the export that are not lines of the served file (a multiset difference).
  const lines = (a, b) => {
    const pool = new Map();
    a.split('\n').forEach(l => pool.set(l, (pool.get(l) || 0) + 1));
    return b.split('\n').filter(l => { const n = pool.get(l) || 0; if (n) { pool.set(l, n - 1); return false; } return true; }).length;
  };
  check('edited export: a handful of lines differ, not the file', lines(geoText, edited.geometry) < 12 && edited.rooms === roomsText, lines(geoText, edited.geometry));
  const house = HouseLoader.compile(JSON.parse(edited.geometry), 'houses/demo/');
  const rv = house.rooms[geo.rooms[0].id].view;
  check('the loader compiles the exported room view to the framed pose', rv && Math.abs(rv.r - 4.2) < 1e-9 && Math.abs(rv.tgt[0] - 0.5) < 1e-6 && Math.abs(rv.tgt[1] - 0.9) < 1e-6, rv);

  const at = process.argv.indexOf('--write');
  if (at > 0) {
    const dir = path.resolve(process.argv[at + 1] || '');
    if (!process.argv[at + 1] || dir.startsWith(root + path.sep)) { console.error('--write needs a directory outside the repo'); process.exit(2); }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'geometry.json'), edited.geometry);
    fs.writeFileSync(path.join(dir, 'rooms.json'), edited.rooms);
    console.log('  wrote the edited export to ' + dir);
  }
}

console.log('7. baseHash');
{
  check('stable', D.baseHashOf(geoText, roomsText) === served.hash);
  check('changes with geometry.json', D.baseHashOf(geoText + ' ', roomsText) !== served.hash);
  check('changes with rooms.json', D.baseHashOf(geoText, roomsText.replace('demo', 'demx')) !== served.hash);
  check('a missing rooms.json hashes too', typeof D.baseHashOf(geoText, null) === 'string');
}

console.log('8. the boot-time escape: Discard reachable before the banner exists');
{
  // A minimal DOM: enough for mountDraftEscape (createElement, getElementById,
  // body.appendChild, click listeners).
  function fakeDoc() {
    const byId = new Map();
    const mk = tag => {
      const e = { tagName: tag.toUpperCase(), children: [], style: {}, attrs: {}, listeners: {}, parentNode: null, textContent: '' };
      e.setAttribute = (k, v) => { e.attrs[k] = v; };
      e.addEventListener = (t, f) => { (e.listeners[t] || (e.listeners[t] = [])).push(f); };
      e.appendChild = c => { c.parentNode = e; e.children.push(c); if (c.id) byId.set(c.id, c); return c; };
      e.removeChild = c => { e.children.splice(e.children.indexOf(c), 1); c.parentNode = null; if (c.id) byId.delete(c.id); return c; };
      e.click = () => (e.listeners.click || []).forEach(f => f({}));
      return e;
    };
    const doc = { createElement: mk, getElementById: id => byId.get(id) || null };
    doc.body = mk('body');
    return doc;
  }
  const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
  const store = mem();
  D.writeDraft(store, D.makeDraft({ houseId: 'demo', geometry: { a: 1 } }));
  const doc = fakeDoc();
  let reloads = 0, asked = null, answer = false;
  const box = D.mountDraftEscape(doc, store, 'demo', { confirm: t => { asked = t; return answer; }, reload: () => { reloads++; } });
  check('mounted on the body, above the boot cards (z-index 10001 > 10000)', box && doc.getElementById(D.DRAFT_ESCAPE_ID) === box && /z-index:10001/.test(box.style.cssText));
  const btn = box.children.find(c => c.tagName === 'BUTTON');
  check('it carries a Discard button', btn && /Discard/.test(btn.textContent));
  check('mounting twice keeps one', D.mountDraftEscape(doc, store, 'demo') === box && doc.body.children.length === 1);
  btn.click();
  check('Discard asks first; "no" keeps the draft', /Discard the draft/.test(asked || '') && D.readDraft(store, 'demo') && reloads === 0);
  answer = true;
  btn.click();
  check('"yes" clears the stored draft and reloads', D.readDraft(store, 'demo') === null && reloads === 1);
  D.removeDraftEscape(doc);
  check('removeDraftEscape takes it away (the banner has mounted)', doc.getElementById(D.DRAFT_ESCAPE_ID) === null && doc.body.children.length === 0);
  check('no document: nothing, no throw', D.mountDraftEscape(null, store, 'demo') === null);
}

void os;
console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
