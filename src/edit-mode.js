/**
 * edit-mode.js -- edit mode: the draft banner, "Frame the view", and moving
 * and re-tuning the furniture already placed (plan B1).
 *
 * LOADED LAZILY. index.html reaches this module only through a dynamic
 * import(), when the user enters edit mode from Settings or when this device
 * already holds a draft to show the banner for. A plain view-mode load (no
 * draft) never fetches it, so the wall tablet pays nothing for editing.
 * scripts/test-edit-mode-boot.mjs holds that line.
 *
 * WHAT IT DOES
 *   - The banner: "EDIT MODE" / "DRAFT on this device, not live", with
 *     Save (when there are unsaved furniture edits), Export, Discard and
 *     Done/Edit, and a warning when the served profile changed under the
 *     draft (its baseHash no longer matches).
 *   - Furniture (B1): tap an item to select it (an amber box), drag it on the
 *     floor to move it (snapped to 1 cm, kept inside its room; a
 *     wall-anchored item slides along its wall), rotate it by 15/90 degrees,
 *     nudge it with the arrow keys, re-tune its params from the type's
 *     control descriptors (src/furniture/controls.js), or delete it. Edits
 *     render live and are kept in memory until Save writes them to the draft.
 *     Dragging empty space still orbits; dragging an item never does.
 *   - Frame the view: with a room, a device or an item selected, orbit as
 *     normal, fine-tune Distance / Aim height / Lens, then "Use this view"
 *     writes the camera's pose as that owner's `view` into the draft.
 *
 * RENDERING. The scene does the heavy part (home3d-scene.js, "Edit-mode
 * furniture"): entering edit mode rebuilds the furniture one build per room,
 * the selected item is lifted out and built alone, and a change rebuilds
 * only it. Done restores the one house-wide build view mode uses.
 *
 * Everything that decides anything is in the pure modules: the draft store
 * (src/profile-draft.js), the furniture edits and their bounds
 * (src/edit-ops.js), the export (src/profile-export.js). This file is the
 * DOM around them.
 *
 * The context the page passes (index.html, loadEditMode):
 *   home          the scene handle
 *   container     the scene's container element (where taps land)
 *   houseId       the profile id; houseDir 'houses/<id>/'
 *   storage       localStorage (or null when blocked)
 *   draftApplied  the page rendered a stored draft at boot
 *   draftBroken   a stored draft failed to compile; the served house is shown
 *   compile(doc)  the page's HouseLoader.compile for this house
 *   currentRoom() the room selected in the sidebar, or null
 *   resolveOwner(device) -> { kind: 'furniture'|'curtain', id, label } | null
 *   roomLabel(id) -> string
 *   viewFor(owner) -> the pose the page would fly to for it (authored or derived)
 *   flyTo(pose)   fly the camera (the page's focus flight)
 *   debug         expose window.__home3dEdit for checks
 */

import { readDraft, writeDraft, clearDraft, makeDraft, baseHashOf, poseToFocusView,
  setOwnerView, clearOwnerView, findOwner, removeDraftEscape } from './profile-draft.js';
import { exportProfile } from './profile-export.js';
import { moveItem, rotateItem, setParam, deleteItem, dropItemBindings, findItem, isWallAnchored, checkFurnitureItem,
  confineToPoly, wallSpan, clamp, snapCm, liveRange, paramWrites, nudgeDir,
  distToSlider, sliderToDist, DIST_STEPS } from './edit-ops.js';
import { controlsFor, optionValue } from './furniture/controls.js';

/** The lens "Reset to derived" returns to: the scene camera's own default. */
export const DEFAULT_FOV = 50;
/** A slider change waits this long for the next one before the item rebuilds. */
export const PARAM_DEBOUNCE_MS = 100;

