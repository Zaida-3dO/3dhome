/**
 * profile-draft.js -- the edit-mode draft store (plan B section 3, shell S2).
 *
 * Edits never touch the live profile: the real one is a read-only mount, and
 * one person is its single writer. An edit goes into a DRAFT kept in this
 * device's localStorage, the page renders the draft instead of the served
 * profile (with a banner saying so), and Export downloads the two files for
 * a human to apply.
 *
 *   draft = { houseId, baseHash, geometry, rooms, savedAt }
 *
 * `geometry` and `rooms` are the WHOLE documents (the demo's are ~37 KB
 * together). `baseHash` is a hash of the served files' text when the draft
 * began, so the banner can say "the served profile changed under the draft".
 *
 * WHAT NEVER GOES IN. The Home Assistant token lives in config.js, never in
 * either profile document, and nothing here ever receives the config: every
 * function takes the two documents and nothing else. makeDraft copies ONLY
 * the five fields above, and assertNoSecrets refuses a document carrying a
 * token-shaped string, as a second line of defence.
 *
 * WHERE A DRAFT IS NEVER APPLIED. Under ?preview=true (the wall-tablet
 * tile), ?embed=1 (the Home Assistant popup) or inside any iframe: a device
 * holding a draft must still show the served house there. bootDraft is the
 * one entry point the page uses at boot, and it checks that first.
 *
 * Pure apart from the `storage` argument (a localStorage-like object): no
 * fetch, and no DOM except the boot-time escape hatch at the bottom, which
 * is handed its document. Safe to import at boot -- it is small and draws
 * nothing unless a draft is being rendered.
 * Unit-tested in scripts/test-profile-draft.mjs.
 */

export const DRAFT_KEY_PREFIX = 'home3d.profileDraft.';
/** The geometry schemaVersion that introduced `view` (camera focus). */
export const VIEW_SCHEMA_VERSION = '1.4';

export function draftKey(houseId) { return DRAFT_KEY_PREFIX + houseId; }

/**
 * May a draft be applied in this context? Never in the preview tile, the HA
 * popup (?embed=1) or any other iframe.
 */
export function draftAllowed(flags) {
  const f = flags || {};
  return !f.isPreview && !f.isEmbed && !f.isFramed;
}

/** cyrb53: a fast, well-mixed 53-bit string hash, as 14 hex digits. */
export function hashText(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

/** The served profile's identity: a hash of both files' exact text. */
export function baseHashOf(geometryText, roomsText) {
  return hashText(String(geometryText || '')) + '-' + hashText(String(roomsText || ''));
}

// An HA long-lived access token is a JWT: three base64url parts, the first
// starting "eyJ" (base64 of '{"'). Nothing in a house profile looks like it.
const TOKEN_RE = new RegExp('ey' + 'J[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}');

/** Paths (a.b[2].c) of every string in `doc` that looks like an access token. */
export function findTokenLike(doc) {
  const out = [];
  (function walk(v, p) {
    if (typeof v === 'string') { if (TOKEN_RE.test(v)) out.push(p || '(root)'); return; }
    if (Array.isArray(v)) { v.forEach((x, k) => walk(x, p + '[' + k + ']')); return; }
    if (v && typeof v === 'object') Object.keys(v).forEach(k => { if (TOKEN_RE.test(k)) out.push((p ? p + '.' : '') + '(key)'); walk(v[k], p ? p + '.' + k : k); });
  })(doc, '');
  return out;
}

/** Throws if either document carries a token-shaped string. */
export function assertNoSecrets(geometry, rooms) {
  const bad = findTokenLike(geometry).map(p => 'geometry.' + p).concat(findTokenLike(rooms).map(p => 'rooms.' + p));
  if (bad.length) throw new Error('refusing to keep a token-shaped value in a profile draft: ' + bad.join(', '));
}

const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

/**
 * A new draft. Takes the two documents and NOTHING else: any extra field on
 * `o` (a config, a token) is ignored, never copied.
 */
export function makeDraft(o, now) {
  if (!o || typeof o.houseId !== 'string' || !o.houseId) throw new Error('makeDraft: houseId required');
  if (!o.geometry || typeof o.geometry !== 'object') throw new Error('makeDraft: geometry document required');
  assertNoSecrets(o.geometry, o.rooms || null);
  return {
    houseId: o.houseId,
    baseHash: String(o.baseHash || ''),
    geometry: clone(o.geometry),
    rooms: o.rooms ? clone(o.rooms) : null,
    savedAt: new Date(now != null ? now : Date.now()).toISOString(),
  };
}

/** Is `d` a well-formed draft for `houseId`? */
export function isDraft(d, houseId) {
  return !!d && typeof d === 'object' && d.houseId === houseId &&
    !!d.geometry && typeof d.geometry === 'object' && !Array.isArray(d.geometry) &&
    (d.rooms == null || (typeof d.rooms === 'object' && !Array.isArray(d.rooms)));
}

/** The stored draft for `houseId`, or null (absent, unreadable or malformed). */
export function readDraft(storage, houseId) {
  if (!storage || !houseId) return null;
  let raw = null;
  try { raw = storage.getItem(draftKey(houseId)); } catch (e) { return null; }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return isDraft(d, houseId) ? d : null;
  } catch (e) { return null; }
}