const CSS = `
.em-banner { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 70;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center;
  max-width: calc(100vw - 20px); box-sizing: border-box; padding: 7px 10px 7px 12px; border-radius: 10px;
  background: rgba(120, 53, 15, 0.94); color: #fff7ed; border: 1px solid rgba(251, 191, 36, 0.55);
  font: 500 12px/1.3 system-ui, -apple-system, Segoe UI, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,0.35); }
.em-banner .em-tag { font-weight: 800; letter-spacing: 0.08em; color: #fde68a; }
.em-banner .em-text { opacity: 0.95; }
.em-banner .em-warn { flex-basis: 100%; text-align: center; color: #fecaca; font-weight: 600; }
.em-btn { font: 600 12px/1 system-ui, -apple-system, Segoe UI, sans-serif; padding: 7px 10px; border-radius: 7px;
  border: 1px solid rgba(255,255,255,0.28); background: rgba(255,255,255,0.10); color: inherit; cursor: pointer; }
.em-btn:hover:not(:disabled) { background: rgba(255,255,255,0.2); }
.em-btn:disabled { opacity: 0.45; cursor: default; }
.em-btn.primary { background: #6366f1; border-color: #6366f1; color: #fff; }
.em-btn.primary:hover:not(:disabled) { background: #4f46e5; }
.em-btn.danger { border-color: rgba(248,113,113,0.6); color: #fca5a5; }
.em-frame { position: fixed; top: 64px; left: 12px; z-index: 60; width: 284px; box-sizing: border-box;
  max-height: calc(100vh - 84px); overflow-y: auto;
  padding: 10px 14px 12px; border-radius: 12px; background: rgba(10,10,20,0.92); color: #fff;
  border: 1px solid rgba(255,255,255,0.10); backdrop-filter: blur(16px);
  font: 400 12px/1.35 system-ui, -apple-system, Segoe UI, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,0.4); }
.em-frame .em-head { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }
.em-frame .em-kicker { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; opacity: 0.55; flex: 1; }
.em-frame h2 { margin: 0 0 4px; font-size: 15px; font-weight: 650; }
.em-frame .em-x { background: none; border: 0; color: inherit; opacity: 0.6; font-size: 18px; cursor: pointer; padding: 2px 6px; line-height: 1; }
.em-frame .em-target { font-size: 13px; font-weight: 600; }
.em-frame .em-sub { opacity: 0.6; margin: 2px 0 8px; }
.em-frame .em-row { margin: 6px 0 10px; }
.em-frame .em-row label { display: flex; justify-content: space-between; font-size: 11px; opacity: 0.75; margin-bottom: 5px; }
.em-frame .em-row.inline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.em-frame .em-row.inline label { margin: 0; }
.em-frame .em-row select, .em-frame .em-row input[type=text] { font: inherit; padding: 4px 6px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: inherit; max-width: 150px; }
.em-frame .em-row input[type=color] { width: 44px; height: 24px; padding: 0; border: 0; background: none; }
.em-frame .em-actions { display: flex; gap: 8px; margin-top: 10px; }
.em-frame .em-actions .em-btn { flex: 1; padding: 9px 8px; }
.em-frame .em-rot { display: flex; gap: 6px; margin: 6px 0 8px; }
.em-frame .em-rot .em-btn { flex: 1; padding: 7px 4px; }
.em-frame .em-msg { min-height: 1.3em; margin-top: 6px; font-size: 11px; opacity: 0.8; }
.em-frame .em-empty { opacity: 0.7; margin: 4px 0 2px; }
.em-frame .em-section { margin-top: 10px; border-top: 1px solid rgba(255,255,255,0.10); padding-top: 8px; }
.em-frame .em-section > summary { cursor: pointer; font-weight: 650; font-size: 12px; list-style: none; }
.em-frame .em-section > summary::before { content: '\\25B8  '; opacity: 0.6; }
.em-frame .em-section[open] > summary::before { content: '\\25BE  '; }
.em-frame.collapsed .em-body { display: none; }
:root[data-theme="light"] .em-frame { background: rgba(248,249,252,0.96); color: #1a1d29; border-color: rgba(0,0,0,0.10); }
:root[data-theme="light"] .em-frame .em-btn:not(.primary) { border-color: rgba(0,0,0,0.18); background: rgba(0,0,0,0.04); }
:root[data-theme="light"] .em-frame .em-btn.danger { color: #b91c1c; border-color: rgba(185,28,28,0.45); }
:root[data-theme="light"] .em-frame .em-row select, :root[data-theme="light"] .em-frame .em-row input[type=text] {
  border-color: rgba(0,0,0,0.2); background: rgba(0,0,0,0.04); }
@media (max-width: 600px) {
  .em-banner { top: auto; bottom: 8px; left: 8px; right: 8px; transform: none; max-width: none; padding: 6px 8px; gap: 6px; }
  .em-banner .em-text { display: none; }
  /* Above the banner, whatever its wrapped height (--em-banner-h, kept by a
     ResizeObserver), and short: the house stays visible above it. The head
     row collapses the panel to one line. */
  .em-frame { top: auto; bottom: calc(var(--em-banner-h, 48px) + 14px); left: 8px; right: 8px; width: auto;
    max-height: 30vh; padding: 8px 12px 10px; }
  .em-frame h2 { font-size: 14px; margin: 0; }
  .em-frame .em-row { margin: 4px 0 6px; }
}
`;

const KIND_LABEL = { room: 'Room', furniture: 'Furniture item', curtain: 'Curtain' };

let ctl = null;   // the one controller per page

/** Show the draft banner (a draft is rendered on this device). */
export function mountDraftBanner(ctx) { return controller(ctx).showBanner(); }

/** Enter edit mode: banner + panels. Returns the controller. */
export function enterEditMode(ctx) { const c = controller(ctx); c.enter(); return c; }

export function editController() { return ctl; }

function controller(ctx) {
  if (!ctl) ctl = createController(ctx);
  return ctl;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const fmt = (v, step) => {
  if (typeof v !== 'number') return String(v);
  const dp = step && step < 1 ? Math.min(3, String(step).split('.')[1] ? String(step).split('.')[1].length : 1) : 0;
  return v.toFixed(dp);
};

function createController(ctx) {
  const { home, houseId, storage } = ctx;
  const dir = ctx.houseDir || ('houses/' + houseId + '/');
  let active = false;
  let banner = null, frame = null, bannerObserver = null;
  let target = null;       // { kind, id, label } | { kind: 'none', label, reason }
  let lastRoomSeen = null; // the sidebar room last offered (selectRoom), so a repaint does not re-take the target
  let served = null;       // { geometryText, roomsText, hash } once fetched
  let unRender = null;
  let dragging = null;     // the frame slider being dragged (not overwritten by camera sync)
  let collapsed = false;   // the panel folded to its head row
  let draft = storage ? readDraft(storage, houseId) : null;

  // Furniture editing (B1).
  let work = null;         // the geometry document being edited (in memory until Save)
  let workRooms = null;    // rooms.json alongside it (a delete drops the item's bindings)
  let dirty = false;       // work differs from what is saved
  let furnReady = false;   // the scene is in its per-room edit build
  let furnStarting = null;
  let builders = null;     // type -> { DEFAULTS, CONTROLS?, defaultsFor? }
  let compiled = null;     // ctx.compile(work), refreshed on every kept edit
  let gesture = null;      // { pointerId, id, y, start, from, span? , moved } an item drag
  let claimed = false;     // this pointer's tap belongs to edit mode (no popover, no room tap)
  let pending = null;      // { id, timer|raf } the scheduled item rebuild
  let listenersOn = false;
  const perf = [];         // { op, ms, buildMs } per rebuild, for the perf report

  if (!document.getElementById('em-style')) {
    const st = el('style'); st.id = 'em-style'; st.textContent = CSS; document.head.appendChild(st);
  }

  async function loadServed() {
    if (served) return served;
    const get = async name => {
      const r = await fetch(dir + name, { cache: 'no-store' });
      if (!r.ok) { if (name === 'rooms.json' && r.status === 404) return null; throw new Error(name + ': HTTP ' + r.status); }
      return r.text();
    };
    const [g, rm] = await Promise.all([get('geometry.json'), get('rooms.json')]);
    served = { geometryText: g, roomsText: rm, hash: baseHashOf(g, rm) };
    return served;
  }

  // ---- Draft writes ------------------------------------------------------
  async function ensureDraft() {
    if (draft) return draft;
    const s = await loadServed();
    draft = makeDraft({ houseId, baseHash: s.hash, geometry: JSON.parse(s.geometryText), rooms: s.roomsText ? JSON.parse(s.roomsText) : null });
    return draft;
  }
  /** Replace the draft's geometry document and store it. Plan B's editors write through this. */
  async function saveGeometry(geometry) {
    const d = await ensureDraft();
    draft = writeDraft(storage, Object.assign({}, d, { geometry }));
    renderBanner();
    return draft;
  }
  /** Replace both draft documents (a delete also drops the item's rooms.json bindings). */
  async function saveDocs(geometry, rooms) {
    const d = await ensureDraft();
    draft = writeDraft(storage, Object.assign({}, d, { geometry, rooms }));
    renderBanner();
    return draft;
  }
  async function savedRooms() {
    if (draft) return draft.rooms;
    const s = await loadServed();
    return s.roomsText ? JSON.parse(s.roomsText) : null;
  }
  /** The geometry the page is showing as saved: the draft's, else the served file's. */
  async function savedGeometry() {
    if (draft) return draft.geometry;
    const s = await loadServed();
    return JSON.parse(s.geometryText);
  }

  // ---- Banner ------------------------------------------------------------
  function renderBanner() {
    // The boot-time escape (profile-draft.js mountDraftEscape) is only for a
    // page that never got this far.
    removeDraftEscape(document);
    if (!banner) {
      banner = el('div', 'em-banner'); banner.setAttribute('role', 'status'); banner.id = 'em-banner'; document.body.appendChild(banner);
      // The phone layout stacks the frame panel above the banner: publish its height.
      const b = banner;
      const publish = () => document.documentElement.style.setProperty('--em-banner-h', b.offsetHeight + 'px');
      if (typeof ResizeObserver === 'function') { bannerObserver = new ResizeObserver(publish); bannerObserver.observe(b); }
      requestAnimationFrame(publish);
    }
    banner.textContent = '';
    const tag = el('span', 'em-tag', active ? 'EDIT MODE' : 'DRAFT');
    const text = el('span', 'em-text', dirty ? 'unsaved changes'
      : draft ? (active ? 'DRAFT on this device, not live' : 'on this device, not live')
        : 'edits save as a draft on this device, not live');
    banner.append(tag, text);
    if (active) {
      const save = el('button', 'em-btn', 'Save'); save.id = 'em-save'; save.disabled = !dirty;
      save.title = 'Keep these changes in the draft on this device';
      save.addEventListener('click', () => doSave());
      banner.append(save);
    }
    const exp = el('button', 'em-btn', 'Export'); exp.id = 'em-export'; exp.disabled = !draft && !dirty;
    exp.title = 'Download geometry.json and rooms.json to apply to the server';
    exp.addEventListener('click', () => doExport());
    const dis = el('button', 'em-btn', 'Discard'); dis.id = 'em-discard'; dis.disabled = !draft && !ctx.draftBroken;
    dis.title = 'Delete the draft on this device and show the served profile';
    dis.addEventListener('click', () => doDiscard());
    const mode = el('button', 'em-btn primary', active ? 'Done' : 'Edit'); mode.id = 'em-mode';
    mode.addEventListener('click', () => (active ? exit() : enter()));
    banner.append(exp, dis, mode);
    if (ctx.draftBroken) banner.append(el('span', 'em-warn', 'This draft could not be rendered; the served profile is shown. Export or Discard it.'));
    if (draft && served && draft.baseHash && served.hash !== draft.baseHash) {
      const w = el('span', 'em-warn', 'The served profile changed since this draft began. Export would overwrite those changes; Discard to start from the new one.');
      w.id = 'em-stale';
      banner.append(w);
    }
    if (!draft && !active && !ctx.draftBroken) {
      if (bannerObserver) { bannerObserver.disconnect(); bannerObserver = null; }
      banner.remove(); banner = null;
    }
  }

  async function showBanner() {
    renderBanner();
    try { await loadServed(); renderBanner(); } catch (e) { console.warn('[edit-mode] could not read the served profile: ' + e.message); }
  }

  // ---- Panel -------------------------------------------------------------
  function message(text) { const m = frame && frame.querySelector('.em-msg'); if (m) m.textContent = text || ''; }

  function sliderRow(key, label, min, max, step, unit) {
    const row = el('div', 'em-row');
    const lab = el('label');
    const name = el('span', null, label), val = el('span', 'em-val'); val.id = 'em-val-' + key;
    lab.append(name, val);
    const inp = el('input', 'slider');
    Object.assign(inp, { type: 'range', min, max, step, id: 'em-' + key });
    inp.setAttribute('aria-label', label);
    inp.addEventListener('pointerdown', () => { dragging = key; });
    const stop = () => { if (dragging === key) dragging = null; };
    inp.addEventListener('pointerup', stop); inp.addEventListener('change', stop); inp.addEventListener('blur', stop);
    inp.addEventListener('input', () => applySlider(key, parseFloat(inp.value)));
    row.append(lab, inp);
    row.dataset.unit = unit;
    return row;
  }
  function applySlider(key, v) {
    const p = home.getPose();
    if (key === 'distance') p.r = sliderToDist(v);
    else if (key === 'height') p.tgt = [p.tgt[0], v / 100, p.tgt[2]];
    else if (key === 'fov') p.fov = v;
    home.flyTo(p, { ms: 0 });
    syncSliders(true);
  }
  function setRange(key, v, text) {
    const inp = frame && frame.querySelector('#em-' + key);
    if (!inp) return;
    if (dragging !== key) inp.value = String(v);
    inp.style.setProperty('--p', ((parseFloat(inp.value) - inp.min) / (inp.max - inp.min) * 100) + '%');
    const lab = frame.querySelector('#em-val-' + key);
    if (lab) lab.textContent = text;
  }
  function syncSliders() {
    if (!frame || !target || target.kind === 'none') return;
    const p = home.getPose();
    // Distance is LOGARITHMIC (edit-ops distToSlider): fine steps over 1-10 m.
    setRange('distance', distToSlider(p.r), p.r.toFixed(2) + ' m');
    setRange('height', Math.round(p.tgt[1] * 100), Math.round(p.tgt[1] * 100) + ' cm');
    setRange('fov', p.fov, Math.round(p.fov) + '°');
  }

  function panelHead(kicker) {
    const head = el('div', 'em-head');
    head.append(el('span', 'em-kicker', kicker));
    const fold = el('button', 'em-x', collapsed ? '▴' : '▾'); fold.id = 'em-collapse';
    fold.setAttribute('aria-label', collapsed ? 'Expand the panel' : 'Collapse the panel');
    fold.setAttribute('aria-expanded', String(!collapsed));
    fold.title = collapsed ? 'Expand' : 'Collapse';
    fold.addEventListener('click', () => { collapsed = !collapsed; renderFrame(); });
    head.append(fold);
    if (target) {
      const x = el('button', 'em-x', '×'); x.id = 'em-close';
      x.setAttribute('aria-label', target.kind === 'furniture' ? 'Deselect' : 'Stop framing'); x.title = x.getAttribute('aria-label');
      x.addEventListener('click', () => setTarget(null));
      head.append(x);
    }
    return head;
  }

  function frameSection(into) {
    const authored = !!(draft && findOwner(draft.geometry, target) && findOwner(draft.geometry, target).view) ||
      (typeof home.hasAuthoredView === 'function' && home.hasAuthoredView(target.kind, target.id));
    const sub = el('div', 'em-sub', KIND_LABEL[target.kind] + ' · ' + (authored ? 'authored view' : 'derived view'));
    sub.id = 'em-view-kind';
    into.append(sub, el('div', 'em-sub', 'Orbit and zoom as normal, then fine-tune:'));
    into.append(sliderRow('distance', 'Distance', 0, DIST_STEPS, 1, 'm'), sliderRow('height', 'Aim height', 0, 300, 1, 'cm'),
      sliderRow('fov', 'Lens (field of view)', 20, 90, 1, 'deg'));
    const acts = el('div', 'em-actions');
    const use = el('button', 'em-btn primary', 'Use this view'); use.id = 'em-use';
    use.addEventListener('click', () => useThisView());
    const reset = el('button', 'em-btn', 'Reset to derived'); reset.id = 'em-reset'; reset.disabled = !authored;
    reset.addEventListener('click', () => resetToDerived());
    acts.append(use, reset);
    into.append(acts);
  }

  function renderFrame() {
    if (!active) { if (frame) { frame.remove(); frame = null; } return; }
    if (!frame) { frame = el('div', 'em-frame'); frame.id = 'em-frame'; document.body.appendChild(frame); }
    frame.textContent = '';
    frame.classList.toggle('collapsed', collapsed);
    const isItem = target && target.kind === 'furniture';
    frame.append(panelHead(isItem ? 'EDIT ITEM' : 'EDIT LAYOUT'));
    const body = el('div', 'em-body');
    const msg = el('div', 'em-msg'); msg.setAttribute('aria-live', 'polite');
    if (!target) {
      frame.append(el('h2', null, 'Edit layout'));
      body.append(el('div', 'em-empty', ctx.draftBroken
        ? 'This draft could not be rendered, so the furniture cannot be edited until it is discarded. Pick a room to frame its view.'
        : 'Tap a piece of furniture to move or re-tune it. Pick a room (tap it, or choose it in the sidebar) or tap a device to frame the view the camera flies to.'));
      body.append(msg);
      frame.append(body);
      return;
    }
    if (isItem) {
      frame.append(el('h2', null, target.label || target.id));
      itemSection(body);
      const det = el('details', 'em-section'); det.id = 'em-frame-section';
      det.append(el('summary', null, 'Frame the view'));
      frameSection(det);
      body.append(det, msg);
      frame.append(body);
      syncSliders();
      return;
    }
    frame.append(el('h2', null, 'Frame the view'));
    body.append(el('div', 'em-target', target.label || target.id));
    if (target.kind === 'none') {
      body.append(el('div', 'em-sub', target.reason), msg);
      frame.append(body);
      return;
    }
    frameSection(body);
    body.append(msg);
    frame.append(body);
    syncSliders();
  }

  // ---- Furniture: the item panel -------------------------------------------
  function itemControls(raw) {
    const b = builders && builders.get(raw.type);
    if (!b) return { controls: [], values: Object.assign({}, raw.params || {}) };
    // A per-kind type (wall-clock, speaker, wall-sconce, plant): that kind's own DEFAULTS.
    const defaults = typeof b.defaultsFor === 'function' ? b.defaultsFor(raw.params || {}) : b.DEFAULTS;
    const controls = controlsFor(raw.type, defaults, b.CONTROLS).filter(c => c.kind !== 'unsupported');
    return { controls, values: Object.assign({}, defaults, raw.params || {}) };
  }

  function itemSection(into) {
    const raw = work ? findItem(work, target.id) : null;
    if (!furnReady || !raw) {
      into.append(el('div', 'em-sub', ctx.draftBroken ? 'Discard the broken draft to edit furniture.' : 'Getting the furniture ready to edit…'));
      return;
    }
    const wall = isWallAnchored(raw);
    into.append(el('div', 'em-sub', raw.type + ' · ' + (ctx.roomLabel ? ctx.roomLabel(raw.room) : raw.room)));
    into.append(el('div', 'em-sub', wall ? 'Drag it to slide it along its wall. Arrow keys nudge 1 cm (Shift: 10).'
      : 'Drag it on the floor to move it. Arrow keys nudge 1 cm (Shift: 10).'));
    if (!wall) {
      const rot = el('div', 'em-rot');
      [-90, -15, 15, 90].forEach(d => {
        const b = el('button', 'em-btn', (d > 0 ? '+' : '−') + Math.abs(d) + '°');
        b.id = 'em-rot-' + (d < 0 ? 'm' : 'p') + Math.abs(d);
        b.title = 'Turn ' + (d > 0 ? 'clockwise' : 'anticlockwise') + ' by ' + Math.abs(d) + '°';
        b.addEventListener('click', () => applyEdit(w => rotateItem(w, target.id, d), 'rotate', 0));
        rot.append(b);
      });
      into.append(rot);
    }
    const { controls, values } = itemControls(raw);
    const params = el('div'); params.id = 'em-params';
    controls.forEach(c => params.append(controlRow(raw, c, values)));
    if (!controls.length) params.append(el('div', 'em-sub', 'This type has no adjustable settings.'));
    into.append(params);
    const acts = el('div', 'em-actions');
    const del = el('button', 'em-btn danger', 'Delete'); del.id = 'em-delete';
    del.addEventListener('click', () => doDelete());
    acts.append(del);
    into.append(acts);
  }

  function controlRow(raw, c, values) {
    const id = 'em-p-' + c.key;
    const v = values[c.key];
    const onValue = val => {
      const cur = itemControls(findItem(work, raw.id) || raw);
      const writes = paramWrites(raw.type, cur.controls, cur.values, c.key, val);
      applyEdit(w => {
        let next = w;
        Object.keys(writes).forEach(k => {
          next = setParam(next, raw.id, k, writes[k], k === c.key && Array.isArray(c.mirror) ? { mirror: c.mirror } : null);
        });
        return next;
      }, 'param', PARAM_DEBOUNCE_MS);
      // A clamped value or a dependent re-clamp shows at once.
      Object.keys(writes).forEach(k => syncControl(k, writes[k]));
    };
    if (c.kind === 'range') {
      const row = el('div', 'em-row');
      const lab = el('label');
      const val = el('span', 'em-val'); val.id = id + '-val';
      lab.append(el('span', null, c.label), val);
      const inp = el('input', 'slider'); inp.id = id;
      const r = liveRange(raw.type, c, values);
      Object.assign(inp, { type: 'range', min: r.min, max: r.max, step: c.step });
      inp.value = String(typeof v === 'number' ? v : r.min);
      inp.dataset.unit = c.unit || '';
      inp.dataset.step = String(c.step);
      inp.setAttribute('aria-label', c.label);
      inp.addEventListener('input', () => onValue(parseFloat(inp.value)));
      row.append(lab, inp);
      paintRange(inp, val, parseFloat(inp.value));
      return row;
    }
    const row = el('div', 'em-row inline');
    const lab = el('label', null, c.label); lab.htmlFor = id;
    let inp;
    if (c.kind === 'color') {
      inp = el('input'); inp.type = 'color'; inp.value = /^#[0-9a-f]{6}$/i.test(String(v)) ? v : '#000000';
      inp.addEventListener('input', () => onValue(inp.value));
    } else if (c.kind === 'select') {
      inp = el('select');
      (c.options || []).forEach(o => {
        const opt = el('option', null, o !== null && typeof o === 'object' ? (o.label || String(o.value)) : String(o));
        opt.value = JSON.stringify(optionValue(o));
        if (optionValue(o) === v) opt.selected = true;
        inp.append(opt);
      });
      inp.addEventListener('change', () => onValue(JSON.parse(inp.value)));
    } else if (c.kind === 'toggle') {
      inp = el('input'); inp.type = 'checkbox'; inp.checked = !!v;
      inp.addEventListener('change', () => onValue(inp.checked));
    } else {
      inp = el('input'); inp.type = 'text'; inp.value = v == null ? '' : String(v);
      inp.addEventListener('change', () => onValue(inp.value));
    }
    inp.id = id;
    row.append(lab, inp);
    return row;
  }
  function paintRange(inp, valEl, v) {
    inp.style.setProperty('--p', ((v - inp.min) / ((inp.max - inp.min) || 1) * 100) + '%');
    if (valEl) valEl.textContent = fmt(v, parseFloat(inp.dataset.step)) + (inp.dataset.unit ? ' ' + inp.dataset.unit : '');
  }
  // Re-read one control from the live params (after a clamp), and re-narrow
  // every range whose live bounds depend on it.
  function syncControl(key, v) {
    if (!frame || !target || target.kind !== 'furniture') return;
    const raw = findItem(work, target.id);
    if (!raw) return;
    const { controls, values } = itemControls(raw);
    controls.forEach(c => {
      if (c.kind !== 'range') return;
      const inp = frame.querySelector('#em-p-' + c.key);
      if (!inp) return;
      const r = liveRange(raw.type, c, values);
      inp.min = String(r.min); inp.max = String(r.max);
      if (c.key === key && document.activeElement !== inp) inp.value = String(v);
      paintRange(inp, frame.querySelector('#em-p-' + c.key + '-val'), parseFloat(c.key === key ? v : inp.value));
    });
  }

  // ---- Furniture: edits -----------------------------------------------------
  /**
   * Apply one pure edit to `work`, then rebuild the item after `delay` ms
   * (0: on the next frame). An edit that fails the shape check or does not
   * compile is refused and `work` is left as it was.
   */
  function applyEdit(fn, op, delay) {
    if (!furnReady || !work || !target || target.kind !== 'furniture') return false;
    const id = target.id;
    let next;
    try { next = fn(work); } catch (e) { message(e.message); return false; }
    const problems = checkFurnitureItem(findItem(next, id));
    if (problems.length) { message('Not kept: ' + problems.join('; ')); return false; }
    work = next;
    if (!dirty) { dirty = true; renderBanner(); }
    scheduleRebuild(id, op, delay);
    return true;
  }
  function scheduleRebuild(id, op, delay) {
    if (pending) { if (pending.timer) clearTimeout(pending.timer); if (pending.raf) cancelAnimationFrame(pending.raf); }
    pending = { id, op };
    const run = () => { pending = null; rebuildItem(id, op); };
    if (delay > 0) pending.timer = setTimeout(run, delay);
    else pending.raf = requestAnimationFrame(run);
  }
  function flushRebuild() {
    if (!pending) return;
    const p = pending;
    if (p.timer) clearTimeout(p.timer); if (p.raf) cancelAnimationFrame(p.raf);
    pending = null;
    rebuildItem(p.id, p.op);
  }
  let lastGood = null;
  function rebuildItem(id, op) {
    const t0 = performance.now();
    let house;
    try { house = ctx.compile(work); } catch (e) { house = null; message('That change does not compile (' + e.message + '); undone.'); }
    const item = house && (house.furniture || []).find(f => f.id === id);
    if (!item) {
      if (house) message('That change makes the item invalid (the console says why); undone.');
      if (lastGood) work = lastGood;
      return null;
    }
    compiled = house;
    lastGood = work;
    const r = home.updateFurnitureItem(item);
    const ms = performance.now() - t0;
    perf.push({ op, ms: Math.round(ms * 10) / 10, buildMs: r && r.buildMs != null ? Math.round(r.buildMs * 10) / 10 : null });
    if (perf.length > 200) perf.shift();
    return ms;
  }

  async function startFurniture() {
    if (furnReady || furnStarting || ctx.draftBroken || typeof home.beginFurnitureEdit !== 'function') return furnStarting;
    furnStarting = (async () => {
      try {
        work = await savedGeometry();
        workRooms = await savedRooms();
        lastGood = work;
        compiled = ctx.compile(work);
        builders = await home.furnitureBuilders();
        const r = await home.beginFurnitureEdit();
        if (r) perf.push({ op: 'begin', ms: Math.round(r.ms * 10) / 10 });
        if (!active) { await home.endFurnitureEdit(); return; }
        furnReady = true;
        setListeners(true);
        if (target && target.kind === 'furniture') liftSelected(target.id);
        renderFrame();
      } catch (e) {
        console.warn('[edit-mode] furniture editing is unavailable: ' + e.message);
        message('Furniture editing is unavailable: ' + e.message);
      } finally { furnStarting = null; }
    })();
    return furnStarting;
  }
  function liftSelected(id) {
    if (!furnReady) return;
    const r = home.liftFurnitureItem(id || null);
    if (r && id) perf.push({ op: 'lift', ms: Math.round(r.ms * 10) / 10 });
    home.highlightFurniture(id || null);
  }

  async function doSave() {
    flushRebuild();
    if (!dirty || !work) return;
    try {
      await saveDocs(work, workRooms);
      dirty = false;
      renderBanner();
      message('Saved to the draft on this device.');
    } catch (e) { message('Could not save: ' + e.message); window.alert('Could not save the draft: ' + e.message); }
  }
  function doDelete() {
    if (!target || target.kind !== 'furniture' || !work) return;
    const id = target.id, label = target.label || id;
    if (!window.confirm('Delete "' + label + '"? It goes when you Save; Discard brings it back.')) return;
    flushRebuild();
    let next;
    try { next = deleteItem(work, id); } catch (e) { message(e.message); return; }
    work = next; lastGood = next;
    workRooms = dropItemBindings(workRooms, id);
    dirty = true;
    const r = home.removeFurnitureItem(id);
    if (r) perf.push({ op: 'delete', ms: Math.round(r.ms * 10) / 10 });
    target = null;
    home.highlightFurniture(null);
    renderBanner();
    renderFrame();
  }

  // ---- Furniture: pointer and keys -----------------------------------------
  function roomPoly(roomId) {
    const r = compiled && compiled.rooms ? compiled.rooms[roomId] : null;
    return r ? (r.poly || [[r.x1, r.y1], [r.x2, r.y1], [r.x2, r.y2], [r.x1, r.y2]]) : null;
  }
  // The compiled item's wall span, for a wall-anchored drag or nudge.
  function spanFor(raw) {
    const item = compiled && (compiled.furniture || []).find(f => f.id === raw.id);
    const wall = compiled && compiled.wallsById ? compiled.wallsById[raw.wall] : null;
    if (!item || !wall) return null;
    const rad = item.rotationDeg * Math.PI / 180;
    const front = [-Math.sin(rad), Math.cos(rad)];
    const horiz = Math.abs(wall.y1 - wall.y2) < Math.abs(wall.x1 - wall.x2);
    const perp = horiz ? item.y : item.x;
    const inDir = Math.sign(horiz ? front[1] : front[0]) || 1;
    return wallSpan(wall, roomPoly(raw.room), perp, inDir);
  }
  function moveTo(raw, anchor) {
    return applyEdit(w => moveItem(w, raw.id, anchor), 'move', 0);
  }
  const inScene = e => ctx.container && ctx.container.contains(e.target);
  function onPointerDown(e) {
    claimed = false;
    if (!active || !furnReady || !inScene(e)) return;
    if (gesture) { gesture = null; return; }      // a second finger: let the pinch through
    if (e.button !== 0) return;
    const hit = home.furnitureEditPick(e.clientX, e.clientY);
    if (!hit) return;                              // empty space: orbit as normal
    e.stopPropagation();                           // the scene never sees it: no orbit
    e.preventDefault();
    claimed = true;
    const raw = work && findItem(work, hit.id);
    if (!raw) return;
    if (!target || target.kind !== 'furniture' || target.id !== hit.id) setTarget(ownerFor(hit.id));
    const start = home.screenToPlan(e.clientX, e.clientY, hit.point[1]);
    if (!start) return;
    gesture = { pointerId: e.pointerId, id: hit.id, y: hit.point[1], start, moved: false,
      from: isWallAnchored(raw) ? raw.centre : raw.at.slice(), span: isWallAnchored(raw) ? spanFor(raw) : null };
  }
  function onPointerMove(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    e.stopPropagation();
    const p = home.screenToPlan(e.clientX, e.clientY, gesture.y);
    if (!p) return;
    const raw = findItem(work, gesture.id);
    if (!raw) return;
    const dx = p[0] - gesture.start[0], dy = p[1] - gesture.start[1];
    if (!gesture.moved && Math.hypot(dx, dy) < 1) return;
    gesture.moved = true;
    if (gesture.span) {
      const c = clamp(snapCm(gesture.from + (gesture.span.axis === 'x' ? dx : dy)), Math.ceil(gesture.span.lo), Math.floor(gesture.span.hi));
      if (c !== raw.centre) moveTo(raw, { centre: c });
      return;
    }
    const want = [snapCm(gesture.from[0] + dx), snapCm(gesture.from[1] + dy)];
    const at = confineToPoly(roomPoly(raw.room), raw.at, want).map(snapCm);
    if (at[0] !== raw.at[0] || at[1] !== raw.at[1]) moveTo(raw, { at });
  }
  function onPointerEnd(e) {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    gesture = null;
    flushRebuild();
  }
  // The click that ends a claimed pointer is edit mode's: no popover (the
  // page's tap-popovers asks tapClaimed()), no room tap, no click-away.
  function onClick(e) {
    if (!claimed) return;
    claimed = false;
    if (inScene(e)) e.stopPropagation();
  }
  function onKey(e) {
    if (!active || !furnReady || !target || target.kind !== 'furniture') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'Escape') { setTarget(null); return; }
    const d = nudgeDir(e.key, home.getPose().th);
    if (!d) return;
    e.preventDefault();
    const raw = findItem(work, target.id);
    if (!raw) return;
    const step = e.shiftKey ? 10 : 1;
    if (isWallAnchored(raw)) {
      const span = spanFor(raw);
      if (!span) return;
      const along = span.axis === 'x' ? d[0] : d[1];
      if (!along) return;                          // across the wall: nothing to do
      moveTo(raw, { centre: clamp(raw.centre + along * step, Math.ceil(span.lo), Math.floor(span.hi)) });
      return;
    }
    const want = [raw.at[0] + d[0] * step, raw.at[1] + d[1] * step];
    const at = confineToPoly(roomPoly(raw.room), raw.at, want);
    if (at[0] !== raw.at[0] || at[1] !== raw.at[1]) moveTo(raw, { at });
  }
  function setListeners(on) {
    if (on === listenersOn) return;
    listenersOn = on;
    const f = on ? 'addEventListener' : 'removeEventListener';
    window[f]('pointerdown', onPointerDown, true);
    window[f]('pointermove', onPointerMove, true);
    window[f]('pointerup', onPointerEnd, true);
    window[f]('pointercancel', onPointerEnd, true);
    window[f]('click', onClick, true);
    window[f]('keydown', onKey);
  }

  // ---- Targets ---------------------------------------------------------------
  function ownerFor(id) {
    const raw = work && findItem(work, id);
    return { kind: 'furniture', id, label: (raw && (raw.label || raw.name)) || id };
  }
  function setTarget(next) {
    const wasItem = target && target.kind === 'furniture' ? target.id : null;
    const isItem = next && next.kind === 'furniture' ? next.id : null;
    if (wasItem !== isItem) { flushRebuild(); liftSelected(isItem); }
    target = next;
    renderFrame();
  }

  async function useThisView() {
    if (!target || target.kind === 'none') return;
    if (ctx.draftBroken) { message('This draft could not be rendered. Discard it (in the banner) before saving a view.'); return; }
    try {
      const d = await ensureDraft();
      const view = poseToFocusView(home.getPose(), d.geometry.coordinateTransform);
      await saveGeometry(setOwnerView(d.geometry, target, view));
      // The in-memory furniture edits carry the view too, so a later Save keeps it.
      if (work && findOwner(work, target)) { work = setOwnerView(work, target, view); lastGood = work; }
      home.setAuthoredView(target.kind, target.id, view);
      renderFrame();
      message('Saved to the draft. This view now applies when it is selected.');
    } catch (e) { message('Could not save: ' + e.message); }
  }
  async function resetToDerived() {
    if (!target || target.kind === 'none') return;
    if (ctx.draftBroken) { message('This draft could not be rendered. Discard it (in the banner) first.'); return; }
    try {
      const d = await ensureDraft();
      await saveGeometry(clearOwnerView(d.geometry, target));
      if (work && findOwner(work, target)) { work = clearOwnerView(work, target); lastGood = work; }
      home.setAuthoredView(target.kind, target.id, null);
      // The derived view is framed for the CURRENT lens: go back to the
      // default one first, so an authored lens does not outlive its view.
      const p = home.getPose(); p.fov = DEFAULT_FOV; home.flyTo(p, { ms: 0 });
      renderFrame();
      const pose = ctx.viewFor ? ctx.viewFor(target) : null;
      if (pose) pose.fov = DEFAULT_FOV;
      if (pose && ctx.flyTo) ctx.flyTo(pose);
      message('Back to the derived view (saved to the draft).');
    } catch (e) { message('Could not reset: ' + e.message); }
  }

  // ---- Export / Discard --------------------------------------------------
  async function exportTexts() {
    const s = await loadServed();
    const d = draft || { geometry: JSON.parse(s.geometryText), rooms: s.roomsText ? JSON.parse(s.roomsText) : null };
    return exportProfile(s, d);
  }
  function download(name, text) {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function doExport() {
    try {
      // Export is what is SAVED: unsaved furniture edits are saved first.
      if (dirty) await doSave();
      const t = await exportTexts();
      download('geometry.json', t.geometry);
      if (t.rooms != null) setTimeout(() => download('rooms.json', t.rooms), 400);
    } catch (e) { window.alert('Export failed: ' + e.message); }
  }
  function doDiscard() {
    if (!window.confirm('Discard the draft on this device? The served profile will be shown again.')) return;
    if (storage) clearDraft(storage, houseId);
    draft = null;
    dirty = false;
    window.location.reload();
  }

  // ---- Mode ----------------------------------------------------------------
  function enter() {
    if (active) return;
    active = true;
    lastRoomSeen = null;
    renderBanner();
    renderFrame();
    if (typeof home.onRender === 'function' && !unRender) unRender = home.onRender(() => { if (active) syncSliders(); });
    loadServed().then(renderBanner, e => console.warn('[edit-mode] could not read the served profile: ' + e.message));
    // The room open in the sidebar is the first thing framed, whichever
    // button entered edit mode (Settings or the banner's Edit).
    const room = ctx.currentRoom ? ctx.currentRoom() : null;
    if (room) selectRoom(room);
    startFurniture();
    if (ctx.onModeChange) ctx.onModeChange(true);
  }
  async function exit() {
    if (!active) return;
    flushRebuild();
    if (dirty) {
      if (window.confirm('Save your furniture changes to the draft on this device?\n\nCancel leaves them out.')) await doSave();
    }
    active = false;
    gesture = null;
    setListeners(false);
    if (target && target.kind === 'furniture') home.highlightFurniture(null);
    target = null;
    if (unRender) { unRender(); unRender = null; }
    if (furnStarting) await furnStarting;
    if (furnReady) {
      furnReady = false;
      // Unsaved edits left out: rebuild from what is saved.
      const items = dirty ? (ctx.compile(await savedGeometry()).furniture || []) : null;
      dirty = false;
      work = null; workRooms = null; compiled = null; lastGood = null;
      const t0 = performance.now();
      home.endFurnitureEdit(items || undefined).then(() => perf.push({ op: 'end', ms: Math.round((performance.now() - t0) * 10) / 10 }));
    }
    renderFrame();
    renderBanner();
    if (ctx.onModeChange) ctx.onModeChange(false);
  }
  function selectRoom(id, force) {
    if (!active || !id) return;
    // The page calls this on every sidebar repaint while a room is open: only
    // a NEW room (or a tap on one: `force`) takes the target, so a repaint
    // never drops a selected item or device.
    if (id === lastRoomSeen && !force) return;
    lastRoomSeen = id;
    if (target && target.kind === 'room' && target.id === id) return;
    setTarget({ kind: 'room', id, label: ctx.roomLabel ? ctx.roomLabel(id) : id });
  }
  function selectDevice(device, point) {
    if (!active || !device) return;
    const owner = ctx.resolveOwner ? ctx.resolveOwner(Object.assign({}, device, { focusPoint: point || null })) : null;
    setTarget(owner || { kind: 'none', label: device.label || device.id,
      reason: 'This device has no profile entry that can hold a view (a light frames from its fixture). Frame its room instead.' });
  }

  const api = {
    enter, exit, showBanner, selectRoom, selectDevice, saveGeometry,
    isActive: () => active,
    target: () => target,
    draft: () => draft,
    work: () => work,
    dirty: () => dirty,
    furnitureReady: () => furnReady,
    ready: () => furnStarting || Promise.resolve(),
    tapClaimed: () => claimed,
    perf: () => perf.slice(),
    selectItem: id => setTarget(id ? ownerFor(id) : null),
    save: doSave,
    exportTexts,
  };
  if (ctx.debug) window.__home3dEdit = api;
  return api;
}