/** Store a draft (re-made through makeDraft, so only its five fields go in). Returns the stored draft. */
export function writeDraft(storage, draft, now) {
  const d = makeDraft(draft, now);
  storage.setItem(draftKey(d.houseId), JSON.stringify(d));
  return d;
}

export function clearDraft(storage, houseId) {
  try { storage.removeItem(draftKey(houseId)); } catch (e) { /* storage blocked: nothing stored either */ }
}

/**
 * The draft to render at boot, or null. The ONLY way the page reads a draft
 * at boot: it refuses outright in the preview tile, the HA popup and iframes.
 */
export function bootDraft(storage, houseId, flags) {
  if (!draftAllowed(flags)) return null;
  return readDraft(storage, houseId);
}

// ---- Views ----------------------------------------------------------------

const round = (v, dp) => { const f = Math.pow(10, dp); return Math.round(v * f) / f; };

/** An angle folded into (-PI, PI]. */
export function wrapAngle(a) {
  const T = Math.PI * 2;
  let x = a % T;
  if (x > Math.PI) x -= T;
  else if (x <= -Math.PI) x += T;
  return x;
}

/**
 * A camera pose { th, ph, r, tgt: [x, y, z] (world m), fov } as a profile
 * `view` ($defs/focusView): plan-cm target through the house's
 * coordinateTransform, cm target height, radians, metres, degrees. Rounded
 * to a precision far below anything visible (1e-6 rad, 0.1 mm), so the file
 * stays readable and the pose flies back to the same place.
 */
export function poseToFocusView(pose, ct) {
  const S = ct && ct.scale ? ct.scale : 0.01, OX = ct ? ct.originX || 0 : 0, OY = ct ? ct.originY || 0 : 0;
  return {
    azimuth: round(wrapAngle(pose.th), 6),
    polar: round(pose.ph, 6),
    distance: round(pose.r, 4),
    target: [round(pose.tgt[0] / S + OX, 2), round(pose.tgt[2] / S + OY, 2)],
    targetHeight: round(pose.tgt[1] * 100, 2),
    fov: round(pose.fov != null ? pose.fov : 50, 2),
  };
}

/** Where a view lives: owner kind -> the geometry array holding it. */
const OWNER_ARRAYS = Object.freeze({ room: 'rooms', furniture: 'furniture', curtain: 'curtains' });

/** The geometry entry for an owner { kind, id }, or null. */
export function findOwner(geometry, owner) {
  const arr = owner && geometry ? geometry[OWNER_ARRAYS[owner.kind]] : null;
  return Array.isArray(arr) ? arr.find(e => e && e.id === owner.id) || null : null;
}

/** 'a.b' versions compared numerically: <0, 0, >0. */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(Number), pb = String(b || '0').split('.').map(Number);
  for (let k = 0; k < Math.max(pa.length, pb.length); k++) {
    const d = (pa[k] || 0) - (pb[k] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * A copy of `geometry` with `view` set on the owner (rooms[] / furniture[] /
 * curtains[] by id), and schemaVersion raised to 1.4 if it was older (the
 * validator refuses a `view` below 1.4). Throws for an unknown owner.
 */
export function setOwnerView(geometry, owner, view) {
  const g = clone(geometry);
  const e = findOwner(g, owner);
  if (!e) throw new Error('no ' + (owner && owner.kind) + ' "' + (owner && owner.id) + '" in this profile');
  e.view = clone(view);
  if (compareVersions(g.schemaVersion, VIEW_SCHEMA_VERSION) < 0) g.schemaVersion = VIEW_SCHEMA_VERSION;
  return g;
}

/** A copy of `geometry` with the owner's `view` removed (back to the derived view). */
export function clearOwnerView(geometry, owner) {
  const g = clone(geometry);
  const e = findOwner(g, owner);
  if (e) delete e.view;
  return g;
}

// ---- The boot-time escape hatch --------------------------------------------
//
// A draft that compiles but then crashes the scene build would otherwise
// strand the page: the boot error card comes up before the draft banner (and
// its Discard) ever mounts, and clearing localStorage needs devtools -- not
// something to ask of a phone or the wall tablet. So the page mounts this
// small "Discard the draft" control the moment it decides to render a draft,
// BEFORE anything that can throw, above the loading and error cards. The
// real banner removes it once it mounts (src/edit-mode.js renderBanner).
//
// The one helper here that touches a DOM: the document is passed in, so it
// stays testable without a browser (scripts/test-profile-draft.mjs).

export const DRAFT_ESCAPE_ID = 'home3d-draft-escape';

/**
 * Mount the escape control. `o.confirm(text)` and `o.reload()` default to the
 * window's. Returns the element (or the existing one).
 */
export function mountDraftEscape(doc, storage, houseId, o) {
  if (!doc || !doc.body) return null;
  const have = doc.getElementById(DRAFT_ESCAPE_ID);
  if (have) return have;
  const opt = o || {};
  const w = typeof window !== 'undefined' ? window : {};
  const confirmFn = opt.confirm || (t => (w.confirm ? w.confirm(t) : true));
  const reload = opt.reload || (() => w.location && w.location.reload());
  const box = doc.createElement('div');
  box.id = DRAFT_ESCAPE_ID;
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'Draft on this device');
  box.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:10001;' +
    'display:flex;align-items:center;gap:8px;padding:6px 8px 6px 12px;border-radius:10px;' +
    'background:rgba(120,53,15,0.94);color:#fff7ed;border:1px solid rgba(251,191,36,0.55);' +
    'font:500 12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;';
  const text = doc.createElement('span');
  text.textContent = 'Showing a DRAFT on this device';
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Discard draft';
  btn.style.cssText = 'font:600 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;padding:7px 10px;border-radius:7px;' +
    'border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.10);color:inherit;cursor:pointer;';
  btn.addEventListener('click', () => {
    if (!confirmFn('Discard the draft on this device? The served profile will be shown again.')) return;
    clearDraft(storage, houseId);
    reload();
  });
  box.appendChild(text);
  box.appendChild(btn);
  doc.body.appendChild(box);
  return box;
}

/** Remove the escape control (the full banner has taken over). */
export function removeDraftEscape(doc) {
  const e = doc && doc.getElementById ? doc.getElementById(DRAFT_ESCAPE_ID) : null;
  if (e && e.parentNode) e.parentNode.removeChild(e);
}
